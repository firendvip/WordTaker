/**
 * Main-process authentication credential store.
 *
 * Refresh/legacy credentials are encrypted with Electron safeStorage (macOS
 * Keychain, Windows DPAPI, Linux libsecret). OIDC access tokens stay in memory.
 * Linux basic_text and unavailable encryption fail closed: the current process
 * may keep credentials in memory, but no plaintext is written.
 *
 * The legacy AIM session and the OIDC passport session use separate slots so a
 * rollout failure cannot destroy existing business access. The old plaintext
 * backend-token.json is removed only after an encrypted write is decrypted and
 * schema-verified successfully.
 */

const fs = require("fs");
const path = require("path");
const { OIDC_ISSUER } = require("./passportOidc");

const LEGACY_FILE_NAME = "backend-token.json";
const SECURE_FILE_NAME = "auth-credentials.safe";
const STORE_VERSION = 2;
const MAX_FILE_BYTES = 128 * 1024;
const ACCESS_EXPIRY_SKEW_MS = 30 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFRESH_TOKEN = /^rt1\.[A-Za-z0-9_-]{43}$/;
const SENSITIVE_STRING_MAX = 32 * 1024;

let temporarySequence = 0;

function emptyPayload() {
  return { version: STORE_VERSION, legacy: null, passport: null };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsTokenDelimiter(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}

function validSecret(value, maximum = SENSITIVE_STRING_MAX) {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= maximum &&
    !containsTokenDelimiter(value)
  );
}

function safeSerializable(value, depth = 0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length <= 4096 ? value : value.slice(0, 4096);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => safeSerializable(item, depth + 1));
  if (!isPlainObject(value)) return null;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 128)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    result[key] = safeSerializable(item, depth + 1);
  }
  return result;
}

function normalizeAccount(value) {
  if (value === null || value === undefined) return null;
  const account = safeSerializable(value);
  return isPlainObject(account) ? account : null;
}

function canonicalAimUserId(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== "string" || !/^[1-9][0-9]{0,31}$/.test(value)) return null;
  return value;
}

function normalizeAimMapping(value, passportUserId) {
  if (!isPlainObject(value)) return null;
  const aimUserId = canonicalAimUserId(value.aim_user_id);
  if (
    value.issuer !== OIDC_ISSUER ||
    typeof value.passport_user_id !== "string" ||
    value.passport_user_id.toLowerCase() !== passportUserId ||
    !aimUserId
  ) {
    return null;
  }
  return {
    issuer: OIDC_ISSUER,
    passport_user_id: passportUserId,
    aim_user_id: aimUserId,
  };
}

function normalizeLegacy(value) {
  if (!isPlainObject(value) || !validSecret(value.accessToken)) return null;
  return {
    accessToken: value.accessToken,
    account: normalizeAccount(value.account),
    savedAt:
      typeof value.savedAt === "string" && value.savedAt.length <= 64
        ? value.savedAt
        : new Date().toISOString(),
  };
}

function normalizePassport(value) {
  if (
    !isPlainObject(value) ||
    !validSecret(value.refreshToken, 1024) ||
    !REFRESH_TOKEN.test(value.refreshToken) ||
    value.issuer !== OIDC_ISSUER ||
    typeof value.scope !== "string" ||
    value.scope.length > 512 ||
    !UUID.test(value.centralSessionId || "") ||
    !Number.isSafeInteger(value.profileCheckedAt) ||
    value.profileCheckedAt < 0
  ) {
    return null;
  }
  const account = normalizeAccount(value.account);
  if (!account || !UUID.test(account.passport_user_id || "")) return null;
  const passportUserId = account.passport_user_id.toLowerCase();
  return {
    refreshToken: value.refreshToken,
    issuer: OIDC_ISSUER,
    scope: value.scope,
    centralSessionId: value.centralSessionId.toLowerCase(),
    profileCheckedAt: value.profileCheckedAt,
    refreshOutcomeUnknown: value.refreshOutcomeUnknown === true,
    account: {
      ...account,
      passport_user_id: passportUserId,
    },
    aimMapping: normalizeAimMapping(value.aimMapping, passportUserId),
    savedAt:
      typeof value.savedAt === "string" && value.savedAt.length <= 64
        ? value.savedAt
        : new Date().toISOString(),
  };
}

