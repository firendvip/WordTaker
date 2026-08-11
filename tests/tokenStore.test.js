import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tokenStoreModule = require("../src/helpers/tokenStore.js");
const {
  LEGACY_FILE_NAME,
  SECURE_FILE_NAME,
  createTokenStore,
} = tokenStoreModule;
const { OIDC_ISSUER } = require("../src/helpers/passportOidc.js");

const tempDirectories = [];
const PASSPORT_USER_ID = "b118e5a6-1258-4d1d-9e42-a25306d3085a";
const OTHER_PASSPORT_USER_ID = "e211880f-cef2-4e64-8ba4-5a12f4c2af55";

function tempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-auth-store-"));
  tempDirectories.push(directory);
  return directory;
}

function secureStorage({
  available = true,
  backend = "keychain",
  failEncrypt = false,
  failDecrypt = false,
  invalidEncryptedValue,
  failStatus = false,
} = {}) {
  return {
    isEncryptionAvailable: () => {
      if (failStatus) throw new Error("status failed");
      return available;
    },
    getSelectedStorageBackend: () => backend,
    encryptString: (plaintext) => {
      if (failEncrypt) throw new Error("encryption failed");
      if (invalidEncryptedValue !== undefined) return invalidEncryptedValue;
      return Buffer.from(`safe:v1:${Buffer.from(plaintext).toString("base64")}`);
    },
    decryptString: (ciphertext) => {
      if (failDecrypt) throw new Error("decryption failed");
      const value = ciphertext.toString();
      if (!value.startsWith("safe:v1:")) throw new Error("bad ciphertext");
      return Buffer.from(value.slice(8), "base64").toString();
    },
  };
}

