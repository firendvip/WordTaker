const {
  CLIENT_ID,
  DISCOVERY_URL,
  OIDC_ISSUER,
  PassportAuthError,
  REDIRECT_URI,
  createAuthorizationRequest,
  extractRefreshTokenCandidate,
  parseCallbackUrl,
  validateDiscovery,
  validateRefreshTokenResponse,
  validateTokenResponse,
  validateUserInfo,
  verifyTokenSet,
} = require("./passportOidc");

const NETWORK_TIMEOUT_MS = 10_000;
const LOGIN_FLOW_TIMEOUT_MS = 10 * 60 * 1000;
const DISCOVERY_CACHE_MS = 60 * 60 * 1000;
const JWKS_CACHE_MS = 5 * 60 * 1000;
const PROFILE_RECHECK_MS = 5 * 60 * 1000;
const PROFILE_RETRY_MS = 60 * 1000;
const REFRESH_EARLY_MS = 2 * 60 * 1000;
const REFRESH_RETRY_MS = 60 * 1000;
const MAX_RESPONSE_BYTES = 128 * 1024;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function authRequired(error) {
  return (
    error?.status === 401 ||
    ["AUTH_REQUIRED", "invalid_grant", "invalid_token"].includes(error?.code)
  );
}

function refreshOutcomeUnknown(error) {
  return (
    [
      "PASSPORT_TIMEOUT",
      "PASSPORT_UNAVAILABLE",
      "INVALID_RESPONSE",
      "INVALID_TOKEN_RESPONSE",
    ].includes(error?.code) ||
    (error?.code === "PASSPORT_REQUEST_FAILED" && Number(error?.status) >= 500)
  );
}

function safeResultError(error) {
  if (error instanceof PassportAuthError) {
    return { success: false, code: error.code, error: error.message };
  }
  return { success: false, code: "PASSPORT_UNAVAILABLE", error: "统一登录暂不可用，请稍后重试" };
}

async function readBoundedResponseText(response) {
  const contentLength = response.headers?.get?.("content-length");
  if (/^[0-9]+$/.test(contentLength || "") && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new PassportAuthError("INVALID_RESPONSE", "统一登录响应过大", {
      status: response.status,
    });
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    return response.text();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The response is already rejected; cancellation is best effort.
        }
        throw new PassportAuthError("INVALID_RESPONSE", "统一登录响应过大", {
          status: response.status,
        });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    reader.releaseLock?.();
  }
}