function normalizePayload(value) {
  if (!isPlainObject(value) || value.version !== STORE_VERSION) return null;
  const legacy = value.legacy === null ? null : normalizeLegacy(value.legacy);
  const passport = value.passport === null ? null : normalizePassport(value.passport);
  if ((value.legacy !== null && !legacy) || (value.passport !== null && !passport)) return null;
  return { version: STORE_VERSION, legacy, passport };
}

function createTokenStore({
  dataDirectory,
  safeStorage,
  platform = process.platform,
  fsModule = fs,
  pathModule = path,
  now = Date.now,
} = {}) {
  if (typeof dataDirectory !== "string" || !pathModule.isAbsolute(dataDirectory)) {
    throw new Error("tokenStore dataDirectory 必须是绝对路径");
  }

  const securePath = pathModule.join(dataDirectory, SECURE_FILE_NAME);
  const legacyPath = pathModule.join(dataDirectory, LEGACY_FILE_NAME);
  let cache;
  let storageStatus;
  let passportProbePending = true;
  let passportMappingDenied = false;
  let passportMappingVerifiedThisProcess = false;
  let passportRolloutEnabled = true;
  const providerGenerations = { passport: 0, legacy: 0 };
  // Native contract: access/ID tokens never survive this process. Only the
  // rotating refresh credential is persisted through Electron safeStorage.
  let memoryPassportTokens = null;

  function encryptionStatus() {
    if (storageStatus) return storageStatus;
    try {
      if (!safeStorage || safeStorage.isEncryptionAvailable() !== true) {
        storageStatus = { persistent: false, reason: "secure-storage-unavailable" };
        return storageStatus;
      }
      if (
        platform === "linux" &&
        typeof safeStorage.getSelectedStorageBackend === "function" &&
        safeStorage.getSelectedStorageBackend() === "basic_text"
      ) {
        storageStatus = { persistent: false, reason: "secure-storage-unavailable" };
        return storageStatus;
      }
      storageStatus = { persistent: true, reason: null };
      return storageStatus;
    } catch {
      storageStatus = { persistent: false, reason: "secure-storage-unavailable" };
      return storageStatus;
    }
  }

  function readSecureFile() {
    if (!encryptionStatus().persistent || !fsModule.existsSync(securePath)) return null;
    try {
      const stats = fsModule.statSync(securePath);
      if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_FILE_BYTES) return null;
      const encrypted = fsModule.readFileSync(securePath);
      const plaintext = safeStorage.decryptString(encrypted);
      if (typeof plaintext !== "string" || Buffer.byteLength(plaintext) > MAX_FILE_BYTES) return null;
      return normalizePayload(JSON.parse(plaintext));
    } catch {
      return null;
    }
  }

  function readLegacyFile() {
    if (!fsModule.existsSync(legacyPath)) return null;
    try {
      const stats = fsModule.statSync(legacyPath);
      if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_FILE_BYTES) return null;
      return normalizeLegacy(JSON.parse(fsModule.readFileSync(legacyPath, "utf8")));
    } catch {
      return null;
    }
  }

  function persist(payload = cache) {
    if (!encryptionStatus().persistent) return false;
    let temporaryPath = null;
    try {
      fsModule.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
      const plaintext = JSON.stringify(payload);
      if (Buffer.byteLength(plaintext) > MAX_FILE_BYTES) return false;
      const encrypted = safeStorage.encryptString(plaintext);
      if (!Buffer.isBuffer(encrypted) || encrypted.length <= 0 || encrypted.length > MAX_FILE_BYTES) {
        return false;
      }

      // Verify the exact encrypted bytes before replacing the previous store.
      const verified = normalizePayload(JSON.parse(safeStorage.decryptString(encrypted)));
      if (!verified) return false;

      temporaryPath = pathModule.join(
        dataDirectory,
        `.${SECURE_FILE_NAME}.tmp-${process.pid}-${++temporarySequence}`,
      );
      fsModule.writeFileSync(temporaryPath, encrypted, {
        flag: "wx",
        mode: 0o600,
      });
      fsModule.renameSync(temporaryPath, securePath);
      temporaryPath = null;
      try {
        fsModule.chmodSync(securePath, 0o600);
      } catch {
        // The containing userData directory remains user-scoped; a chmod failure
        // does not justify falling back to plaintext.
      }
      return true;
    } catch {
      return false;
    } finally {
      if (temporaryPath) {
        try {
          fsModule.unlinkSync(temporaryPath);
        } catch {
          // Best-effort cleanup of a ciphertext-only temporary file.
        }
      }
    }
  }

  function load() {
    if (cache !== undefined) return cache;
    cache = readSecureFile() || emptyPayload();
    const legacy = readLegacyFile();
    if (legacy && !cache.legacy) {
      cache = { ...cache, legacy };
    }
    if (legacy && encryptionStatus().persistent && persist()) {
      try {
        // Re-read/decrypt the final file before removing the plaintext source.
        const finalPayload = readSecureFile();
        if (finalPayload && JSON.stringify(finalPayload) === JSON.stringify(cache)) {
          fsModule.unlinkSync(legacyPath);
        }
      } catch {
        // Preserve the legacy source whenever migration verification or removal fails.
      }
    }
    return cache;
  }

  function update(nextPayload) {
    if (!encryptionStatus().persistent) {
      cache = nextPayload;
      return false;
    }
    if (!persist(nextPayload)) return false;
    cache = nextPayload;
    return true;
  }

  function failClosedUpdate(nextPayload) {
    if (update(nextPayload)) return true;
    // If a security-sensitive rewrite fails, remove the encrypted container so
    // an accepted mapping or revoked refresh token cannot revive on restart.
    if (!removeFile(securePath)) return false;
    cache = nextPayload;
    return true;
  }

  function setLegacy(data) {
    const legacy = normalizeLegacy({
      ...data,
      savedAt: new Date(Number(now())).toISOString(),
    });
    if (!legacy) throw new Error("tokenStore.setLegacy 需要有效 accessToken");
    const current = load();
    const mappedAimUserId = current.passport?.aimMapping?.aim_user_id || null;
    const legacyUserId = canonicalAimUserId(legacy.account?.userId);
    const mappingStillValid = !mappedAimUserId || mappedAimUserId === legacyUserId;
    if (!mappingStillValid) {
      passportProbePending = true;
      passportMappingDenied = true;
      passportMappingVerifiedThisProcess = false;
    }
    const stored = update({
      ...current,
      legacy,
      // An established (issuer, sub) -> AIM owner mapping is immutable. A
      // different legacy login denies Passport writes but cannot rewrite the
      // canonical owner evidence.
      passport: current.passport,
    });
    if (stored || !encryptionStatus().persistent) providerGenerations.legacy += 1;
    return stored;
  }

  function setPassport(data) {
    const current = load();
    if (
      !isPlainObject(data) ||
      !validSecret(data.accessToken) ||
      !Number.isSafeInteger(data.expiresAt) ||
      data.expiresAt <= Number(now())
    ) {
      throw new Error("tokenStore.setPassport 需要有效的内存 access token");
    }
    const requestedPassportUserId = normalizeAccount(data.account)?.passport_user_id?.toLowerCase();
    const existingMapping = current.passport?.aimMapping || null;
    const samePassportIdentity =
      UUID.test(requestedPassportUserId || "") &&
      current.passport?.issuer === OIDC_ISSUER &&
      current.passport.account.passport_user_id === requestedPassportUserId;
    const legacyUserId = canonicalAimUserId(current.legacy?.account?.userId);
    const mappingStillValid =
      samePassportIdentity &&
      existingMapping &&
      (!current.legacy || existingMapping.aim_user_id === legacyUserId);
    const mappingBelongsToIdentity =
      samePassportIdentity &&
      existingMapping?.issuer === OIDC_ISSUER &&
      existingMapping.passport_user_id === requestedPassportUserId;
    const passport = normalizePassport({
      ...data,
      issuer: OIDC_ISSUER,
      aimMapping: mappingBelongsToIdentity ? existingMapping : null,
      savedAt: new Date(Number(now())).toISOString(),
    });
    if (!passport) throw new Error("tokenStore.setPassport 需要有效 OIDC 会话");
    const nextMemoryPassportTokens = {
      accessToken: data.accessToken,
      expiresAt: data.expiresAt,
    };
    if (data.aimProbeRequired === true || !samePassportIdentity) {
      passportProbePending = true;
    } else if (mappingStillValid) {
      passportProbePending = !passportMappingVerifiedThisProcess;
    }
    const stored = update({ ...current, passport });
    if (stored || !encryptionStatus().persistent) {
      memoryPassportTokens = nextMemoryPassportTokens;
      providerGenerations.passport += 1;
      if (!samePassportIdentity) {
        passportMappingDenied = false;
        passportMappingVerifiedThisProcess = false;
      }
    }
    return stored;
  }

  function setPassportRefreshToken(expectedRefreshToken, nextRefreshToken) {
    if (
      !REFRESH_TOKEN.test(expectedRefreshToken || "") ||
      !REFRESH_TOKEN.test(nextRefreshToken || "") ||
      expectedRefreshToken === nextRefreshToken
    ) {
      return false;
    }
    const current = load();
    if (!current.passport || current.passport.refreshToken !== expectedRefreshToken) return false;
    const stored = update({
      ...current,
      passport: {
        ...current.passport,
        refreshToken: nextRefreshToken,
        refreshOutcomeUnknown: false,
        savedAt: new Date(Number(now())).toISOString(),
      },
    });
    if (stored) providerGenerations.passport += 1;
    return stored;
  }

  function quarantinePassportRefreshToken(expectedRefreshToken) {
    if (!REFRESH_TOKEN.test(expectedRefreshToken || "")) return false;
    const current = load();
    if (!current.passport || current.passport.refreshToken !== expectedRefreshToken) return false;
    const stored = failClosedUpdate({
      ...current,
      passport: {
        ...current.passport,
        refreshOutcomeUnknown: true,
        savedAt: new Date(Number(now())).toISOString(),
      },
    });
    if (stored) providerGenerations.passport += 1;
    return stored;
  }

  function getLegacy() {
    return load().legacy;
  }

  function getPassport() {
    const passport = load().passport;
    if (!passport) return null;
    return {
      ...passport,
      accessToken: memoryPassportTokens?.accessToken || null,
      expiresAt: memoryPassportTokens?.expiresAt || 0,
    };
  }

  function getProviderGeneration(provider) {
    return Object.prototype.hasOwnProperty.call(providerGenerations, provider)
      ? providerGenerations[provider]
      : null;
  }

  function validPassportAccess(passport) {
    return passport && passport.expiresAt > Number(now()) + ACCESS_EXPIRY_SKEW_MS;
  }

  function acceptedAimMapping(passport, legacy) {
    if (passportMappingDenied || !passportMappingVerifiedThisProcess) return false;
    const mapping = passport?.aimMapping;
    if (
      !mapping ||
      mapping.issuer !== passport.issuer ||
      mapping.passport_user_id !== passport.account.passport_user_id
    ) {
      return false;
    }
    if (!legacy) return true;
    const legacyUserId = canonicalAimUserId(legacy.account?.userId);
    return Boolean(legacyUserId && legacyUserId === mapping.aim_user_id);
  }

  function getAccessTokenCandidates({ method = "GET", purpose = null } = {}) {
    const current = load();
    if (!passportRolloutEnabled) {
      return current.legacy
        ? [{ provider: "legacy", accessToken: current.legacy.accessToken }]
        : [];
    }
    const runtimePassport = getPassport();
    const passport = validPassportAccess(runtimePassport) ? runtimePassport : null;
    const legacy = current.legacy;
    const mappingAccepted = acceptedAimMapping(current.passport, legacy);
    const safeToRetry = ["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase());
    if (!safeToRetry) {
      if (passport && mappingAccepted) {
        return [{ provider: "passport", accessToken: passport.accessToken }];
      }
      if (legacy) return [{ provider: "legacy", accessToken: legacy.accessToken }];
      return [];
    }
    const mappingProbe = purpose === "aim-mapping" && passportProbePending;
    if (passport && (mappingAccepted || mappingProbe)) {
      return [
        { provider: "passport", accessToken: passport.accessToken },
        ...(legacy ? [{ provider: "legacy", accessToken: legacy.accessToken }] : []),
      ];
    }
    return legacy ? [{ provider: "legacy", accessToken: legacy.accessToken }] : [];
  }

  function markPassportAimApiAccepted(accepted, aimUserId) {
    const current = load();
    passportProbePending = false;
    if (!current.passport) return accepted !== true;
    if (accepted !== true) {
      passportMappingDenied = true;
      passportMappingVerifiedThisProcess = false;
      return true;
    }
    const canonicalUserId = canonicalAimUserId(aimUserId);
    const legacyUserId = canonicalAimUserId(current.legacy?.account?.userId);
    const establishedMapping = current.passport.aimMapping;
    if (
      !canonicalUserId ||
      (current.legacy && canonicalUserId !== legacyUserId) ||
      (establishedMapping && establishedMapping.aim_user_id !== canonicalUserId)
    ) {
      passportMappingDenied = true;
      passportMappingVerifiedThisProcess = false;
      return false;
    }
    const aimMapping = {
      issuer: current.passport.issuer,
      passport_user_id: current.passport.account.passport_user_id,
      aim_user_id: canonicalUserId,
    };
    if (establishedMapping) {
      passportMappingDenied = false;
      passportMappingVerifiedThisProcess = true;
      return true;
    }
    const stored = update({
      ...current,
      passport: { ...current.passport, aimMapping },
    });
    if (stored) {
      passportMappingDenied = false;
      passportMappingVerifiedThisProcess = true;
    }
    return stored;
  }

  function get() {
    const state = getAuthState();
    if (!state.loggedIn) return null;
    const candidates = getAccessTokenCandidates();
    return {
      accessToken: candidates[0]?.accessToken || null,
      account: state.account,
      provider: state.provider,
    };
  }

  function getAccessToken() {
    return getAccessTokenCandidates()[0]?.accessToken || null;
  }

  function getAuthState() {
    const current = load();
    if (!passportRolloutEnabled) {
      return current.legacy
        ? { loggedIn: true, provider: "legacy", account: current.legacy.account }
        : { loggedIn: false, provider: null, account: null };
    }
    const passportCanRepresentLogin =
      !current.passport?.refreshOutcomeUnknown || validPassportAccess(getPassport());
    if (
      current.passport &&
      passportCanRepresentLogin &&
      (acceptedAimMapping(current.passport, current.legacy) ||
        passportProbePending ||
        (!passportMappingDenied && !current.legacy))
    ) {
      return {
        loggedIn: true,
        provider: "passport",
        identity: {
          issuer: current.passport.issuer,
          passport_user_id: current.passport.account.passport_user_id,
        },
        account: current.passport.account,
      };
    }
    if (current.legacy) {
      return { loggedIn: true, provider: "legacy", account: current.legacy.account };
    }
    return { loggedIn: false, provider: null, account: null };
  }

  function removeFile(filePath) {
    try {
      if (fsModule.existsSync(filePath)) fsModule.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  function clearPassport() {
    const current = load();
    passportProbePending = false;
    passportMappingDenied = true;
    passportMappingVerifiedThisProcess = false;
    memoryPassportTokens = null;
    if (!current.passport) return true;
    const cleared = failClosedUpdate({ ...current, passport: null });
    if (cleared) providerGenerations.passport += 1;
    return cleared;
  }

  function clearProvider(provider) {
    if (provider === "passport") return clearPassport();
    if (provider === "legacy") {
      const current = load();
      // Remove the migration source first. Otherwise a successfully cleared
      // encrypted slot could be repopulated from backend-token.json on restart.
      if (!removeFile(legacyPath)) return false;
      if (!current.legacy) return true;
      const cleared = failClosedUpdate({ ...current, legacy: null });
      if (cleared) providerGenerations.legacy += 1;
      return cleared;
    }
    return false;
  }

  function clear() {
    cache = emptyPayload();
    passportProbePending = false;
    passportMappingDenied = true;
    passportMappingVerifiedThisProcess = false;
    memoryPassportTokens = null;
    providerGenerations.passport += 1;
    providerGenerations.legacy += 1;
    const secureRemoved = removeFile(securePath);
    const legacyRemoved = removeFile(legacyPath);
    return secureRemoved && legacyRemoved;
  }

  function setPassportRolloutEnabled(enabled) {
    passportRolloutEnabled = enabled === true;
  }

  return Object.freeze({
    clear,
    clearPassport,
    clearProvider,
    get,
    getAccessToken,
    getAccessTokenCandidates,
    getAuthState,
    getLegacy,
    getPassport,
    getProviderGeneration,
    getSecurityStatus: () => ({ ...encryptionStatus() }),
    markPassportAimApiAccepted,
    quarantinePassportRefreshToken,
    set: setLegacy,
    setLegacy,
    setPassport,
    setPassportRefreshToken,
    setPassportRolloutEnabled,
  });
}

let defaultStore = null;
let defaultPassportRolloutEnabled = false;

function singleton() {
  if (!defaultStore) {
    const { app, safeStorage } = require("electron");
    defaultStore = createTokenStore({
      dataDirectory: app.getPath("userData"),
      safeStorage,
      platform: process.platform,
    });
    defaultStore.setPassportRolloutEnabled(defaultPassportRolloutEnabled);
  }
  return defaultStore;
}

module.exports = {
  LEGACY_FILE_NAME,
  SECURE_FILE_NAME,
  clear: () => singleton().clear(),
  clearPassport: () => singleton().clearPassport(),
  clearProvider: (provider) => singleton().clearProvider(provider),
  createTokenStore,
  get: () => singleton().get(),
  getAccessToken: () => singleton().getAccessToken(),
  getAccessTokenCandidates: (options) => singleton().getAccessTokenCandidates(options),
  getAuthState: () => singleton().getAuthState(),
  getLegacy: () => singleton().getLegacy(),
  getPassport: () => singleton().getPassport(),
  getProviderGeneration: (provider) => singleton().getProviderGeneration(provider),
  getSecurityStatus: () => singleton().getSecurityStatus(),
  markPassportAimApiAccepted: (accepted, aimUserId) =>
    singleton().markPassportAimApiAccepted(accepted, aimUserId),
  quarantinePassportRefreshToken: (expectedRefreshToken) =>
    singleton().quarantinePassportRefreshToken(expectedRefreshToken),
  set: (data) => singleton().setLegacy(data),
  setLegacy: (data) => singleton().setLegacy(data),
  setPassport: (data) => singleton().setPassport(data),
  setPassportRefreshToken: (expectedRefreshToken, nextRefreshToken) =>
    singleton().setPassportRefreshToken(expectedRefreshToken, nextRefreshToken),
  setPassportRolloutEnabled: (enabled) => {
    defaultPassportRolloutEnabled = enabled === true;
    if (defaultStore) defaultStore.setPassportRolloutEnabled(defaultPassportRolloutEnabled);
  },
};