function passportSession(now, overrides = {}) {
  return {
    accessToken: "opaque-passport-token",
    refreshToken: `opaque-refresh~${"R".repeat(43)}`,
    idToken: "id-token",
    expiresAt: now + 900_000,
    scope: "openid profile offline_access aim.api",
    centralSessionId: "f430586a-5aad-49a1-85f8-1bb4102f32a6",
    profileCheckedAt: now,
    account: {
      passport_user_id: PASSPORT_USER_ID,
      nickname: "望三用户",
      picture: null,
      profile_version: 1,
    },
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OS-protected credential store", () => {
  it("persists legacy AIM credentials only as safeStorage ciphertext", () => {
    const directory = tempDirectory();
    const options = {
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => 1_800_000_000_000,
    };
    const store = createTokenStore(options);

    expect(store.setLegacy({ accessToken: "legacy-sensitive-token", account: { userId: "42" } })).toBe(true);
    const bytes = fs.readFileSync(path.join(directory, SECURE_FILE_NAME));
    expect(bytes.toString()).not.toContain("legacy-sensitive-token");
    expect(fs.statSync(path.join(directory, SECURE_FILE_NAME)).mode & 0o077).toBe(0);

    const reloaded = createTokenStore(options);
    expect(reloaded.getLegacy()).toMatchObject({
      accessToken: "legacy-sensitive-token",
      account: { userId: "42" },
    });
  });

  it("atomically migrates the old plaintext JSON without deleting account/business identity", () => {
    const directory = tempDirectory();
    const legacyPath = path.join(directory, LEGACY_FILE_NAME);
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        accessToken: "old-plaintext-token",
        account: { userId: "42", inviteCode: "KEEP-ME" },
        savedAt: "2026-08-01T00:00:00.000Z",
      }),
      { mode: 0o600 },
    );

    const store = createTokenStore({
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => 1_800_000_000_000,
    });

    expect(store.getLegacy()).toMatchObject({
      accessToken: "old-plaintext-token",
      account: { userId: "42", inviteCode: "KEEP-ME" },
    });
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(path.join(directory, SECURE_FILE_NAME))).toBe(true);
  });

  it("reads legacy fallback without mutating credentials while Passport is default-off", () => {
    const directory = tempDirectory();
    const legacyPath = path.join(directory, LEGACY_FILE_NAME);
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({ accessToken: "default-off-legacy-token", account: { userId: "42" } }),
      { mode: 0o600 },
    );
    const safeStorage = secureStorage();
    const encryptString = safeStorage.encryptString;
    let encryptCalls = 0;
    safeStorage.encryptString = (value) => {
      encryptCalls += 1;
      return encryptString(value);
    };
    const store = createTokenStore({
      dataDirectory: directory,
      safeStorage,
      platform: "darwin",
    });
    store.setPassportRolloutEnabled(false);

    expect(store.getLegacy()).toMatchObject({
      accessToken: "default-off-legacy-token",
      account: { userId: "42" },
    });
    expect(encryptCalls).toBe(0);
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(fs.existsSync(path.join(directory, SECURE_FILE_NAME))).toBe(false);
  });

  it("does not delete the legacy file when secure migration cannot be verified", () => {
    const directory = tempDirectory();
    const legacyPath = path.join(directory, LEGACY_FILE_NAME);
    fs.writeFileSync(legacyPath, JSON.stringify({ accessToken: "keep-until-safe", account: { userId: "42" } }));

    const store = createTokenStore({
      dataDirectory: directory,
      safeStorage: secureStorage({ failEncrypt: true }),
      platform: "darwin",
    });

    expect(store.getLegacy()?.accessToken).toBe("keep-until-safe");
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(fs.existsSync(path.join(directory, SECURE_FILE_NAME))).toBe(false);
  });

  it("removes a stale plaintext source after the authoritative secure record changes", () => {
    const directory = tempDirectory();
    const legacyPath = path.join(directory, LEGACY_FILE_NAME);
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({ accessToken: "legacy-old", account: { userId: "42" } }),
      { mode: 0o600 },
    );
    let failLegacyUnlink = true;
    const fsWithOneFailedUnlink = {
      ...fs,
      unlinkSync: (target) => {
        if (target === legacyPath && failLegacyUnlink) {
          failLegacyUnlink = false;
          throw new Error("busy");
        }
        return fs.unlinkSync(target);
      },
    };
    const options = {
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => 1_800_000_000_000,
    };
    const first = createTokenStore({ ...options, fsModule: fsWithOneFailedUnlink });
    expect(first.getLegacy()?.accessToken).toBe("legacy-old");
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(first.setLegacy({ accessToken: "legacy-new", account: { userId: "42" } })).toBe(true);

    const restarted = createTokenStore(options);
    expect(restarted.getLegacy()?.accessToken).toBe("legacy-new");
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("does not revive a migrated plaintext legacy credential after provider clear", () => {
    const directory = tempDirectory();
    const legacyPath = path.join(directory, LEGACY_FILE_NAME);
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({ accessToken: "legacy-old", account: { userId: "42" } }),
      { mode: 0o600 },
    );
    let failMigrationUnlink = true;
    const migrationFs = {
      ...fs,
      unlinkSync: (target) => {
        if (target === legacyPath && failMigrationUnlink) {
          failMigrationUnlink = false;
          throw new Error("busy during migration");
        }
        return fs.unlinkSync(target);
      },
    };
    const options = {
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => 1_800_000_000_000,
    };
    const store = createTokenStore({ ...options, fsModule: migrationFs });
    expect(store.getLegacy()?.accessToken).toBe("legacy-old");
    expect(fs.existsSync(legacyPath)).toBe(true);

    expect(store.clearProvider("legacy")).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(false);
    const restarted = createTokenStore(options);
    expect(restarted.getLegacy()).toBeNull();
    expect(restarted.clearProvider("legacy")).toBe(true);
    expect(restarted.clearProvider("unknown")).toBe(false);
  });

  it("reports failure when a stale plaintext legacy credential cannot be deleted", () => {
    const directory = tempDirectory();
    const legacyPath = path.join(directory, LEGACY_FILE_NAME);
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({ accessToken: "legacy-old", account: { userId: "42" } }),
      { mode: 0o600 },
    );
    const guardedFs = {
      ...fs,
      unlinkSync: (target) => {
        if (target === legacyPath) throw new Error("delete denied");
        return fs.unlinkSync(target);
      },
    };
    const store = createTokenStore({
      dataDirectory: directory,
      safeStorage: secureStorage(),
      fsModule: guardedFs,
      platform: "darwin",
    });
    expect(store.getLegacy()?.accessToken).toBe("legacy-old");
    expect(store.clearProvider("legacy")).toBe(false);
    expect(store.getLegacy()?.accessToken).toBe("legacy-old");
  });

  it("fails closed instead of persisting Electron Linux basic_text credentials", () => {
    const directory = tempDirectory();
    const store = createTokenStore({
      dataDirectory: directory,
      safeStorage: secureStorage({ backend: "basic_text" }),
      platform: "linux",
    });

    expect(store.setLegacy({ accessToken: "memory-only-token", account: { userId: "42" } })).toBe(false);
    expect(store.getLegacy()?.accessToken).toBe("memory-only-token");
    expect(fs.existsSync(path.join(directory, SECURE_FILE_NAME))).toBe(false);
    expect(store.getSecurityStatus()).toEqual({ persistent: false, reason: "secure-storage-unavailable" });
  });

  it("keeps passport and legacy sessions side by side and falls back after access expiry", () => {
    const directory = tempDirectory();
    let now = 1_800_000_000_000;
    const store = createTokenStore({
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => now,
    });
    store.setLegacy({ accessToken: "legacy-token", account: { userId: "42" } });
    store.setPassport(passportSession(now));

    const encrypted = fs.readFileSync(path.join(directory, SECURE_FILE_NAME));
    const persisted = JSON.parse(secureStorage().decryptString(encrypted));
    expect(persisted.passport).toMatchObject({
      issuer: OIDC_ISSUER,
      refreshToken: `opaque-refresh~${"R".repeat(43)}`,
      account: { passport_user_id: PASSPORT_USER_ID },
    });
    expect(persisted.passport).not.toHaveProperty("accessToken");
    expect(persisted.passport).not.toHaveProperty("idToken");
    expect(persisted.passport).not.toHaveProperty("expiresAt");

    expect(store.getAccessTokenCandidates()).toEqual([
      { provider: "legacy", accessToken: "legacy-token" },
    ]);
    expect(store.getAccessTokenCandidates({ method: "GET", purpose: "aim-mapping" })).toEqual([
      { provider: "passport", accessToken: "opaque-passport-token" },
      { provider: "legacy", accessToken: "legacy-token" },
    ]);
    expect(store.getAuthState()).toMatchObject({
      loggedIn: true,
      provider: "passport",
      identity: { issuer: OIDC_ISSUER, passport_user_id: PASSPORT_USER_ID },
      account: { passport_user_id: PASSPORT_USER_ID },
    });

    now += 901_000;
    expect(store.getAccessTokenCandidates()).toEqual([
      { provider: "legacy", accessToken: "legacy-token" },
    ]);
    store.clearPassport();
    expect(store.getLegacy()?.accessToken).toBe("legacy-token");
    store.clear();
    expect(store.getAuthState()).toEqual({ loggedIn: false, provider: null, account: null });
  });

  it("keeps central access tokens process-only and restores solely through the refresh credential", () => {
    const directory = tempDirectory();
    const now = 1_800_000_000_000;
    const options = {
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => now,
    };
    const store = createTokenStore(options);
    expect(store.setPassport(passportSession(now))).toBe(true);
    expect(store.getPassport()).toMatchObject({
      issuer: OIDC_ISSUER,
      accessToken: "opaque-passport-token",
      expiresAt: now + 900_000,
    });

    const restarted = createTokenStore(options);
    expect(restarted.getPassport()).toMatchObject({
      issuer: OIDC_ISSUER,
      refreshToken: `opaque-refresh~${"R".repeat(43)}`,
      accessToken: null,
      expiresAt: 0,
    });
    expect(restarted.getAccessToken()).toBeNull();
  });

  it("atomically persists a rotated refresh token before access-token verification", () => {
    const directory = tempDirectory();
    const now = 1_800_000_000_000;
    const options = {
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => now,
    };
    const store = createTokenStore(options);
    store.setPassport(passportSession(now));
    expect(store.setPassportRefreshToken(
      `opaque-refresh~${"R".repeat(43)}`,
      `opaque-refresh~${"S".repeat(43)}`,
    )).toBe(true);
    expect(store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"S".repeat(43)}`,
      accessToken: "opaque-passport-token",
    });
    expect(createTokenStore(options).getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"S".repeat(43)}`,
      accessToken: null,
    });
    expect(store.setPassportRefreshToken(
      `opaque-refresh~${"R".repeat(43)}`,
      `opaque-refresh~${"T".repeat(43)}`,
    )).toBe(false);
    expect(store.setPassportRefreshToken(
      `opaque-refresh~${"S".repeat(43)}`,
      `opaque-refresh~${"S".repeat(43)}`,
    )).toBe(false);
    expect(store.quarantinePassportRefreshToken(`opaque-refresh~${"S".repeat(43)}`)).toBe(true);
    expect(store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"S".repeat(43)}`,
      refreshOutcomeUnknown: true,
      accessToken: "opaque-passport-token",
    });
    expect(createTokenStore(options).getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"S".repeat(43)}`,
      refreshOutcomeUnknown: true,
      accessToken: null,
    });
    expect(createTokenStore(options).getAuthState()).toEqual({
      loggedIn: false,
      provider: null,
      account: null,
    });
    expect(store.quarantinePassportRefreshToken("bad/refresh/token")).toBe(false);
    expect(store.quarantinePassportRefreshToken(`opaque-refresh~${"T".repeat(43)}`)).toBe(false);
    expect(store.setPassportRefreshToken("bad/refresh/token", `opaque-refresh~${"T".repeat(43)}`)).toBe(false);
    expect(store.setPassportRefreshToken(`opaque-refresh~${"S".repeat(43)}`, "bad/refresh/token")).toBe(false);
  });

  it("falls back to legacy after restart finds a quarantined Passport family", () => {
    const directory = tempDirectory();
    const now = 1_800_000_000_000;
    const options = {
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => now,
    };
    const store = createTokenStore(options);
    store.setLegacy({ accessToken: "legacy-token", account: { userId: "42" } });
    store.setPassport(passportSession(now));
    expect(store.quarantinePassportRefreshToken(`opaque-refresh~${"R".repeat(43)}`)).toBe(true);
    expect(createTokenStore(options).getAuthState()).toMatchObject({
      loggedIn: true,
      provider: "legacy",
    });
  });

  it("gates Passport AIM writes until the explicit mapping probe succeeds", () => {
    const directory = tempDirectory();
    const now = 1_800_000_000_000;
    const store = createTokenStore({
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => now,
    });
    store.setLegacy({ accessToken: "legacy-token", account: { userId: "42" } });
    store.setPassport(passportSession(now));

    expect(store.getAccessTokenCandidates({ method: "POST" })).toEqual([
      { provider: "legacy", accessToken: "legacy-token" },
    ]);
    expect(store.markPassportAimApiAccepted(false)).toBe(true);
    expect(store.getAuthState()).toMatchObject({ provider: "legacy" });
    expect(store.getAccessTokenCandidates({ method: "GET" })).toEqual([
      { provider: "legacy", accessToken: "legacy-token" },
    ]);
    expect(store.markPassportAimApiAccepted(true, "42")).toBe(true);
    expect(store.markPassportAimApiAccepted(true, "42")).toBe(true);
    expect(store.getAccessTokenCandidates({ method: "POST" })).toEqual([
      { provider: "passport", accessToken: "opaque-passport-token" },
    ]);
    expect(store.get()).toMatchObject({
      accessToken: "opaque-passport-token",
      provider: "passport",
    });
    expect(store.getAccessToken()).toBe("opaque-passport-token");

    store.setPassport(passportSession(now, {
      account: {
        passport_user_id: OTHER_PASSPORT_USER_ID,
        nickname: "另一个通行证用户",
        picture: null,
        profile_version: 1,
      },
    }));
    expect(store.getAccessTokenCandidates({ method: "POST" })).toEqual([
      { provider: "legacy", accessToken: "legacy-token" },
    ]);
    expect(store.markPassportAimApiAccepted(true, 42)).toBe(true);
    store.setLegacy({ accessToken: "other-legacy-token", account: { userId: "99" } });
    expect(store.getAccessTokenCandidates({ method: "POST" })).toEqual([
      { provider: "legacy", accessToken: "other-legacy-token" },
    ]);
    expect(store.markPassportAimApiAccepted(true, "42")).toBe(false);
    expect(store.markPassportAimApiAccepted(true, "99")).toBe(false);
    expect(store.getAccessTokenCandidates({ method: "POST" })).toEqual([
      { provider: "legacy", accessToken: "other-legacy-token" },
    ]);
  });

  it("requires an authenticated AIM mapping before Passport-only write requests", () => {
    const directory = tempDirectory();
    const now = 1_800_000_000_000;
    const store = createTokenStore({
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => now,
    });
    store.setPassport(passportSession(now));
    expect(store.getAccessTokenCandidates({ method: "GET" })).toEqual([]);
    expect(store.getAccessTokenCandidates({ method: "GET", purpose: "aim-mapping" })).toEqual([
      { provider: "passport", accessToken: "opaque-passport-token" },
    ]);
    expect(store.getAccessTokenCandidates({ method: "POST" })).toEqual([]);
    expect(store.markPassportAimApiAccepted(true, "42")).toBe(true);
    expect(store.getAccessTokenCandidates({ method: "POST" })).toEqual([
      { provider: "passport", accessToken: "opaque-passport-token" },
    ]);
    expect(store.getPassport()?.aimMapping).toEqual({
      issuer: OIDC_ISSUER,
      passport_user_id: PASSPORT_USER_ID,
      aim_user_id: "42",
    });
    expect(store.markPassportAimApiAccepted(false)).toBe(true);
    expect(store.getAuthState()).toEqual({ loggedIn: false, provider: null, account: null });
  });

  it("never overwrites an established issuer-sub AIM mapping with a conflicting user", () => {
    const directory = tempDirectory();
    const now = 1_800_000_000_000;
    const store = createTokenStore({
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => now,
    });
    store.setPassport(passportSession(now));
    expect(store.markPassportAimApiAccepted(true, "42")).toBe(true);
    expect(store.markPassportAimApiAccepted(true, "99")).toBe(false);
    expect(store.getPassport()?.aimMapping).toEqual({
      issuer: OIDC_ISSUER,
      passport_user_id: PASSPORT_USER_ID,
      aim_user_id: "42",
    });
    expect(store.getAccessTokenCandidates({ method: "POST" })).toEqual([]);
  });

  it("requires a fresh AIM mapping proof in every desktop process", () => {
    const directory = tempDirectory();
    const now = 1_800_000_000_000;
    const options = {
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => now,
    };
    const original = createTokenStore(options);
    original.setLegacy({ accessToken: "legacy-token", account: { userId: "42" } });
    original.setPassport(passportSession(now));
    expect(original.markPassportAimApiAccepted(true, "42")).toBe(true);

    const restarted = createTokenStore(options);
    restarted.setPassport(passportSession(now));
    expect(restarted.getAccessTokenCandidates({ method: "GET" })).toEqual([
      { provider: "legacy", accessToken: "legacy-token" },
    ]);
    expect(restarted.getAccessTokenCandidates({ method: "GET", purpose: "aim-mapping" })).toEqual([
      { provider: "passport", accessToken: "opaque-passport-token" },
      { provider: "legacy", accessToken: "legacy-token" },
    ]);
    expect(restarted.getAccessTokenCandidates({ method: "POST" })).toEqual([
      { provider: "legacy", accessToken: "legacy-token" },
    ]);
    expect(restarted.markPassportAimApiAccepted(true, "42")).toBe(true);
    expect(restarted.getAccessTokenCandidates({ method: "POST" })).toEqual([
      { provider: "passport", accessToken: "opaque-passport-token" },
    ]);
  });

  it("supports an independent default-off rollout without deleting either credential", () => {
    const directory = tempDirectory();
    const now = 1_800_000_000_000;
    const store = createTokenStore({
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => now,
    });
    store.setLegacy({ accessToken: "legacy-token", account: { userId: "42" } });
    store.setPassport(passportSession(now, { aimApiAccepted: true }));
    store.setPassportRolloutEnabled(false);
    expect(store.getAuthState()).toMatchObject({ provider: "legacy" });
    expect(store.getAccessTokenCandidates()).toEqual([
      { provider: "legacy", accessToken: "legacy-token" },
    ]);
    store.setPassportRolloutEnabled(true);
    expect(store.getPassport()?.refreshToken).toBe(`opaque-refresh~${"R".repeat(43)}`);
    expect(store.getLegacy()?.accessToken).toBe("legacy-token");

    const empty = createTokenStore({
      dataDirectory: tempDirectory(),
      safeStorage: secureStorage(),
      platform: "darwin",
    });
    empty.setPassportRolloutEnabled(false);
    expect(empty.getAccessTokenCandidates()).toEqual([]);
    expect(empty.getAuthState()).toEqual({ loggedIn: false, provider: null, account: null });
    expect(empty.markPassportAimApiAccepted(true, "42")).toBe(false);
    expect(empty.markPassportAimApiAccepted(false)).toBe(true);
  });

  it("clears providers independently and never mutates the surviving AIM account", () => {
    const directory = tempDirectory();
    const now = 1_800_000_000_000;
    const store = createTokenStore({
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => now,
    });
    store.setLegacy({ accessToken: "legacy-token", account: { userId: "42", role: "member" } });
    store.setPassport(passportSession(now));
    expect(store.clearProvider("passport")).toBe(true);
    expect(store.getLegacy()).toMatchObject({ account: { userId: "42", role: "member" } });
    expect(store.clearProvider("passport")).toBe(true);
    expect(store.clearProvider("unknown")).toBe(false);
    expect(store.clearProvider("legacy")).toBe(true);
    expect(store.clearProvider("legacy")).toBe(true);
    expect(store.get()).toBeNull();
  });

  it("increments only the credential generation that actually changes", () => {
    const directory = tempDirectory();
    const now = 1_800_000_000_000;
    const store = createTokenStore({
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => now,
    });
    expect(store.getProviderGeneration("passport")).toBe(0);
    expect(store.getProviderGeneration("legacy")).toBe(0);
    store.setLegacy({ accessToken: "legacy-token", account: { userId: "42" } });
    expect(store.getProviderGeneration("legacy")).toBe(1);
    expect(store.getProviderGeneration("passport")).toBe(0);
    store.setPassport(passportSession(now));
    expect(store.getProviderGeneration("passport")).toBe(1);
    expect(store.markPassportAimApiAccepted(true, "42")).toBe(true);
    expect(store.getProviderGeneration("passport")).toBe(1);
    store.clearPassport();
    expect(store.getProviderGeneration("passport")).toBe(2);
    store.clear();
    expect(store.getProviderGeneration("passport")).toBe(3);
    expect(store.getProviderGeneration("legacy")).toBe(2);
    expect(store.getProviderGeneration("unknown")).toBeNull();
  });

  it("rejects invalid store and session inputs at the boundary", () => {
    expect(() => createTokenStore({ dataDirectory: "relative", safeStorage: secureStorage() })).toThrow(/绝对路径/);
    const directory = tempDirectory();
    const now = 1_800_000_000_000;
    const store = createTokenStore({
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => now,
    });
    for (const value of [null, {}, { accessToken: "short" }, { accessToken: "bad token value" }]) {
      expect(() => store.setLegacy(value)).toThrow();
    }
    const invalidPassport = [
      null,
      passportSession(now, { accessToken: "short" }),
      passportSession(now, { expiresAt: now }),
      passportSession(now, { refreshToken: "bad/refresh/token" }),
      passportSession(now, { scope: "x".repeat(513) }),
      passportSession(now, { centralSessionId: "bad" }),
      passportSession(now, { profileCheckedAt: -1 }),
      passportSession(now, { account: { passport_user_id: "bad" } }),
    ];
    for (const value of invalidPassport) expect(() => store.setPassport(value)).toThrow();
  });

  it("sanitizes account summaries without treating them as identity evidence", () => {
    const directory = tempDirectory();
    const store = createTokenStore({
      dataDirectory: directory,
      safeStorage: secureStorage(),
      platform: "darwin",
      now: () => 1_800_000_000_000,
    });
    expect(store.setLegacy({ accessToken: "legacy-null-account", account: null })).toBe(true);
    expect(store.getLegacy().account).toBeNull();
    expect(store.setLegacy({ accessToken: "legacy-foreign-account", account: new Date() })).toBe(true);
    expect(store.getLegacy().account).toBeNull();
    const long = "x".repeat(5000);
    const array = Array.from({ length: 70 }, (_, index) => index);
    const accountInput = {
      long,
      invalidNumber: Infinity,
      array,
      foreignObject: new Date(),
      nested: { a: { b: { c: { tooDeep: "drop" } } } },
    };
    for (const key of ["__proto__", "prototype", "constructor"]) {
      Object.defineProperty(accountInput, key, { value: "drop", enumerable: true });
    }
    store.setLegacy({
      accessToken: "legacy-token",
      account: accountInput,
    });
    const account = store.getLegacy().account;
    expect(account.long).toHaveLength(4096);
    expect(account.invalidNumber).toBeNull();
    expect(account.array).toHaveLength(64);
    expect(account.foreignObject).toBeNull();
    expect(account.nested.a.b.c).toBeNull();
    expect(account).not.toHaveProperty("prototype");
    expect(account).not.toHaveProperty("constructor");
  });

  it("fails closed for unavailable, throwing, corrupt and oversized secure storage", () => {
    for (const storage of [null, secureStorage({ available: false }), secureStorage({ failStatus: true })]) {
      const directory = tempDirectory();
      const store = createTokenStore({ dataDirectory: directory, safeStorage: storage, platform: "darwin" });
      expect(store.getSecurityStatus().persistent).toBe(false);
      expect(store.setPassport(passportSession(Date.now()))).toBe(false);
      expect(fs.existsSync(path.join(directory, SECURE_FILE_NAME))).toBe(false);
    }

    for (const contents of [Buffer.from("corrupt"), Buffer.alloc(128 * 1024 + 1)]) {
      const directory = tempDirectory();
      fs.writeFileSync(path.join(directory, SECURE_FILE_NAME), contents);
      const store = createTokenStore({
        dataDirectory: directory,
        safeStorage: secureStorage(),
        platform: "darwin",
      });
      expect(store.getAuthState()).toEqual({ loggedIn: false, provider: null, account: null });
    }
  });

  it("rolls back failed encrypted writes and cleans ciphertext temporary files", () => {
    const cases = [
      { storage: secureStorage({ failEncrypt: true }) },
      { storage: secureStorage({ failDecrypt: true }) },
      { storage: secureStorage({ invalidEncryptedValue: "not-a-buffer" }) },
      { storage: secureStorage({ invalidEncryptedValue: Buffer.alloc(0) }) },
      {
        storage: secureStorage(),
        fsModule: { ...fs, renameSync: () => { throw new Error("rename failed"); } },
      },
    ];
    for (const entry of cases) {
      const directory = tempDirectory();
      const store = createTokenStore({
        dataDirectory: directory,
        safeStorage: entry.storage,
        fsModule: entry.fsModule || fs,
        platform: "darwin",
      });
      expect(store.setLegacy({ accessToken: "legacy-token", account: { userId: "42" } })).toBe(false);
      expect(store.getLegacy()).toBeNull();
      expect(fs.readdirSync(directory).filter((name) => name.includes(".tmp-"))).toEqual([]);
    }
  });

  it("tolerates chmod failure but reports durable deletion failure", () => {
    const directory = tempDirectory();
    const store = createTokenStore({
      dataDirectory: directory,
      safeStorage: secureStorage(),
      fsModule: { ...fs, chmodSync: () => { throw new Error("chmod denied"); } },
      platform: "darwin",
    });
    expect(store.setLegacy({ accessToken: "legacy-token", account: { userId: "42" } })).toBe(true);

    const failingDeleteStore = createTokenStore({
      dataDirectory: directory,
      safeStorage: secureStorage(),
      fsModule: {
        ...fs,
        unlinkSync: (filePath) => {
          if (filePath.endsWith(SECURE_FILE_NAME)) throw new Error("delete denied");
          return fs.unlinkSync(filePath);
        },
      },
      platform: "darwin",
    });
    expect(failingDeleteStore.getLegacy()?.accessToken).toBe("legacy-token");
    expect(failingDeleteStore.clear()).toBe(false);
  });

  it("keeps immutable mapping evidence denied in memory and fails closed on session removal", () => {
    const directory = tempDirectory();
    let failRename = false;
    const guardedFs = {
      ...fs,
      renameSync: (...args) => {
        if (failRename) throw new Error("rename denied");
        return fs.renameSync(...args);
      },
    };
    const now = 1_800_000_000_000;
    const store = createTokenStore({
      dataDirectory: directory,
      safeStorage: secureStorage(),
      fsModule: guardedFs,
      platform: "darwin",
      now: () => now,
    });
    store.setLegacy({ accessToken: "legacy-token", account: { userId: "42" } });
    store.setPassport(passportSession(now));
    expect(store.markPassportAimApiAccepted(true, "42")).toBe(true);
    failRename = true;

    expect(store.markPassportAimApiAccepted(false)).toBe(true);
    expect(store.getAccessTokenCandidates({ method: "POST" })).toEqual([
      { provider: "legacy", accessToken: "legacy-token" },
    ]);
    expect(fs.existsSync(path.join(directory, SECURE_FILE_NAME))).toBe(true);

    failRename = false;
    expect(store.setPassport(passportSession(now))).toBe(true);
    failRename = true;
    expect(store.clearPassport()).toBe(true);
    expect(store.getPassport()).toBeNull();
    expect(fs.existsSync(path.join(directory, SECURE_FILE_NAME))).toBe(false);
  });

  it("wires the production Electron safeStorage facade and propagates the rollout flag", () => {
    const directory = tempDirectory();
    const electronPath = require.resolve("electron");
    const storePath = require.resolve("../src/helpers/tokenStore.js");
    const previousElectron = require.cache[electronPath];
    const previousStore = require.cache[storePath];
    try {
      require.cache[electronPath] = {
        id: electronPath,
        filename: electronPath,
        loaded: true,
        exports: {
          app: { getPath: (name) => (name === "userData" ? directory : null) },
          safeStorage: secureStorage(),
        },
      };
      delete require.cache[storePath];
      const facade = require(storePath);
      facade.setPassportRolloutEnabled(false);
      expect(facade.set({ accessToken: "legacy-token", account: { userId: "42" } })).toBe(true);
      expect(facade.setPassport(passportSession(Date.now()))).toBe(true);
      expect(facade.getSecurityStatus()).toEqual({ persistent: true, reason: null });
      expect(facade.getAuthState()).toMatchObject({ provider: "legacy" });
      expect(facade.getLegacy()?.accessToken).toBe("legacy-token");
      expect(facade.getPassport()?.accessToken).toBe("opaque-passport-token");

      facade.setPassportRolloutEnabled(true);
      expect(facade.markPassportAimApiAccepted(true, "42")).toBe(true);
      expect(facade.getAccessTokenCandidates({ method: "POST" })).toEqual([
        { provider: "passport", accessToken: "opaque-passport-token" },
      ]);
      expect(facade.getAccessToken()).toBe("opaque-passport-token");
      expect(facade.get()).toMatchObject({ provider: "passport" });
      expect(facade.getProviderGeneration("passport")).toBeGreaterThan(0);
      expect(facade.setPassportRefreshToken(
        `opaque-refresh~${"R".repeat(43)}`,
        `opaque-refresh~${"S".repeat(43)}`,
      )).toBe(true);
      expect(facade.quarantinePassportRefreshToken(`opaque-refresh~${"S".repeat(43)}`)).toBe(true);
      expect(facade.clearPassport()).toBe(true);
      expect(facade.setLegacy({ accessToken: "legacy-token-2", account: { userId: "42" } })).toBe(true);
      expect(facade.clearProvider("legacy")).toBe(true);
      expect(facade.clear()).toBe(true);
    } finally {
      delete require.cache[storePath];
      if (previousStore) require.cache[storePath] = previousStore;
      if (previousElectron) require.cache[electronPath] = previousElectron;
      else delete require.cache[electronPath];
    }
  });
});