class PassportAuthManager {
  constructor({
    tokenStore,
    openExternal,
    fetchFn = globalThis.fetch,
    logger = null,
    onAuthResult = null,
    now = Date.now,
    randomBytes,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    if (!tokenStore || typeof tokenStore.setPassport !== "function") {
      throw new TypeError("PassportAuthManager requires tokenStore");
    }
    if (typeof openExternal !== "function" || typeof fetchFn !== "function") {
      throw new TypeError("PassportAuthManager requires openExternal and fetchFn");
    }
    this.tokenStore = tokenStore;
    this.openExternal = openExternal;
    this.fetchFn = fetchFn;
    this.logger = logger;
    this.onAuthResult = typeof onAuthResult === "function" ? onAuthResult : null;
    this.now = now;
    this.randomBytes = randomBytes;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.pending = null;
    this.discoveryCache = null;
    this.jwksCache = null;
    this.refreshTimer = null;
    this.profileTimer = null;
    this.refreshPromise = null;
    this.refreshPromiseEpoch = null;
    this.userInfoPromise = null;
    this.userInfoPromiseEpoch = null;
    this.userInfoPromiseForce = false;
    this.logoutPromise = null;
    this.logoutPromiseKey = null;
    this.pendingRevocationTokens = new Set();
    this.revocationPromises = new Map();
    this.authEpoch = 0;
  }

  notify(result) {
    if (!this.onAuthResult) return;
    try {
      this.onAuthResult(result);
    } catch {
      // A renderer notification failure never changes authentication state.
    }
  }

  log(level, message, data) {
    const method = this.logger?.[level];
    if (typeof method === "function") method.call(this.logger, message, data);
  }

  assertAuthEpoch(epoch) {
    if (epoch !== this.authEpoch) {
      throw new PassportAuthError("AUTH_CANCELLED", "认证操作已取消");
    }
  }

  async requestJson(url, options = {}) {
    const controller = new AbortController();
    const timer = this.setTimeoutFn(() => controller.abort(), NETWORK_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await this.fetchFn(url, {
          ...options,
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
        });
      } catch (error) {
        const timeout = error?.name === "AbortError";
        throw new PassportAuthError(
          timeout ? "PASSPORT_TIMEOUT" : "PASSPORT_UNAVAILABLE",
          timeout ? "统一登录请求超时" : "无法连接统一登录服务",
          { retryable: true, cause: error },
        );
      }

      let text;
      try {
        text = await readBoundedResponseText(response);
      } catch (error) {
        if (error instanceof PassportAuthError) throw error;
        const timeout = error?.name === "AbortError";
        throw new PassportAuthError(
          timeout ? "PASSPORT_TIMEOUT" : "INVALID_RESPONSE",
          timeout ? "统一登录请求超时" : "统一登录响应无法读取",
          {
            status: response.status,
            retryable: timeout,
            cause: error,
          },
        );
      }
      if (typeof text !== "string" || Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
        throw new PassportAuthError("INVALID_RESPONSE", "统一登录响应过大", {
          status: response.status,
        });
      }
      let body = null;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = null;
      }

      if (!response.ok) {
        const protocolCode = isPlainObject(body) && typeof body.error === "string" ? body.error : null;
        if (
          response.status === 401 ||
          (response.status < 500 && ["invalid_grant", "invalid_token"].includes(protocolCode))
        ) {
          throw new PassportAuthError("AUTH_REQUIRED", "统一登录已失效，请重新登录", {
            status: response.status,
          });
        }
        if (response.status === 429) {
          throw new PassportAuthError("PASSPORT_RATE_LIMITED", "统一登录请求过于频繁", {
            status: 429,
            retryable: true,
          });
        }
        throw new PassportAuthError(
          response.status >= 500 ? "PASSPORT_REQUEST_FAILED" : protocolCode || "PASSPORT_REQUEST_FAILED",
          response.status >= 500 ? "统一登录服务暂不可用" : "统一登录请求失败",
          { status: response.status, retryable: response.status >= 500 },
        );
      }
      if (!isPlainObject(body)) {
        throw new PassportAuthError("INVALID_RESPONSE", "统一登录响应格式无效");
      }
      return body;
    } finally {
      this.clearTimeoutFn(timer);
    }
  }

  async loadDiscovery({ force = false } = {}) {
    const now = Number(this.now());
    if (
      !force &&
      this.discoveryCache &&
      now - this.discoveryCache.loadedAt < DISCOVERY_CACHE_MS
    ) {
      return this.discoveryCache.value;
    }
    const raw = await this.requestJson(DISCOVERY_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const value = validateDiscovery(raw);
    this.discoveryCache = { value, loadedAt: now };
    return value;
  }

  async loadJwks(discovery, { force = false } = {}) {
    const now = Number(this.now());
    if (!force && this.jwksCache && now - this.jwksCache.loadedAt < JWKS_CACHE_MS) {
      return this.jwksCache.value;
    }
    const value = await this.requestJson(discovery.jwksUri, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    this.jwksCache = { value, loadedAt: now };
    return value;
  }

  clearPending() {
    if (this.pending?.timer) this.clearTimeoutFn(this.pending.timer);
    this.pending = null;
  }

  invalidateAuthOperations() {
    this.authEpoch += 1;
    this.clearPending();
    if (this.refreshTimer) {
      this.clearTimeoutFn(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.profileTimer) {
      this.clearTimeoutFn(this.profileTimer);
      this.profileTimer = null;
    }
    return this.authEpoch;
  }

  async invalidatePassportSession({ notify = true } = {}) {
    const tokenToRevoke = this.tokenStore.getPassport()?.refreshToken || null;
    for (const token of tokenToRevoke ? [tokenToRevoke] : []) {
      this.pendingRevocationTokens.add(token);
    }
    this.invalidateAuthOperations();
    try {
      this.clearPassportSession();
    } finally {
      // The clear may partially succeed before reporting failure. Once the
      // local deletion attempt completes, never lose the only revocation
      // handle for the central refresh family.
      this.drainPendingRevocations();
    }
    const state = this.tokenStore.getAuthState();
    const publish = notify ? (result) => this.notify(result) : () => undefined;
    publish({ success: true, event: "session-cleared", ...state });
    return state;
  }

  async startLogin() {
    const now = Number(this.now());
    if (this.pending && now - this.pending.createdAt < LOGIN_FLOW_TIMEOUT_MS) {
      throw new PassportAuthError("AUTH_IN_PROGRESS", "统一登录正在进行中");
    }
    // A new authorization transaction owns a fresh epoch. This cancels any
    // older refresh/userinfo commit without deleting the compatible session.
    const epoch = this.invalidateAuthOperations();
    const starting = { createdAt: now, authEpoch: epoch, starting: true };
    this.pending = starting;
    let discovery;
    let authorization;
    try {
      discovery = await this.loadDiscovery();
      this.assertAuthEpoch(epoch);
      if (this.pending !== starting) {
        throw new PassportAuthError("AUTH_CANCELLED", "认证操作已取消");
      }
      authorization = createAuthorizationRequest({
        discovery,
        ...(this.randomBytes ? { randomBytes: this.randomBytes } : {}),
        now: this.now,
      });
    } catch (error) {
      if (this.pending === starting) this.clearPending();
      this.resumeStoredSessionTimers();
      throw error;
    }
    const timer = this.setTimeoutFn(() => {
      if (this.pending?.state !== authorization.state) return;
      this.pending = null;
      this.resumeStoredSessionTimers();
      this.notify({
        success: false,
        code: "AUTH_TIMEOUT",
        error: "统一登录等待超时，请重试",
      });
    }, LOGIN_FLOW_TIMEOUT_MS);
    this.pending = { ...authorization, discovery, timer, authEpoch: epoch };
    try {
      await this.openExternal(authorization.authorizationUrl);
      this.assertAuthEpoch(epoch);
      if (this.pending?.state !== authorization.state) {
        throw new PassportAuthError("AUTH_CANCELLED", "认证操作已取消");
      }
    } catch (error) {
      if (this.pending?.state === authorization.state) this.clearPending();
      if (error?.code === "AUTH_CANCELLED") throw error;
      this.resumeStoredSessionTimers();
      throw new PassportAuthError("BROWSER_OPEN_FAILED", "无法打开系统浏览器", {
        cause: error,
      });
    }
    return { success: true, pending: true };
  }

  async verifyInitialTokens(tokenResponse, pending) {
    let jwks = await this.loadJwks(pending.discovery);
    try {
      return verifyTokenSet({
        tokenResponse,
        jwks,
        expectedNonce: pending.nonce,
        nowSeconds: Math.floor(Number(this.now()) / 1000),
      });
    } catch (error) {
      if (!["INVALID_JWKS", "INVALID_TOKEN"].includes(error?.code)) throw error;
      jwks = await this.loadJwks(pending.discovery, { force: true });
      return verifyTokenSet({
        tokenResponse,
        jwks,
        expectedNonce: pending.nonce,
        nowSeconds: Math.floor(Number(this.now()) / 1000),
      });
    }
  }

  async fetchUserInfo(discovery, accessToken, passportUserId) {
    const raw = await this.requestJson(discovery.userinfoEndpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
    return validateUserInfo(raw, passportUserId);
  }

  accountFromProfile(profile) {
    return Object.freeze({
      passport_user_id: profile.passportUserId,
      nickname: profile.nickname,
      picture: profile.picture,
      profile_version: profile.profileVersion,
      authProvider: "passport",
    });
  }

  accountForProfile(profile, currentAccount) {
    const previous = currentAccount?.profile_version;
    if (Number.isSafeInteger(previous) && profile.profileVersion < previous) {
      throw new PassportAuthError("INVALID_USERINFO", "统一账号资料版本无效");
    }
    if (Number.isSafeInteger(previous) && profile.profileVersion === previous) {
      return currentAccount;
    }
    return this.accountFromProfile(profile);
  }

  clearPassportSession() {
    if (this.tokenStore.clearPassport() === true) return;
    if (typeof this.tokenStore.clear === "function" && this.tokenStore.clear() === true) return;
    throw new PassportAuthError("LOCAL_SESSION_CLEAR_FAILED", "无法清除本地统一登录凭据");
  }

  storePassportSession(
    session,
    epoch = this.authEpoch,
    { preserveExistingOnFailure = false } = {},
  ) {
    this.assertAuthEpoch(epoch);
    const previousSession = this.tokenStore.getPassport();
    if (this.tokenStore.setPassport(session) === true) return;
    if (!preserveExistingOnFailure && !previousSession) this.clearPassportSession();
    throw new PassportAuthError(
      "SECURE_STORAGE_REQUIRED",
      "系统安全凭据存储不可用，无法保持统一登录",
    );
  }

  commitRefreshRotation(current, nextRefreshToken) {
    const latest = this.tokenStore.getPassport();
    const sameRefreshFamily = Boolean(
      latest &&
      latest.issuer === current.issuer &&
      latest.account?.passport_user_id === current.account?.passport_user_id &&
      latest.refreshToken === current.refreshToken,
    );
    if (!sameRefreshFamily) {
      throw new PassportAuthError("AUTH_CANCELLED", "认证操作已取消");
    }
    if (
      typeof this.tokenStore.setPassportRefreshToken !== "function" ||
      this.tokenStore.setPassportRefreshToken(current.refreshToken, nextRefreshToken) !== true
    ) {
      this.clearPassportSession();
      throw new PassportAuthError(
        "SECURE_STORAGE_REQUIRED",
        "系统安全凭据存储不可用，无法保持统一登录",
      );
    }
    const rotatedSession = this.tokenStore.getPassport();
    return rotatedSession;
  }

  async handleCallback(rawUrl) {
    const pending = this.pending;
    if (!pending) {
      throw new PassportAuthError("NO_AUTH_REQUEST", "没有等待中的统一登录请求");
    }
    const existingPassport = this.tokenStore.getPassport();
    let operationEpoch = this.authEpoch;
    let issuedRefreshToken = null;
    let sessionCommitted = false;
    try {
      const callback = parseCallbackUrl(rawUrl, pending.state);
      // An unrelated/malicious scheme invocation must not cancel the genuine
      // transaction. Consume only after the exact callback and state validate.
      this.clearPending();
      const callbackEpoch = this.invalidateAuthOperations();
      operationEpoch = callbackEpoch;
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: callback.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: pending.codeVerifier,
      });
      const rawTokens = await this.requestJson(pending.discovery.tokenEndpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      issuedRefreshToken = extractRefreshTokenCandidate(rawTokens);
      const tokenResponse = validateTokenResponse(rawTokens);
      issuedRefreshToken = tokenResponse.refreshToken;
      const verified = await this.verifyInitialTokens(tokenResponse, pending);
      const profile = await this.fetchUserInfo(
        pending.discovery,
        tokenResponse.accessToken,
        verified.passportUserId,
      );
      const now = Number(this.now());
      const expiresAt = now + tokenResponse.expiresIn * 1000;
      const replacedRefreshToken = this.tokenStore.getPassport()?.refreshToken || null;
      this.storePassportSession({
        accessToken: tokenResponse.accessToken,
        idToken: tokenResponse.idToken,
        refreshToken: tokenResponse.refreshToken,
        expiresAt,
        scope: tokenResponse.scope,
        centralSessionId: verified.centralSessionId,
        profileCheckedAt: now,
        account: this.accountFromProfile(profile),
        aimProbeRequired: true,
      }, callbackEpoch, { preserveExistingOnFailure: Boolean(existingPassport) });
      sessionCommitted = true;
      if (replacedRefreshToken && replacedRefreshToken !== tokenResponse.refreshToken) {
        this.pendingRevocationTokens.add(replacedRefreshToken);
      }
      this.drainPendingRevocations();
      this.scheduleRefresh(expiresAt);
      this.scheduleProfileRecheck(now);
      const result = {
        success: true,
        event: "login-completed",
        loggedIn: true,
        provider: "passport",
        account: this.accountFromProfile(profile),
      };
      this.notify(result);
      this.log("info", "望三通行证登录完成", {
        provider: "passport",
      });
      return result;
    } catch (error) {
      if (issuedRefreshToken && !sessionCommitted) {
        // The authorization code was consumed and a refresh token was issued,
        // but this process never committed it. Avoid leaving a 30-day orphaned
        // central family when logout, validation or safe storage wins the race.
        this.queueRefreshTokenRevocation(issuedRefreshToken);
      }
      if (error?.stateValidated) this.clearPending();
      if (error?.code === "AUTH_CANCELLED") throw error;
      this.assertAuthEpoch(operationEpoch);
      // Callback failures concern the new authorization transaction, not an
      // already established Passport session. Preserve the old compatible RT
      // and resume its timers; only a committed replacement may supersede it.
      this.resumeStoredSessionTimers();
      const result = safeResultError(error);
      this.notify(result);
      this.log("warn", "望三通行证登录未完成", {
        code: result.code,
        status: error?.status ?? null,
      });
      throw error;
    }
  }

  scheduleRefresh(expiresAt) {
    this.clearTimeoutFn(this.refreshTimer);
    const delay = Math.max(1_000, Math.min(2_147_000_000, expiresAt - Number(this.now()) - REFRESH_EARLY_MS));
    this.refreshTimer = this.setTimeoutFn(() => {
      this.refresh().catch((error) => {
        this.log("warn", "望三通行证自动刷新失败", { code: error?.code || "unknown" });
        if (error?.retryable && this.tokenStore.getPassport()) {
          this.scheduleRefresh(Number(this.now()) + REFRESH_EARLY_MS + REFRESH_RETRY_MS);
        }
      });
    }, delay);
  }

  scheduleProfileRecheck(profileCheckedAt, retry = false) {
    this.clearTimeoutFn(this.profileTimer);
    const delay = retry
      ? PROFILE_RETRY_MS
      : Math.max(
          1_000,
          Math.min(
            2_147_000_000,
            profileCheckedAt + PROFILE_RECHECK_MS - Number(this.now()),
          ),
        );
    this.profileTimer = this.setTimeoutFn(() => {
      this.profileTimer = null;
      this.ensureFreshUserInfo({ force: true }).catch((error) => {
        this.log("warn", "望三通行证资料定时复核失败", { code: error?.code || "unknown" });
        if (this.tokenStore.getPassport()) this.scheduleProfileRecheck(0, true);
      });
    }, delay);
  }

  resumeStoredSessionTimers() {
    if (this.pending) return;
    const current = this.tokenStore.getPassport();
    if (!current) return;
    this.scheduleRefresh(Number(current.expiresAt) || Number(this.now()));
    this.scheduleProfileRecheck(Number(current.profileCheckedAt) || 0);
  }

  async initialize() {
    const passport = this.tokenStore.getPassport();
    if (!passport) return this.tokenStore.getAuthState();
    try {
      await this.ensureSessionReady();
      const ready = this.tokenStore.getPassport();
      if (ready?.accessToken) {
        this.scheduleRefresh(ready.expiresAt);
        this.scheduleProfileRecheck(ready.profileCheckedAt);
      }
    } catch (error) {
      if (!error?.retryable && error?.code !== "REFRESH_OUTCOME_UNKNOWN") {
        this.log("warn", "恢复统一登录会话失败", { code: error?.code });
      }
    }
    return this.tokenStore.getAuthState();
  }

  async refresh() {
    const epoch = this.authEpoch;
    if (this.refreshPromise) {
      if (this.refreshPromiseEpoch === epoch) return this.refreshPromise;
      const olderFamilyOperation = this.refreshPromise;
      try {
        await olderFamilyOperation;
      } catch {
        // A stale epoch cannot decide the newer session. Re-read the durable
        // family below; never replay its one-time RT while the old call settles.
      }
      const current = this.tokenStore.getPassport();
      if (!current) return { success: true, ...this.tokenStore.getAuthState() };
      if (
        current.accessToken &&
        current.expiresAt > Number(this.now()) + ACCESS_SAFETY_WINDOW_MS
      ) {
        return { success: true, profileVerified: false, ...this.tokenStore.getAuthState() };
      }
      if (this.pending) {
        throw new PassportAuthError("AUTH_IN_PROGRESS", "统一登录正在进行中");
      }
      throw new PassportAuthError("AUTH_CANCELLED", "认证操作已取消", { retryable: true });
    }
    const current = this.tokenStore.getPassport();
    if (current?.refreshOutcomeUnknown) {
      throw new PassportAuthError(
        "REFRESH_OUTCOME_UNKNOWN",
        "统一登录刷新结果无法确认，请重新登录",
      );
    }
    const operation = this.performRefresh(epoch).finally(() => {
      if (this.refreshPromise === operation) {
        this.refreshPromise = null;
        this.refreshPromiseEpoch = null;
      }
    });
    this.refreshPromise = operation;
    this.refreshPromiseEpoch = epoch;
    return operation;
  }

  async performRefresh(epoch) {
    this.assertAuthEpoch(epoch);
    const current = this.tokenStore.getPassport();
    if (!current) return this.tokenStore.getAuthState();
    let tokenRequestStarted = false;
    let rotationCommitted = false;
    let issuedRefreshToken = null;
    try {
      const discovery = await this.loadDiscovery();
      this.assertAuthEpoch(epoch);
      const refreshTarget = this.tokenStore.getPassport();
      if (
        !refreshTarget ||
        refreshTarget.issuer !== current.issuer ||
        refreshTarget.account?.passport_user_id !== current.account?.passport_user_id ||
        refreshTarget.refreshToken !== current.refreshToken
      ) {
        throw new PassportAuthError("AUTH_CANCELLED", "认证操作已取消");
      }
      // Persist an in-flight tombstone before the one-time RT can leave this
      // process. A crash after central consumption must never cause startup to
      // replay the same family. A valid rotated response clears this marker via
      // the exact refresh-token CAS below.
      if (
        typeof this.tokenStore.quarantinePassportRefreshToken !== "function" ||
        this.tokenStore.quarantinePassportRefreshToken(current.refreshToken) !== true
      ) {
        throw new PassportAuthError(
          "SECURE_STORAGE_REQUIRED",
          "系统安全凭据存储不可用，无法安全刷新统一登录",
        );
      }
      tokenRequestStarted = true;
      const raw = await this.requestJson(discovery.tokenEndpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          refresh_token: current.refreshToken,
        }).toString(),
      });
      issuedRefreshToken = extractRefreshTokenCandidate(raw);
      const rotated = validateRefreshTokenResponse(raw);
      issuedRefreshToken = rotated.refreshToken;
      if (rotated.refreshToken === current.refreshToken) {
        throw new PassportAuthError("INVALID_TOKEN_RESPONSE", "refresh token 未轮换");
      }
      // A refresh token is one-time. Persist its rotated successor immediately
      // after the token endpoint returns a structurally valid response. Keep the
      // accompanying opaque access token private until userinfo proves that it
      // still belongs to the established (issuer, sub).
      this.commitRefreshRotation(current, rotated.refreshToken);
      rotationCommitted = true;
      const passportUserId = current.account.passport_user_id;
      const now = Number(this.now());
      const expiresAt = now + rotated.expiresIn * 1000;
      const latest = this.tokenStore.getPassport();
      if (
        !latest ||
        latest.refreshToken !== rotated.refreshToken ||
        latest.account?.passport_user_id !== passportUserId
      ) {
        throw new PassportAuthError("AUTH_CANCELLED", "认证操作已取消");
      }
      this.assertAuthEpoch(epoch);
      const profile = await this.fetchUserInfo(
        discovery,
        rotated.accessToken,
        passportUserId,
      );
      this.assertAuthEpoch(epoch);
      const profiledSession = this.tokenStore.getPassport();
      if (
        !profiledSession ||
        profiledSession.refreshToken !== rotated.refreshToken ||
        profiledSession.account.passport_user_id !== passportUserId
      ) {
        throw new PassportAuthError("AUTH_CANCELLED", "认证操作已取消");
      }
      const account = this.accountForProfile(profile, profiledSession.account);
      this.storePassportSession({
        ...profiledSession,
        accessToken: rotated.accessToken,
        expiresAt,
        scope: rotated.scope,
        centralSessionId: profiledSession.centralSessionId,
        profileCheckedAt: now,
        account,
      }, epoch);
      this.scheduleRefresh(expiresAt);
      this.scheduleProfileRecheck(now);
      const authState = this.tokenStore.getAuthState();
      const result = {
        success: true,
        event: "session-refreshed",
        profileVerified: true,
        ...authState,
      };
      this.notify(result);
      return result;
    } catch (error) {
      if (issuedRefreshToken && !rotationCommitted) {
        this.queueRefreshTokenRevocation(issuedRefreshToken);
      }
      if (error?.code === "AUTH_CANCELLED") throw error;
      if (tokenRequestStarted && !rotationCommitted && refreshOutcomeUnknown(error)) {
        const latest = this.tokenStore.getPassport();
        if (
          !latest ||
          latest.issuer !== current.issuer ||
          latest.account?.passport_user_id !== current.account?.passport_user_id ||
          latest.refreshToken !== current.refreshToken ||
          latest.refreshOutcomeUnknown !== true
        ) {
          throw new PassportAuthError("AUTH_CANCELLED", "认证操作已取消");
        }
        // The central server may already have consumed this one-time RT even
        // though its response was lost. Discard the uncertain family and
        // require an interactive login; automatic replay would revoke it.
        if (epoch !== this.authEpoch) {
          throw new PassportAuthError("AUTH_CANCELLED", "认证操作已取消");
        }
        throw new PassportAuthError(
          "REFRESH_OUTCOME_UNKNOWN",
          "统一登录刷新结果无法确认，请重新登录",
          { cause: error },
        );
      }
      this.assertAuthEpoch(epoch);
      const invalidSession =
        authRequired(error) || ["INVALID_TOKEN", "IDENTITY_CONFLICT"].includes(error?.code);
      if (invalidSession) {
        if (issuedRefreshToken && rotationCommitted) {
          this.queueRefreshTokenRevocation(issuedRefreshToken);
        }
        await this.invalidatePassportSession();
      } else if (error?.retryable && this.tokenStore.getPassport()) {
        // The rotated RT was committed, but its opaque access token was never
        // published. Retry the refresh family; a profile-only retry could only
        // inspect the previous access token and would not prove the candidate.
        this.scheduleRefresh(Number(this.now()) + REFRESH_EARLY_MS + REFRESH_RETRY_MS);
      }
      throw error;
    }
  }

  beginUserInfoOperation(options, epoch) {
    const force = options?.force === true;
    const operation = this.performEnsureFreshUserInfo(options, epoch).finally(() => {
      if (this.userInfoPromise === operation) {
        this.userInfoPromise = null;
        this.userInfoPromiseEpoch = null;
        this.userInfoPromiseForce = false;
      }
    });
    this.userInfoPromise = operation;
    this.userInfoPromiseEpoch = epoch;
    this.userInfoPromiseForce = force;
    return operation;
  }

  async ensureFreshUserInfo(options = {}) {
    const epoch = this.authEpoch;
    const force = options?.force === true;
    const activeOperation =
      this.userInfoPromise && this.userInfoPromiseEpoch === epoch
        ? this.userInfoPromise
        : null;
    const activeWasForced = this.userInfoPromiseForce;
    return activeOperation
      ? activeOperation.then((result) =>
          force && !activeWasForced ? this.ensureFreshUserInfo(options) : result,
        )
      : this.beginUserInfoOperation(options, epoch);
  }

  async performEnsureFreshUserInfo({ force = false } = {}, epoch = this.authEpoch) {
    this.assertAuthEpoch(epoch);
    const current = this.tokenStore.getPassport();
    if (!current) return this.tokenStore.getAuthState();
    const now = Number(this.now());
    if (!force && now - current.profileCheckedAt < PROFILE_RECHECK_MS) {
      return current.account;
    }
    if (!current.accessToken || current.expiresAt <= now + ACCESS_SAFETY_WINDOW_MS) {
      const refreshed = await this.refresh();
      if (!force || refreshed?.profileVerified !== false) return refreshed.account || null;
      this.assertAuthEpoch(epoch);
      return this.performEnsureFreshUserInfo({ force: true }, epoch);
    }
    try {
      const discovery = await this.loadDiscovery();
      const profile = await this.fetchUserInfo(
        discovery,
        current.accessToken,
        current.account.passport_user_id,
      );
      this.assertAuthEpoch(epoch);
      const latest = this.tokenStore.getPassport();
      if (!latest || latest.account.passport_user_id !== current.account.passport_user_id) {
        throw new PassportAuthError("AUTH_CANCELLED", "认证操作已取消");
      }
      const account = this.accountForProfile(profile, latest.account);
      this.storePassportSession({
        ...latest,
        profileCheckedAt: Number(this.now()),
        account,
      }, epoch);
      this.scheduleProfileRecheck(Number(this.now()));
      this.notify({
        success: true,
        event: "profile-updated",
        ...this.tokenStore.getAuthState(),
      });
      return account;
    } catch (error) {
      if (error?.code === "AUTH_CANCELLED") throw error;
      this.assertAuthEpoch(epoch);
      if (authRequired(error)) {
        const latest = this.tokenStore.getPassport();
        if (
          !latest ||
          latest.issuer !== current.issuer ||
          latest.account?.passport_user_id !== current.account?.passport_user_id ||
          latest.refreshToken !== current.refreshToken ||
          latest.accessToken !== current.accessToken
        ) {
          throw new PassportAuthError("AUTH_CANCELLED", "认证操作已取消");
        }
        await this.invalidatePassportSession();
      }
      throw error;
    }
  }

  async ensureSessionReady({ forceProfile = false } = {}) {
    let passport = this.tokenStore.getPassport();
    if (!passport) return this.tokenStore.getAuthState();
    const now = Number(this.now());
    let profileVerifiedDuringCall = false;
    if (!passport.accessToken || passport.expiresAt <= now + ACCESS_SAFETY_WINDOW_MS) {
      const refreshed = await this.refresh();
      profileVerifiedDuringCall = refreshed?.profileVerified !== false;
      passport = this.tokenStore.getPassport();
    }
    if (
      passport &&
      !profileVerifiedDuringCall &&
      (forceProfile || Number(this.now()) - passport.profileCheckedAt >= PROFILE_RECHECK_MS)
    ) {
      await this.ensureFreshUserInfo({ force: forceProfile });
    }
    return this.tokenStore.getAuthState();
  }

  async getAuthState() {
    try {
      await this.ensureSessionReady();
    } catch (error) {
      if (!error?.retryable) this.log("warn", "通行证资料复核失败", { code: error?.code });
    }
    return { success: true, ...this.tokenStore.getAuthState() };
  }

  async handleForeground() {
    const current = this.tokenStore.getPassport();
    if (!current) return this.tokenStore.getAuthState();
    await this.ensureFreshUserInfo({ force: true });
    return this.tokenStore.getAuthState();
  }

  async openAccountCenter() {
    try {
      await this.openExternal(`${OIDC_ISSUER}/account`);
      return { success: true };
    } catch (error) {
      throw new PassportAuthError("BROWSER_OPEN_FAILED", "无法打开望三通行证账号中心", {
        cause: error,
      });
    }
  }

  beginLogoutOperation() {
    const operation = this.performLogout().finally(() => {
      if (this.logoutPromise === operation) {
        this.logoutPromise = null;
        this.logoutPromiseKey = null;
      }
    });
    this.logoutPromise = operation;
    // performLogout destroys local credentials synchronously. Capture both the
    // auth epoch and provider generations after that clear so a later Passport
    // or legacy login cannot accidentally reuse this operation.
    this.logoutPromiseKey = this.currentAuthOperationKey();
    return operation;
  }

  currentAuthOperationKey() {
    const passportGeneration = this.tokenStore.getProviderGeneration?.("passport") ?? "x";
    const legacyGeneration = this.tokenStore.getProviderGeneration?.("legacy") ?? "x";
    return `${this.authEpoch}:${passportGeneration}:${legacyGeneration}`;
  }

  async logout() {
    const activeOperation =
      this.logoutPromise && this.logoutPromiseKey === this.currentAuthOperationKey()
        ? this.logoutPromise
        : null;
    return activeOperation || this.beginLogoutOperation();
  }

  queueRefreshTokenRevocation(tokenToRevoke) {
    this.pendingRevocationTokens.add(tokenToRevoke);
    void this.revokeRefreshToken(tokenToRevoke);
  }

  drainPendingRevocations() {
    for (const token of this.pendingRevocationTokens) {
      void this.revokeRefreshToken(token);
    }
  }

  revokeRefreshToken(tokenToRevoke) {
    const existing = this.revocationPromises.get(tokenToRevoke);
    if (existing) {
      return existing;
    }
    const operation = this.performRevokeRefreshToken(tokenToRevoke).finally(() => {
      this.revocationPromises.delete(tokenToRevoke);
    });
    this.revocationPromises.set(tokenToRevoke, operation);
    return operation;
  }

  async performRevokeRefreshToken(tokenToRevoke) {
    try {
      const discovery = await this.loadDiscovery();
      await this.requestJson(discovery.revocationEndpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          token: tokenToRevoke,
        }).toString(),
      });
      this.pendingRevocationTokens.delete(tokenToRevoke);
    } catch (error) {
      this.log("warn", "通行证 refresh token 撤销未完成", {
        code: error?.code || "PASSPORT_UNAVAILABLE",
      });
    }
  }

  async performLogout() {
    const passport = this.tokenStore.getPassport();
    if (passport?.refreshToken) this.pendingRevocationTokens.add(passport.refreshToken);
    // Invalidate every callback/refresh/userinfo operation before clearing local
    // credentials so a delayed network response cannot resurrect the session.
    this.invalidateAuthOperations();

    // Local session destruction is authoritative and happens before any network I/O.
    const locallyCleared = this.tokenStore.clear();
    // Even a partial deletion can lose the only durable handle to this central
    // family. Start best-effort revocation after the local deletion attempt,
    // while still reporting the local failure accurately to the renderer.
    this.drainPendingRevocations();
    if (!locallyCleared) {
      this.log("warn", "本地认证凭据删除失败", { code: "LOCAL_LOGOUT_FAILED" });
      return {
        success: false,
        code: "LOCAL_LOGOUT_FAILED",
        error: "无法清除本地登录凭据，请重试",
        globalLogout: false,
      };
    }
    this.notify({
      success: true,
      event: "local-logout",
      loggedIn: false,
      provider: null,
      account: null,
    });

    // Revocation is deliberately detached from the local logout result. The
    // next login/logout generation must never wait on an older network call.
    return { success: true, globalLogout: false };
  }
}

// Access tokens are 15 minutes; refresh or revalidate before the final minute.
const ACCESS_SAFETY_WINDOW_MS = 60 * 1000;

module.exports = { PassportAuthManager };
