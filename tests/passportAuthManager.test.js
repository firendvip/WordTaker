import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  CLIENT_ID,
  OIDC_ISSUER,
  REDIRECT_URI,
  REQUESTED_SCOPE,
} = require("../src/helpers/passportOidc.js");
const { PassportAuthManager } = require("../src/helpers/passportAuthManager.js");

const PASSPORT_USER_ID = "b118e5a6-1258-4d1d-9e42-a25306d3085a";
const CENTRAL_SESSION_ID = "f430586a-5aad-49a1-85f8-1bb4102f32a6";
const NOW_MS = 1_800_000_000_000;

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => JSON.stringify(body),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signedJwt(privateKey, payload) {
  const input = `${encode({ alg: "RS256", kid: "manager-test", typ: "JWT" })}.${encode(payload)}`;
  return `${input}.${signBytes("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

function memoryStore(events = [], options = {}) {
  let passport = options.passport ? structuredClone(options.passport) : null;
  let legacy = options.legacy === undefined
    ? { accessToken: "legacy-token", account: { userId: "42", nickname: "旧账号" } }
    : options.legacy;
  const generations = { passport: 0, legacy: 0 };
  const clearResults = Array.isArray(options.clearResults) ? [...options.clearResults] : null;
  return {
    getPassport: () => passport,
    getLegacy: () => legacy,
    setPassport: vi.fn((value) => {
      events.push("store-passport");
      const stored = options.setPassportResult ?? true;
      if (stored) {
        passport = structuredClone(value);
        generations.passport += 1;
      }
      return stored;
    }),
    setPassportRefreshToken: vi.fn((expectedRefreshToken, nextRefreshToken) => {
      if (
        options.setPassportRefreshTokenResult === false ||
        !passport ||
        passport.refreshToken !== expectedRefreshToken
      ) {
        return false;
      }
      passport = { ...passport, refreshToken: nextRefreshToken };
      events.push("store-refresh-token");
      generations.passport += 1;
      return true;
    }),
    quarantinePassportRefreshToken: vi.fn((expectedRefreshToken) => {
      if (
        options.quarantinePassportRefreshTokenResult === false ||
        !passport ||
        passport.refreshToken !== expectedRefreshToken
      ) return false;
      passport = { ...passport, refreshOutcomeUnknown: true };
      events.push("quarantine-refresh-token");
      generations.passport += 1;
      return true;
    }),
    setLegacy: vi.fn((value) => {
      legacy = structuredClone(value);
      generations.legacy += 1;
      return true;
    }),
    clearPassport: vi.fn(() => {
      passport = null;
      events.push("clear-passport");
      if (options.clearPassportResult ?? true) generations.passport += 1;
      return options.clearPassportResult ?? true;
    }),
    clear: vi.fn(() => {
      passport = null;
      legacy = null;
      events.push("clear-all");
      generations.passport += 1;
      generations.legacy += 1;
      return clearResults?.length ? clearResults.shift() : (options.clearResult ?? true);
    }),
    getProviderGeneration: (provider) => generations[provider] ?? null,
    getAuthState: () =>
      passport
        ? { loggedIn: true, provider: "passport", account: passport.account }
        : legacy
          ? { loggedIn: true, provider: "legacy", account: legacy.account }
          : { loggedIn: false, provider: null, account: null },
  };
}

function discovery() {
  return {
    issuer: OIDC_ISSUER,
    authorization_endpoint: `${OIDC_ISSUER}/discovered/authorize`,
    token_endpoint: `${OIDC_ISSUER}/discovered/token`,
    userinfo_endpoint: `${OIDC_ISSUER}/discovered/userinfo`,
    jwks_uri: `${OIDC_ISSUER}/discovered/jwks`,
    revocation_endpoint: `${OIDC_ISSUER}/discovered/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: REQUESTED_SCOPE.split(" "),
  };
}

function seededPassport(overrides = {}) {
  return {
    accessToken: "persisted-access-token",
    refreshToken: `opaque-refresh~${"R".repeat(43)}`,
    expiresAt: NOW_MS + 900_000,
    scope: REQUESTED_SCOPE,
    centralSessionId: CENTRAL_SESSION_ID,
    profileCheckedAt: NOW_MS,
    account: {
      passport_user_id: PASSPORT_USER_ID,
      nickname: "望三用户",
      picture: null,
      profile_version: 3,
      authProvider: "passport",
    },
    ...overrides,
  };
}

async function completeLogin({ manager, openExternal }) {
  await manager.startLogin();
  const authorizationUrl = new URL(openExternal.mock.calls[0][0]);
  return manager.handleCallback(
    `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${authorizationUrl.searchParams.get("state")}`,
  );
}

function fixture({
  userinfoStatus = 200,
  userinfoStatuses,
  profileVersions,
  profileNames,
  events = [],
  storeOptions = {},
  refreshSub = PASSPORT_USER_ID,
  revokeStatus = 200,
  openFailure = null,
  onAuthResult = null,
  setTimeoutFn,
  clearTimeoutFn,
  now = NOW_MS,
} = {}) {
  const store = memoryStore(events, storeOptions);
  const openExternal = vi.fn(async () => {
    if (openFailure) throw openFailure;
  });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks = {
    keys: [{ ...publicKey.export({ format: "jwk" }), alg: "RS256", kid: "manager-test", use: "sig" }],
  };
  let userinfoCalls = 0;
  let refreshCalls = 0;
  const fetchFn = vi.fn(async (url, options = {}) => {
    if (url === `${OIDC_ISSUER}/.well-known/openid-configuration`) return jsonResponse(discovery());
    if (url === `${OIDC_ISSUER}/discovered/jwks`) return jsonResponse(jwks);
    if (url === `${OIDC_ISSUER}/discovered/token`) {
      const body = new URLSearchParams(options.body);
      const isRefresh = body.get("grant_type") === "refresh_token";
      const nonce = openExternal.mock.calls[0]
        ? new URL(openExternal.mock.calls[0][0]).searchParams.get("nonce")
        : null;
      const base = {
        iss: OIDC_ISSUER,
        aud: CLIENT_ID,
        sub: isRefresh ? refreshSub : PASSPORT_USER_ID,
        iat: now / 1000,
      };
      if (isRefresh) {
        refreshCalls += 1;
        return jsonResponse({
          access_token: signedJwt(privateKey, {
            ...base,
            exp: now / 1000 + 900,
            token_use: "access",
            scope: REQUESTED_SCOPE,
            sid: CENTRAL_SESSION_ID,
            jti: "3793bbfa-7c55-47b4-adb3-cb95f47ef915",
          }),
          refresh_token: `opaque-refresh~${"S".repeat(43)}`,
          token_type: "Bearer",
          expires_in: 900,
          scope: REQUESTED_SCOPE,
        });
      }
      return jsonResponse({
        access_token: signedJwt(privateKey, {
          ...base,
          exp: now / 1000 + 900,
          token_use: "access",
          scope: REQUESTED_SCOPE,
          sid: CENTRAL_SESSION_ID,
          jti: "8cb4dcc4-8a53-4440-8a2e-b12103b55fde",
        }),
        id_token: signedJwt(privateKey, {
          ...base,
          exp: now / 1000 + 300,
          token_use: "id",
          nonce,
          auth_time: now / 1000,
          sid: CENTRAL_SESSION_ID,
          jti: "0f13be9a-e100-4377-b43e-a2599aaf472d",
        }),
        refresh_token: `opaque-refresh~${"R".repeat(43)}`,
        token_type: "Bearer",
        expires_in: 900,
        scope: REQUESTED_SCOPE,
      });
    }
    if (url === `${OIDC_ISSUER}/discovered/userinfo`) {
      userinfoCalls += 1;
      const status = userinfoStatuses?.[userinfoCalls - 1] ?? userinfoStatus;
      if (status !== 200) return jsonResponse({ error: "invalid_token" }, status);
      const subject = userinfoCalls > 1 ? refreshSub : PASSPORT_USER_ID;
      return jsonResponse({
        sub: subject,
        name: profileNames?.[userinfoCalls - 1] ?? "望三用户",
        picture: `${OIDC_ISSUER}/api/profile/avatar/${subject}?v=3`,
        profile_version: profileVersions?.[userinfoCalls - 1] ?? 3,
      });
    }
    if (url === `${OIDC_ISSUER}/discovered/revoke`) {
      events.push("revoke");
      return jsonResponse(revokeStatus === 200 ? {} : { error: "server_error" }, revokeStatus);
    }
    throw new Error(`unexpected URL ${url}`);
  });
  let randomCounter = 0;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const manager = new PassportAuthManager({
    tokenStore: store,
    openExternal,
    fetchFn,
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, ++randomCounter),
    logger,
    onAuthResult,
    setTimeoutFn: setTimeoutFn || (() => 1),
    clearTimeoutFn: clearTimeoutFn || (() => undefined),
  });
  return {
    manager,
    store,
    openExternal,
    fetchFn,
    logger,
    getUserinfoCalls: () => userinfoCalls,
    getRefreshCalls: () => refreshCalls,
  };
}

describe("PassportAuthManager", () => {
  it("opens only the discovered authorization endpoint in the system browser and completes tokens in main", async () => {
    const { manager, store, openExternal, fetchFn } = fixture();

    await expect(manager.startLogin()).resolves.toEqual({ success: true, pending: true });
    const authorizationUrl = new URL(openExternal.mock.calls[0][0]);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${OIDC_ISSUER}/discovered/authorize`);
    expect(authorizationUrl.searchParams.get("code_verifier")).toBeNull();
    expect(authorizationUrl.searchParams.get("client_secret")).toBeNull();

    const result = await manager.handleCallback(
      `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${authorizationUrl.searchParams.get("state")}`,
    );
    expect(result).toMatchObject({
      success: true,
      loggedIn: true,
      provider: "passport",
      account: { passport_user_id: PASSPORT_USER_ID, nickname: "望三用户" },
    });
    expect(store.setPassport).toHaveBeenCalledWith(
      expect.objectContaining({
        centralSessionId: CENTRAL_SESSION_ID,
        account: expect.objectContaining({ passport_user_id: PASSPORT_USER_ID }),
      }),
    );

    const tokenCall = fetchFn.mock.calls.find(([url]) => url.endsWith("/discovered/token"));
    const tokenBody = new URLSearchParams(tokenCall[1].body);
    expect(tokenCall[1].headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(tokenBody.get("client_id")).toBe(CLIENT_ID);
    expect(tokenBody.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(tokenBody.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenBody.has("client_secret")).toBe(false);
  });

  it("revokes the replaced refresh family only after interactive reauthentication commits", async () => {
    const oldRefreshToken = `opaque-refresh~${"Q".repeat(43)}`;
    const context = fixture({
      storeOptions: {
        passport: seededPassport({
          accessToken: null,
          expiresAt: 0,
          refreshToken: oldRefreshToken,
          refreshOutcomeUnknown: true,
        }),
      },
    });

    await expect(completeLogin(context)).resolves.toMatchObject({
      success: true,
      provider: "passport",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.store.getPassport()?.refreshToken).toBe(`opaque-refresh~${"R".repeat(43)}`);
    const revokeCall = context.manager.fetchFn.mock.calls.find(([url]) =>
      url.endsWith("/discovered/revoke"),
    );
    expect(new URLSearchParams(revokeCall?.[1]?.body || "").get("token")).toBe(oldRefreshToken);
  });

  it("preserves the existing Passport session when a replacement callback fails", async () => {
    const oldRefreshToken = `opaque-refresh~${"Q".repeat(43)}`;
    const oldSession = seededPassport({ refreshToken: oldRefreshToken });

    const invalidGrant = fixture({ storeOptions: { passport: oldSession } });
    await invalidGrant.manager.startLogin();
    const invalidGrantUrl = new URL(invalidGrant.openExternal.mock.calls.at(-1)[0]);
    const invalidGrantFetch = invalidGrant.manager.fetchFn;
    invalidGrant.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "authorization_code") {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      return invalidGrantFetch(url, options);
    });
    await expect(
      invalidGrant.manager.handleCallback(
        `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${invalidGrantUrl.searchParams.get("state")}`,
      ),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(invalidGrant.store.getPassport()?.refreshToken).toBe(oldRefreshToken);

    const invalidProfile = fixture({ storeOptions: { passport: oldSession } });
    await invalidProfile.manager.startLogin();
    const invalidProfileUrl = new URL(invalidProfile.openExternal.mock.calls.at(-1)[0]);
    const invalidProfileFetch = invalidProfile.manager.fetchFn;
    invalidProfile.manager.fetchFn = vi.fn(async (url, options = {}) =>
      url.endsWith("/discovered/userinfo")
        ? jsonResponse({ sub: "3793bbfa-7c55-47b4-adb3-cb95f47ef915", name: "错误账号", profile_version: 1 })
        : invalidProfileFetch(url, options),
    );
    await expect(
      invalidProfile.manager.handleCallback(
        `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${invalidProfileUrl.searchParams.get("state")}`,
      ),
    ).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" });
    expect(invalidProfile.store.getPassport()?.refreshToken).toBe(oldRefreshToken);

    const storageFailure = fixture({
      storeOptions: { passport: oldSession, setPassportResult: false },
    });
    await storageFailure.manager.startLogin();
    const storageFailureUrl = new URL(storageFailure.openExternal.mock.calls.at(-1)[0]);
    await expect(
      storageFailure.manager.handleCallback(
        `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${storageFailureUrl.searchParams.get("state")}`,
      ),
    ).rejects.toMatchObject({ code: "SECURE_STORAGE_REQUIRED" });
    expect(storageFailure.store.getPassport()?.refreshToken).toBe(oldRefreshToken);

    for (const context of [invalidProfile, storageFailure]) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const revokeCall = context.manager.fetchFn.mock.calls.find(([url]) =>
        url.endsWith("/discovered/revoke"),
      );
      expect(new URLSearchParams(revokeCall?.[1]?.body || "").get("token")).toBe(
        `opaque-refresh~${"R".repeat(43)}`,
      );
    }
  });

  it("rejects a mismatched state before making any token request or changing credentials", async () => {
    const { manager, store, fetchFn } = fixture();
    await manager.startLogin();

    await expect(
      manager.handleCallback(`${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=wrong-state-value`),
    ).rejects.toThrow(/state/i);
    expect(fetchFn.mock.calls.some(([url]) => url.endsWith("/discovered/token"))).toBe(false);
    expect(store.setPassport).not.toHaveBeenCalled();
  });

  it("refreshes global profile at most every five minutes unless forced", async () => {
    const { manager, openExternal, getUserinfoCalls } = fixture();
    await manager.startLogin();
    const authorizationUrl = new URL(openExternal.mock.calls[0][0]);
    await manager.handleCallback(
      `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${authorizationUrl.searchParams.get("state")}`,
    );
    expect(getUserinfoCalls()).toBe(1);
    await manager.ensureFreshUserInfo();
    expect(getUserinfoCalls()).toBe(1);
    await manager.ensureFreshUserInfo({ force: true });
    expect(getUserinfoCalls()).toBe(2);
    await manager.ensureSessionReady({ forceProfile: true });
    expect(getUserinfoCalls()).toBe(3);
  });

  it("escalates a forced profile proof queued behind a cache-only normal check", async () => {
    const context = fixture({ storeOptions: { passport: seededPassport() } });
    const before = context.getUserinfoCalls();
    const normalCheck = context.manager.ensureFreshUserInfo();
    const forcedCheck = context.manager.ensureFreshUserInfo({ force: true });
    await Promise.all([normalCheck, forcedCheck]);
    expect(context.getUserinfoCalls()).toBe(before + 1);
  });

  it("schedules the five-minute profile recheck independently from access refresh", async () => {
    const scheduled = [];
    const context = fixture({
      setTimeoutFn: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
    });
    await completeLogin(context);
    const profileTimer = scheduled.find(({ delay }) => delay === 5 * 60 * 1000);
    expect(profileTimer).toBeTruthy();
    const before = context.getUserinfoCalls();
    profileTimer.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.getUserinfoCalls()).toBe(before + 1);
  });

  it("does not reschedule an automatic refresh retry after the session is cleared", async () => {
    const scheduled = [];
    const context = fixture({
      storeOptions: { passport: seededPassport() },
      setTimeoutFn: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
    });
    context.manager.refresh = vi.fn(async () => {
      throw Object.assign(new Error("offline"), { retryable: true });
    });
    context.manager.scheduleRefresh(NOW_MS + 900_000);
    const refreshTimer = scheduled.at(-1);
    context.store.clearPassport();
    refreshTimer.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduled).toHaveLength(1);
  });

  it("leaves no local session and revokes the new family when callback userinfo returns 401", async () => {
    const { manager, store, openExternal, fetchFn } = fixture({ userinfoStatus: 401 });
    await manager.startLogin();
    const authorizationUrl = new URL(openExternal.mock.calls[0][0]);
    await expect(
      manager.handleCallback(
        `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${authorizationUrl.searchParams.get("state")}`,
      ),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(store.getPassport()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const revokeCall = fetchFn.mock.calls.find(([url]) => url.endsWith("/discovered/revoke"));
    expect(new URLSearchParams(revokeCall?.[1]?.body || "").get("token")).toBe(
      `opaque-refresh~${"R".repeat(43)}`,
    );
  });

  it("revokes valid refresh-token candidates from otherwise malformed token responses", async () => {
    const callback = fixture();
    const callbackFetch = callback.manager.fetchFn;
    callback.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "authorization_code") {
        return jsonResponse({
          access_token: "malformed",
          id_token: "malformed",
          refresh_token: `opaque-refresh~${"C".repeat(43)}`,
          token_type: "NotBearer",
          expires_in: 900,
          scope: REQUESTED_SCOPE,
        });
      }
      return callbackFetch(url, options);
    });
    await callback.manager.startLogin();
    const callbackState = new URL(callback.openExternal.mock.calls[0][0]).searchParams.get("state");
    await expect(
      callback.manager.handleCallback(
        `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${callbackState}`,
      ),
    ).rejects.toMatchObject({ code: "INVALID_TOKEN_RESPONSE" });

    const refresh = fixture({
      storeOptions: { passport: seededPassport({ accessToken: null, expiresAt: 0 }) },
    });
    const refreshFetch = refresh.manager.fetchFn;
    refresh.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "refresh_token") {
        return jsonResponse({
          access_token: "malformed",
          refresh_token: `opaque-refresh~${"D".repeat(43)}`,
          token_type: "NotBearer",
          expires_in: 900,
          scope: REQUESTED_SCOPE,
        });
      }
      return refreshFetch(url, options);
    });
    await expect(refresh.manager.refresh()).rejects.toMatchObject({
      code: "REFRESH_OUTCOME_UNKNOWN",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const callbackRevokes = callback.manager.fetchFn.mock.calls
      .filter(([url]) => url.endsWith("/discovered/revoke"))
      .map(([, options]) => new URLSearchParams(options.body).get("token"));
    const refreshRevokes = refresh.manager.fetchFn.mock.calls
      .filter(([url]) => url.endsWith("/discovered/revoke"))
      .map(([, options]) => new URLSearchParams(options.body).get("token"));
    expect(callbackRevokes).toContain(`opaque-refresh~${"C".repeat(43)}`);
    expect(refreshRevokes).toContain(`opaque-refresh~${"D".repeat(43)}`);
  });

  it("destroys the local session before best-effort refresh-token revocation and is idempotent", async () => {
    const events = [];
    const { manager, store, openExternal } = fixture({ events });
    await manager.startLogin();
    const authorizationUrl = new URL(openExternal.mock.calls[0][0]);
    await manager.handleCallback(
      `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${authorizationUrl.searchParams.get("state")}`,
    );
    events.length = 0;

    await expect(manager.logout()).resolves.toEqual({ success: true, globalLogout: false });
    expect(events.slice(0, 2)).toEqual(["clear-all", "revoke"]);
    expect(store.clear).toHaveBeenCalledOnce();
    await expect(manager.logout()).resolves.toEqual({ success: true, globalLogout: false });
    expect(events.filter((event) => event === "revoke")).toHaveLength(1);
  });

  it("keeps an unmatched callback from cancelling the real transaction and rejects replay", async () => {
    const context = fixture();
    await context.manager.startLogin();
    const authorizationUrl = new URL(context.openExternal.mock.calls[0][0]);
    await expect(
      context.manager.handleCallback(
        `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=wrong-state-value`,
      ),
    ).rejects.toMatchObject({ code: "STATE_MISMATCH" });

    const callback = `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${authorizationUrl.searchParams.get("state")}`;
    await expect(context.manager.handleCallback(callback)).resolves.toMatchObject({ success: true });
    const tokenCalls = context.fetchFn.mock.calls.filter(([url]) => url.endsWith("/discovered/token"));
    await expect(context.manager.handleCallback(callback)).rejects.toMatchObject({ code: "NO_AUTH_REQUEST" });
    expect(context.fetchFn.mock.calls.filter(([url]) => url.endsWith("/discovered/token"))).toHaveLength(
      tokenCalls.length,
    );
  });

  it("consumes a state-validated cancellation and permits a fresh login", async () => {
    const context = fixture();
    await context.manager.startLogin();
    const state = new URL(context.openExternal.mock.calls[0][0]).searchParams.get("state");
    await expect(
      context.manager.handleCallback(`${REDIRECT_URI}?error=access_denied&state=${state}`),
    ).rejects.toMatchObject({ code: "access_denied" });
    await expect(context.manager.startLogin()).resolves.toMatchObject({ pending: true });
  });

  it("prevents overlapping browser transactions, reports timeout and handles browser failure", async () => {
    const notifications = [];
    let loginTimeout;
    const context = fixture({
      onAuthResult: (result) => notifications.push(result),
      setTimeoutFn: (callback, delay) => {
        if (delay === 10 * 60 * 1000) loginTimeout = callback;
        return delay;
      },
    });
    await context.manager.startLogin();
    await expect(context.manager.startLogin()).rejects.toMatchObject({ code: "AUTH_IN_PROGRESS" });
    loginTimeout();
    expect(notifications).toContainEqual({
      success: false,
      code: "AUTH_TIMEOUT",
      error: "统一登录等待超时，请重试",
    });
    await expect(context.manager.startLogin()).resolves.toMatchObject({ pending: true });

    const failed = fixture({ openFailure: new Error("browser unavailable") });
    await expect(failed.manager.startLogin()).rejects.toMatchObject({ code: "BROWSER_OPEN_FAILED" });
    expect(failed.manager.pending).toBeNull();

    let staleTimer;
    const stale = fixture({
      setTimeoutFn: (callback, delay) => {
        if (delay === 10 * 60 * 1000) staleTimer = callback;
        return delay;
      },
    });
    await stale.manager.startLogin();
    stale.manager.clearPending();
    expect(() => staleTimer()).not.toThrow();
  });

  it("cancels browser login when local logout wins the discovery race", async () => {
    const context = fixture();
    const originalFetch = context.manager.fetchFn;
    const discoveryEntered = deferred();
    const releaseDiscovery = deferred();
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      if (url.endsWith("/.well-known/openid-configuration")) {
        discoveryEntered.resolve();
        await releaseDiscovery.promise;
      }
      return originalFetch(url, options);
    });

    const login = context.manager.startLogin();
    const rejected = expect(login).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    await discoveryEntered.promise;
    await context.manager.logout();
    releaseDiscovery.resolve();
    await rejected;
    expect(context.openExternal).not.toHaveBeenCalled();
    expect(context.manager.pending).toBeNull();
  });

  it("does not let an older refresh failure cancel a newer browser login", async () => {
    const context = fixture({
      storeOptions: { passport: seededPassport({ accessToken: null, expiresAt: 0 }) },
    });
    const originalFetch = context.manager.fetchFn;
    const refreshEntered = deferred();
    const releaseRefresh = deferred();
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "refresh_token") {
        refreshEntered.resolve();
        await releaseRefresh.promise;
        return jsonResponse({ error: "invalid_grant" }, 401);
      }
      return originalFetch(url, options);
    });

    const oldRefresh = context.manager.refresh();
    const refreshRejected = expect(oldRefresh).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    await refreshEntered.promise;
    await context.manager.startLogin();
    const authorizationUrl = new URL(context.openExternal.mock.calls.at(-1)[0]);
    const newerRefresh = context.manager.refresh();
    const newerRejected = expect(newerRefresh).rejects.toMatchObject({
      code: "AUTH_IN_PROGRESS",
    });

    releaseRefresh.resolve();
    await Promise.all([refreshRejected, newerRejected]);
    await expect(
      context.manager.handleCallback(
        `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${authorizationUrl.searchParams.get("state")}`,
      ),
    ).resolves.toMatchObject({ success: true, provider: "passport" });
  });

  it("does not quarantine or send a refresh token after discovery crosses a login epoch", async () => {
    const context = fixture({
      storeOptions: { passport: seededPassport({ accessToken: null, expiresAt: 0 }) },
    });
    const resolvedDiscovery = await context.manager.loadDiscovery();
    const refreshDiscoveryEntered = deferred();
    const releaseRefreshDiscovery = deferred();
    let discoveryCalls = 0;
    context.manager.loadDiscovery = vi.fn(async () => {
      discoveryCalls += 1;
      if (discoveryCalls === 1) {
        refreshDiscoveryEntered.resolve();
        await releaseRefreshDiscovery.promise;
      }
      return resolvedDiscovery;
    });

    const oldRefresh = context.manager.refresh();
    const rejected = expect(oldRefresh).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    await refreshDiscoveryEntered.promise;
    await context.manager.startLogin();
    releaseRefreshDiscovery.resolve();
    await rejected;

    expect(context.store.quarantinePassportRefreshToken).not.toHaveBeenCalled();
    const refreshCalls = context.manager.fetchFn.mock.calls.filter(([, options]) =>
      String(options?.body || "").includes("grant_type=refresh_token"),
    );
    expect(refreshCalls).toHaveLength(0);
    expect(context.store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"R".repeat(43)}`,
    });
    expect(context.store.getPassport()).not.toHaveProperty("refreshOutcomeUnknown");

    const identityRace = fixture({
      storeOptions: { passport: seededPassport({ accessToken: null, expiresAt: 0 }) },
    });
    const identityDiscovery = await identityRace.manager.loadDiscovery();
    const identityDiscoveryEntered = deferred();
    const releaseIdentityDiscovery = deferred();
    identityRace.manager.loadDiscovery = vi.fn(async () => {
      identityDiscoveryEntered.resolve();
      await releaseIdentityDiscovery.promise;
      return identityDiscovery;
    });
    const identityRefresh = identityRace.manager.refresh();
    const identityRejected = expect(identityRefresh).rejects.toMatchObject({
      code: "AUTH_CANCELLED",
    });
    await identityDiscoveryEntered.promise;
    identityRace.store.setPassport(seededPassport({
      account: {
        ...seededPassport().account,
        passport_user_id: "3793bbfa-7c55-47b4-adb3-cb95f47ef915",
      },
    }));
    releaseIdentityDiscovery.resolve();
    await identityRejected;
    expect(identityRace.store.quarantinePassportRefreshToken).not.toHaveBeenCalled();
  });

  it("safely commits a consumed refresh rotation before yielding to a newer login", async () => {
    const context = fixture({ storeOptions: { passport: seededPassport() } });
    const originalFetch = context.manager.fetchFn;
    const refreshEntered = deferred();
    const releaseRefresh = deferred();
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "refresh_token") {
        refreshEntered.resolve();
        await releaseRefresh.promise;
      }
      return originalFetch(url, options);
    });

    const oldRefresh = context.manager.refresh();
    const refreshRejected = expect(oldRefresh).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    await refreshEntered.promise;
    await context.manager.startLogin();
    const authorizationUrl = new URL(context.openExternal.mock.calls.at(-1)[0]);

    releaseRefresh.resolve();
    await refreshRejected;
    expect(context.store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"S".repeat(43)}`,
      account: { passport_user_id: PASSPORT_USER_ID },
    });
    const revokedTokens = context.manager.fetchFn.mock.calls
      .filter(([url]) => url.endsWith("/discovered/revoke"))
      .map(([, options]) => new URLSearchParams(options.body).get("token"));
    expect(revokedTokens).not.toContain(`opaque-refresh~${"S".repeat(43)}`);
    await expect(
      context.manager.handleCallback(
        `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${authorizationUrl.searchParams.get("state")}`,
      ),
    ).resolves.toMatchObject({ success: true });
  });

  it("keeps the rotated family when a stale-epoch access commit cannot persist", async () => {
    const context = fixture({
      storeOptions: { passport: seededPassport(), setPassportResult: false },
    });
    const originalFetch = context.manager.fetchFn;
    const refreshEntered = deferred();
    const releaseRefresh = deferred();
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "refresh_token") {
        refreshEntered.resolve();
        await releaseRefresh.promise;
      }
      return originalFetch(url, options);
    });

    const oldRefresh = context.manager.refresh();
    const rejected = expect(oldRefresh).rejects.toMatchObject({
      code: "AUTH_CANCELLED",
    });
    await refreshEntered.promise;
    await context.manager.startLogin();
    releaseRefresh.resolve();
    await rejected;
    expect(context.store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"S".repeat(43)}`,
    });
    const revokedTokens = context.manager.fetchFn.mock.calls
      .filter(([url]) => url.endsWith("/discovered/revoke"))
      .map(([, options]) => new URLSearchParams(options.body).get("token"));
    expect(revokedTokens).not.toContain(`opaque-refresh~${"S".repeat(43)}`);
    expect(context.manager.pending).not.toBeNull();
  });

  it("never replays the same refresh family across an authorization epoch", async () => {
    const context = fixture({
      storeOptions: {
        passport: seededPassport({ accessToken: null, expiresAt: 0 }),
      },
    });
    const originalFetch = context.manager.fetchFn;
    const refreshEntered = deferred();
    const releaseRefresh = deferred();
    let refreshRequests = 0;
    let inFlightMarkerSeen = false;
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "refresh_token") {
        inFlightMarkerSeen = context.store.getPassport()?.refreshOutcomeUnknown === true;
        refreshRequests += 1;
        refreshEntered.resolve();
        await releaseRefresh.promise;
      }
      return originalFetch(url, options);
    });

    const oldRefresh = context.manager.refresh().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await refreshEntered.promise;
    expect(inFlightMarkerSeen).toBe(true);
    await context.manager.startLogin();
    const sessionReady = context.manager.ensureSessionReady({ forceProfile: true }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const requestsBeforeRelease = refreshRequests;

    releaseRefresh.resolve();
    const [oldOutcome, readyOutcome] = await Promise.all([oldRefresh, sessionReady]);
    expect(oldOutcome.error).toMatchObject({ code: "AUTH_CANCELLED" });
    expect(requestsBeforeRelease).toBe(1);
    expect(readyOutcome.value).toMatchObject({ provider: "passport" });
    expect(context.store.getPassport().refreshToken).toBe(`opaque-refresh~${"S".repeat(43)}`);
    expect(context.getUserinfoCalls()).toBe(1);
  });

  it("re-evaluates a settled stale refresh without reviving or replaying its family", async () => {
    const completed = fixture({ storeOptions: { passport: seededPassport() } });
    const olderSuccess = deferred();
    completed.manager.refreshPromise = olderSuccess.promise;
    completed.manager.refreshPromiseEpoch = completed.manager.authEpoch;
    completed.manager.authEpoch += 1;
    const rechecked = completed.manager.refresh();
    olderSuccess.resolve({ success: true });
    await expect(rechecked).resolves.toMatchObject({
      success: true,
      provider: "passport",
      profileVerified: false,
    });

    const disappeared = fixture({
      storeOptions: { passport: seededPassport({ accessToken: null, expiresAt: 0 }) },
    });
    const originalFetch = disappeared.manager.fetchFn;
    const entered = deferred();
    const release = deferred();
    let requests = 0;
    disappeared.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "refresh_token") {
        requests += 1;
        entered.resolve();
        await release.promise;
      }
      return originalFetch(url, options);
    });
    const oldRefresh = disappeared.manager.refresh().catch((error) => error);
    await entered.promise;
    disappeared.manager.invalidateAuthOperations();
    disappeared.store.clearPassport();
    const newerRefresh = disappeared.manager.refresh();
    release.resolve();
    await expect(oldRefresh).resolves.toMatchObject({ code: "AUTH_CANCELLED" });
    await expect(newerRefresh).resolves.toMatchObject({ provider: "legacy" });
    expect(requests).toBe(1);

    const cancelled = fixture({
      storeOptions: { passport: seededPassport({ accessToken: null, expiresAt: 0 }) },
    });
    const cancelledFetch = cancelled.manager.fetchFn;
    const cancelledEntered = deferred();
    const cancelledRelease = deferred();
    let cancelledRequests = 0;
    cancelled.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "refresh_token") {
        cancelledRequests += 1;
        cancelledEntered.resolve();
        await cancelledRelease.promise;
        return jsonResponse({}, 503);
      }
      return cancelledFetch(url, options);
    });
    const stale = cancelled.manager.refresh().catch((error) => error);
    await cancelledEntered.promise;
    cancelled.manager.invalidateAuthOperations();
    const followup = cancelled.manager.refresh();
    cancelledRelease.resolve();
    await expect(stale).resolves.toMatchObject({ code: "AUTH_CANCELLED" });
    await expect(followup).rejects.toMatchObject({ code: "AUTH_CANCELLED", retryable: true });
    expect(cancelledRequests).toBe(1);
  });

  it("cancels login when its pending transaction changes at either browser boundary", async () => {
    const discoveryRace = fixture();
    const originalDiscovery = discoveryRace.manager.loadDiscovery.bind(discoveryRace.manager);
    const discoveryEntered = deferred();
    const releaseDiscovery = deferred();
    discoveryRace.manager.loadDiscovery = vi.fn(async () => {
      discoveryEntered.resolve();
      await releaseDiscovery.promise;
      return originalDiscovery();
    });
    const discoveryLogin = discoveryRace.manager.startLogin();
    const discoveryRejected = expect(discoveryLogin).rejects.toMatchObject({
      code: "AUTH_CANCELLED",
    });
    await discoveryEntered.promise;
    discoveryRace.manager.clearPending();
    releaseDiscovery.resolve();
    await discoveryRejected;
    expect(discoveryRace.openExternal).not.toHaveBeenCalled();

    const browserRace = fixture();
    const browserEntered = deferred();
    const releaseBrowser = deferred();
    browserRace.manager.openExternal = vi.fn(async () => {
      browserEntered.resolve();
      await releaseBrowser.promise;
    });
    const browserLogin = browserRace.manager.startLogin();
    const browserRejected = expect(browserLogin).rejects.toMatchObject({
      code: "AUTH_CANCELLED",
    });
    await browserEntered.promise;
    browserRace.manager.clearPending();
    releaseBrowser.resolve();
    await browserRejected;
  });

  it("clears a provisional transaction when discovery itself fails", async () => {
    const context = fixture();
    context.manager.loadDiscovery = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(context.manager.startLogin()).rejects.toThrow("offline");
    expect(context.manager.pending).toBeNull();
    expect(context.openExternal).not.toHaveBeenCalled();
  });

  it("restores an existing session schedule after replacement login setup fails", async () => {
    const scheduled = [];
    const context = fixture({
      openFailure: new Error("browser unavailable"),
      storeOptions: {
        passport: seededPassport({ expiresAt: 0, profileCheckedAt: 0 }),
      },
      setTimeoutFn: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
    });

    await expect(context.manager.startLogin()).rejects.toMatchObject({
      code: "BROWSER_OPEN_FAILED",
    });
    expect(scheduled.filter(({ delay }) => delay === 1_000)).toHaveLength(2);

    const pending = fixture({ storeOptions: { passport: seededPassport() } });
    await pending.manager.startLogin();
    const refreshTimerBefore = pending.manager.refreshTimer;
    const profileTimerBefore = pending.manager.profileTimer;
    pending.manager.resumeStoredSessionTimers();
    expect(pending.manager.refreshTimer).toBe(refreshTimerBefore);
    expect(pending.manager.profileTimer).toBe(profileTimerBefore);
  });

  it("can invalidate a Passport session without broadcasting profile data", async () => {
    const notifications = [];
    const events = [];
    const context = fixture({
      onAuthResult: (result) => notifications.push(result),
      events,
      storeOptions: { passport: seededPassport() },
    });
    await expect(
      context.manager.invalidatePassportSession({ notify: false }),
    ).resolves.toMatchObject({ provider: "legacy" });
    expect(notifications).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.slice(0, 2)).toEqual(["clear-passport", "revoke"]);
    const revokeCall = context.manager.fetchFn.mock.calls.find(([url]) =>
      url.endsWith("/discovered/revoke"),
    );
    expect(new URLSearchParams(revokeCall?.[1]?.body || "").get("token")).toBe(
      `opaque-refresh~${"R".repeat(43)}`,
    );

    const empty = fixture({ storeOptions: { passport: null } });
    await expect(
      empty.manager.invalidatePassportSession({ notify: false }),
    ).resolves.toMatchObject({ provider: "legacy" });
    expect(empty.manager.fetchFn.mock.calls.some(([url]) => url.endsWith("/discovered/revoke"))).toBe(
      false,
    );

    const blocked = fixture({
      storeOptions: {
        passport: seededPassport(),
        clearPassportResult: false,
        clearResult: false,
      },
    });
    await expect(
      blocked.manager.invalidatePassportSession({ notify: false }),
    ).rejects.toMatchObject({ code: "LOCAL_SESSION_CLEAR_FAILED" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const blockedRevoke = blocked.manager.fetchFn.mock.calls.find(([url]) =>
      url.endsWith("/discovered/revoke"),
    );
    expect(new URLSearchParams(blockedRevoke?.[1]?.body || "").get("token")).toBe(
      `opaque-refresh~${"R".repeat(43)}`,
    );
  });

  it("serializes refresh-token rotation and atomically stores the new family", async () => {
    const context = fixture();
    await completeLogin(context);
    const results = await Promise.all([
      context.manager.refresh(),
      context.manager.refresh(),
      context.manager.refresh(),
    ]);
    expect(results.every((result) => result.success)).toBe(true);
    expect(context.getRefreshCalls()).toBe(1);
    const refreshCall = context.fetchFn.mock.calls.find(([, options]) =>
      String(options?.body || "").includes("grant_type=refresh_token"),
    );
    const body = new URLSearchParams(refreshCall[1].body);
    expect(body.get("refresh_token")).toBe(`opaque-refresh~${"R".repeat(43)}`);
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.has("client_secret")).toBe(false);
    expect(context.store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"S".repeat(43)}`,
      centralSessionId: CENTRAL_SESSION_ID,
      account: { passport_user_id: PASSPORT_USER_ID, profile_version: 3 },
    });
  });

  it("does not let an older refresh cleanup clear a newer single-flight owner", async () => {
    const context = fixture({ storeOptions: { passport: seededPassport() } });
    const releaseOldRefresh = deferred();
    context.manager.performRefresh = vi.fn(async () => {
      await releaseOldRefresh.promise;
      return { success: true };
    });
    const oldRefresh = context.manager.refresh();
    const newerOwner = Promise.resolve({ success: true, owner: "new" });
    context.manager.refreshPromise = newerOwner;
    context.manager.refreshPromiseEpoch = context.manager.authEpoch;
    releaseOldRefresh.resolve();
    await expect(oldRefresh).resolves.toEqual({ success: true });
    expect(context.manager.refreshPromise).toBe(newerOwner);
  });

  it("clears only Passport when a rotated token changes identity", async () => {
    const context = fixture({ refreshSub: "3793bbfa-7c55-47b4-adb3-cb95f47ef915" });
    await completeLogin(context);
    await expect(context.manager.refresh()).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" });
    expect(context.store.clearPassport).toHaveBeenCalled();
    expect(context.store.getLegacy()).toMatchObject({ account: { userId: "42" } });
  });

  it("keeps the rotated family but refuses a regressed global profile version", async () => {
    const context = fixture({ profileVersions: [3, 2] });
    await completeLogin(context);
    context.store.clearPassport.mockClear();
    await expect(context.manager.refresh()).rejects.toMatchObject({ code: "INVALID_USERINFO" });
    expect(context.store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"S".repeat(43)}`,
      account: { profile_version: 3 },
    });
    expect(context.store.clearPassport).not.toHaveBeenCalled();
  });

  it("retries profile verification after rotated credentials survive a temporary userinfo outage", async () => {
    const scheduled = [];
    const context = fixture({
      storeOptions: { passport: seededPassport() },
      setTimeoutFn: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
    });
    const originalFetch = context.manager.fetchFn;
    context.manager.fetchFn = (url, options) =>
      url.endsWith("/discovered/userinfo")
        ? Promise.resolve(jsonResponse({}, 503))
        : originalFetch(url, options);
    await expect(context.manager.refresh()).rejects.toMatchObject({
      code: "PASSPORT_REQUEST_FAILED",
      retryable: true,
    });
    expect(context.store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"S".repeat(43)}`,
    });
    expect(scheduled.some(({ delay }) => delay === 60_000)).toBe(true);
  });

  it("does not inspect opaque refreshed access tokens through JWKS", async () => {
    const context = fixture({ storeOptions: { passport: seededPassport() } });
    const originalFetch = context.manager.fetchFn;
    context.manager.fetchFn = vi.fn(async (url, options = {}) =>
      url.endsWith("/discovered/jwks")
        ? jsonResponse({}, 503)
        : originalFetch(url, options),
    );

    await expect(context.manager.refresh()).resolves.toMatchObject({ success: true });
    expect(context.store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"S".repeat(43)}`,
      account: { passport_user_id: PASSPORT_USER_ID },
    });
    expect(context.store.clearPassport).not.toHaveBeenCalled();
  });

  it("never replays a refresh token after the token response outcome becomes unknown", async () => {
    const context = fixture({
      storeOptions: {
        passport: seededPassport({ accessToken: null, expiresAt: 0 }),
      },
    });
    const originalFetch = context.manager.fetchFn;
    let refreshRequests = 0;
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "refresh_token") {
        refreshRequests += 1;
        throw new Error("response lost after central consumption");
      }
      return originalFetch(url, options);
    });

    await expect(context.manager.refresh()).rejects.toMatchObject({
      code: "REFRESH_OUTCOME_UNKNOWN",
      retryable: false,
    });
    expect(context.store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"R".repeat(43)}`,
      refreshOutcomeUnknown: true,
    });
    await expect(context.manager.refresh()).rejects.toMatchObject({
      code: "REFRESH_OUTCOME_UNKNOWN",
      retryable: false,
    });
    expect(refreshRequests).toBe(1);
  });

  it("refuses to send a refresh token when its durable in-flight marker cannot be stored", async () => {
    const unavailable = fixture({
      storeOptions: {
        passport: seededPassport({ accessToken: null, expiresAt: 0 }),
        quarantinePassportRefreshTokenResult: false,
      },
    });
    await expect(unavailable.manager.refresh()).rejects.toMatchObject({
      code: "SECURE_STORAGE_REQUIRED",
    });
    expect(unavailable.getRefreshCalls()).toBe(0);
    expect(unavailable.store.getPassport()?.refreshToken).toBe(`opaque-refresh~${"R".repeat(43)}`);

    const missingAdapter = fixture({
      storeOptions: { passport: seededPassport({ accessToken: null, expiresAt: 0 }) },
    });
    delete missingAdapter.store.quarantinePassportRefreshToken;
    await expect(missingAdapter.manager.refresh()).rejects.toMatchObject({
      code: "SECURE_STORAGE_REQUIRED",
    });
    expect(missingAdapter.getRefreshCalls()).toBe(0);
  });

  it("quarantines a central response that fails to rotate the one-time refresh token", async () => {
    const context = fixture({ storeOptions: { passport: seededPassport() } });
    const originalFetch = context.manager.fetchFn;
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "refresh_token") {
        const response = await originalFetch(url, options);
        const payload = JSON.parse(await response.text());
        return jsonResponse({ ...payload, refresh_token: `opaque-refresh~${"R".repeat(43)}` });
      }
      return originalFetch(url, options);
    });

    await expect(context.manager.refresh()).rejects.toMatchObject({
      code: "REFRESH_OUTCOME_UNKNOWN",
    });
    expect(context.store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"R".repeat(43)}`,
      refreshOutcomeUnknown: true,
    });
    expect(context.getRefreshCalls()).toBe(1);
  });

  it("quarantines an uncertain old refresh without cancelling a newer browser login", async () => {
    const context = fixture({
      storeOptions: {
        passport: seededPassport({ accessToken: null, expiresAt: 0 }),
      },
    });
    const originalFetch = context.manager.fetchFn;
    const refreshEntered = deferred();
    const releaseRefresh = deferred();
    let refreshRequests = 0;
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "refresh_token") {
        refreshRequests += 1;
        refreshEntered.resolve();
        await releaseRefresh.promise;
        throw new Error("response lost");
      }
      return originalFetch(url, options);
    });

    const oldRefresh = context.manager.refresh();
    const oldRejected = expect(oldRefresh).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    await refreshEntered.promise;
    await context.manager.startLogin();
    const authorizationUrl = new URL(context.openExternal.mock.calls.at(-1)[0]);
    releaseRefresh.resolve();
    await oldRejected;
    expect(context.manager.pending?.state).toBe(authorizationUrl.searchParams.get("state"));
    expect(context.store.getPassport()).toMatchObject({ refreshOutcomeUnknown: true });

    await expect(
      context.manager.handleCallback(
        `${REDIRECT_URI}?error=access_denied&state=${authorizationUrl.searchParams.get("state")}`,
      ),
    ).rejects.toMatchObject({ code: "access_denied" });
    await expect(context.manager.refresh()).rejects.toMatchObject({
      code: "REFRESH_OUTCOME_UNKNOWN",
    });
    expect(refreshRequests).toBe(1);
  });

  it("does not apply a rotated access token after its durable family is replaced", async () => {
    const context = fixture({ storeOptions: { passport: seededPassport() } });
    const persistRotation = context.store.setPassportRefreshToken.getMockImplementation();
    context.store.setPassportRefreshToken.mockImplementation((expected, next) => {
      const stored = persistRotation(expected, next);
      context.store.clearPassport();
      return stored;
    });

    await expect(context.manager.refresh()).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    expect(context.store.getPassport()).toBeNull();
  });

  it("rejects a rotation when its original family is replaced before the token response", async () => {
    const context = fixture({ storeOptions: { passport: seededPassport() } });
    const originalFetch = context.manager.fetchFn;
    const refreshEntered = deferred();
    const releaseRefresh = deferred();
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "refresh_token") {
        refreshEntered.resolve();
        await releaseRefresh.promise;
      }
      return originalFetch(url, options);
    });

    const refreshing = context.manager.refresh();
    const rejected = expect(refreshing).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    await refreshEntered.promise;
    context.store.setPassport(seededPassport({
      refreshToken: `opaque-refresh~${"B".repeat(43)}`,
      refreshOutcomeUnknown: false,
      account: {
        ...seededPassport().account,
        passport_user_id: "3793bbfa-7c55-47b4-adb3-cb95f47ef915",
      },
    }));
    releaseRefresh.resolve();
    await rejected;
    expect(context.store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"B".repeat(43)}`,
      account: { passport_user_id: "3793bbfa-7c55-47b4-adb3-cb95f47ef915" },
    });
    expect(context.store.setPassportRefreshToken).not.toHaveBeenCalled();
  });

  it("does not quarantine a replacement identity for an older uncertain response", async () => {
    const context = fixture({
      storeOptions: { passport: seededPassport({ accessToken: null, expiresAt: 0 }) },
    });
    const originalFetch = context.manager.fetchFn;
    const refreshEntered = deferred();
    const releaseRefresh = deferred();
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "refresh_token") {
        refreshEntered.resolve();
        await releaseRefresh.promise;
        throw new Error("old response lost");
      }
      return originalFetch(url, options);
    });

    const oldRefresh = context.manager.refresh();
    const rejected = expect(oldRefresh).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    await refreshEntered.promise;
    context.store.setPassport(seededPassport({
      refreshToken: `opaque-refresh~${"B".repeat(43)}`,
      refreshOutcomeUnknown: false,
      account: {
        ...seededPassport().account,
        passport_user_id: "3793bbfa-7c55-47b4-adb3-cb95f47ef915",
      },
    }));
    releaseRefresh.resolve();
    await rejected;
    expect(context.store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"B".repeat(43)}`,
      refreshOutcomeUnknown: false,
    });
  });

  it("only replaces cached global profile fields when profile_version increases", async () => {
    const context = fixture({
      profileVersions: [3, 3, 4],
      profileNames: ["原昵称", "同版本伪变更", "新版本昵称"],
    });
    await completeLogin(context);
    await context.manager.ensureFreshUserInfo({ force: true });
    expect(context.store.getPassport().account).toMatchObject({
      nickname: "原昵称",
      profile_version: 3,
    });
    await context.manager.ensureFreshUserInfo({ force: true });
    expect(context.store.getPassport().account).toMatchObject({
      nickname: "新版本昵称",
      profile_version: 4,
    });
  });

  it("clears Passport after established-session userinfo returns 401", async () => {
    const notifications = [];
    const context = fixture({
      userinfoStatuses: [200, 401],
      onAuthResult: (result) => notifications.push(result),
    });
    await completeLogin(context);
    context.store.clearPassport.mockClear();
    await expect(context.manager.ensureFreshUserInfo({ force: true })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    expect(context.store.clearPassport).toHaveBeenCalledOnce();
    expect(context.store.getLegacy()).toMatchObject({ account: { userId: "42" } });
    expect(notifications.at(-1)).toMatchObject({ success: true, provider: "legacy" });
  });

  it("rejects login when secure refresh-token persistence is unavailable", async () => {
    const context = fixture({ storeOptions: { setPassportResult: false } });
    await expect(completeLogin(context)).rejects.toMatchObject({ code: "SECURE_STORAGE_REQUIRED" });
    expect(context.store.clearPassport).toHaveBeenCalled();
  });

  it("uses full-store deletion only as the fail-closed provider-clear fallback", () => {
    const fallback = fixture({
      storeOptions: { passport: seededPassport(), clearPassportResult: false, clearResult: true },
    });
    expect(() => fallback.manager.clearPassportSession()).not.toThrow();
    expect(fallback.store.clear).toHaveBeenCalledOnce();

    const blocked = fixture({
      storeOptions: { passport: seededPassport(), clearPassportResult: false, clearResult: false },
    });
    expect(() => blocked.manager.clearPassportSession()).toThrow(/无法清除/);
  });

  it("restores a refresh-only session at startup and schedules a live session", async () => {
    const refreshOnly = fixture({
      storeOptions: { passport: seededPassport({ accessToken: null, expiresAt: 0 }) },
    });
    await expect(refreshOnly.manager.initialize()).resolves.toMatchObject({ provider: "passport" });
    expect(refreshOnly.getRefreshCalls()).toBe(1);

    const delays = [];
    const live = fixture({
      storeOptions: { passport: seededPassport() },
      setTimeoutFn: (_callback, delay) => {
        delays.push(delay);
        return delay;
      },
    });
    await expect(live.manager.initialize()).resolves.toMatchObject({ provider: "passport" });
    expect(live.getRefreshCalls()).toBe(0);
    expect(delays.some((delay) => delay > 0)).toBe(true);

    const empty = fixture({ storeOptions: { passport: null } });
    await expect(empty.manager.initialize()).resolves.toMatchObject({ provider: "legacy" });
  });

  it("keeps a recoverable refresh token when startup central auth returns 5xx", async () => {
    const context = fixture({
      storeOptions: { passport: seededPassport({ accessToken: null, expiresAt: 0 }) },
    });
    const originalFetch = context.manager.fetchFn;
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "refresh_token") {
        return jsonResponse({ error: "invalid_token" }, 503);
      }
      return originalFetch(url, options);
    });

    await context.manager.initialize();
    expect(context.store.getPassport()?.refreshToken).toBe(`opaque-refresh~${"R".repeat(43)}`);
    expect(context.store.clearPassport).not.toHaveBeenCalled();
    expect(context.logger.warn).not.toHaveBeenCalledWith(
      "恢复统一登录会话失败",
      expect.anything(),
    );
  });

  it("refreshes a recent-profile RT-only session before exposing auth state", async () => {
    const context = fixture({
      storeOptions: {
        passport: seededPassport({ accessToken: null, expiresAt: 0, profileCheckedAt: NOW_MS }),
      },
    });
    await expect(context.manager.ensureSessionReady()).resolves.toMatchObject({
      provider: "passport",
    });
    expect(context.getRefreshCalls()).toBe(1);
    expect(context.store.getPassport()?.accessToken).toMatch(/^eyJ/);
  });

  it("uses refresh userinfo as the forced profile proof instead of requesting it twice", async () => {
    const context = fixture({
      storeOptions: {
        passport: seededPassport({ accessToken: null, expiresAt: 0, profileCheckedAt: NOW_MS }),
      },
    });
    await expect(context.manager.ensureSessionReady({ forceProfile: true })).resolves.toMatchObject({
      provider: "passport",
    });
    expect(context.getRefreshCalls()).toBe(1);
    expect(context.getUserinfoCalls()).toBe(1);
  });

  it("returns the refresh result when direct userinfo starts without a usable access token", async () => {
    const context = fixture({
      storeOptions: { passport: seededPassport({ accessToken: null, expiresAt: 0 }) },
    });
    const refreshedAccount = { passport_user_id: PASSPORT_USER_ID, nickname: "刷新后资料" };
    context.manager.refresh = vi.fn()
      .mockResolvedValueOnce({ account: refreshedAccount })
      .mockResolvedValueOnce({});
    await expect(
      context.manager.performEnsureFreshUserInfo({ force: true }),
    ).resolves.toEqual(refreshedAccount);
    await expect(
      context.manager.performEnsureFreshUserInfo({ force: true }),
    ).resolves.toBeNull();
  });

  it("forces userinfo after a credential-only refresh rescue", async () => {
    const context = fixture({
      storeOptions: { passport: seededPassport({ accessToken: null, expiresAt: 0 }) },
      profileVersions: [4],
      profileNames: ["救援后资料"],
    });
    context.manager.refresh = vi.fn(async () => {
      context.store.setPassport(seededPassport({
        accessToken: "rescued-access-token",
        expiresAt: NOW_MS + 900_000,
        profileCheckedAt: 0,
      }));
      return {
        success: true,
        profileVerified: false,
        account: context.store.getPassport().account,
      };
    });

    await expect(
      context.manager.performEnsureFreshUserInfo({ force: true }),
    ).resolves.toMatchObject({ nickname: "救援后资料", profile_version: 4 });
    expect(context.getUserinfoCalls()).toBe(1);
  });

  it("returns compatibility state without scheduling or networking when Passport is absent", async () => {
    const context = fixture({ storeOptions: { passport: null } });
    await expect(context.manager.refresh()).resolves.toMatchObject({ provider: "legacy" });
    await expect(
      context.manager.performEnsureFreshUserInfo({ force: true }),
    ).resolves.toMatchObject({ provider: "legacy" });
    await expect(context.manager.ensureSessionReady()).resolves.toMatchObject({ provider: "legacy" });
    await expect(context.manager.handleForeground()).resolves.toMatchObject({ provider: "legacy" });
    expect(() => context.manager.resumeStoredSessionTimers()).not.toThrow();
    expect(context.fetchFn).not.toHaveBeenCalled();
  });

  it("single-flights foreground/userinfo checks and refreshes an expiring access token", async () => {
    const context = fixture();
    await completeLogin(context);
    const before = context.getUserinfoCalls();
    context.store.getPassport().profileCheckedAt = NOW_MS - 61_000;
    await Promise.all([
      context.manager.handleForeground(),
      context.manager.handleForeground(),
      context.manager.handleForeground(),
    ]);
    expect(context.getUserinfoCalls()).toBe(before + 1);

    const recent = context.getUserinfoCalls();
    await context.manager.handleForeground();
    expect(context.getUserinfoCalls()).toBe(recent + 1);

    context.store.getPassport().expiresAt = NOW_MS + 30_000;
    context.store.getPassport().profileCheckedAt = 0;
    await context.manager.ensureFreshUserInfo({ force: true });
    expect(context.getRefreshCalls()).toBe(1);
  });

  it("opens only the fixed central account center", async () => {
    const context = fixture();
    await expect(context.manager.openAccountCenter()).resolves.toEqual({ success: true });
    expect(context.openExternal).toHaveBeenCalledWith(`${OIDC_ISSUER}/account`);
    const failed = fixture({ openFailure: new Error("no browser") });
    await expect(failed.manager.openAccountCenter()).rejects.toMatchObject({
      code: "BROWSER_OPEN_FAILED",
    });
  });

  it("reports durable local deletion failure after attempting fail-secure revocation", async () => {
    const context = fixture({
      storeOptions: { passport: seededPassport(), clearResult: false },
    });
    await expect(context.manager.logout()).resolves.toMatchObject({
      success: false,
      code: "LOCAL_LOGOUT_FAILED",
      globalLogout: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const revokeCall = context.fetchFn.mock.calls.find(([url]) =>
      url.endsWith("/discovered/revoke"),
    );
    expect(new URLSearchParams(revokeCall?.[1]?.body || "").get("token")).toBe(
      `opaque-refresh~${"R".repeat(43)}`,
    );
  });

  it("single-flights local logout and treats central revocation as best effort", async () => {
    const events = [];
    const context = fixture({
      events,
      revokeStatus: 503,
      storeOptions: { passport: seededPassport() },
    });
    const results = await Promise.all([
      context.manager.logout(),
      context.manager.logout(),
      context.manager.logout(),
    ]);
    expect(results).toEqual(Array(3).fill({ success: true, globalLogout: false }));
    expect(context.store.clear).toHaveBeenCalledOnce();
    expect(events.slice(0, 2)).toEqual(["clear-all", "revoke"]);
  });

  it("does not let an older revoke operation suppress logout of a newly authenticated session", async () => {
    const context = fixture({ storeOptions: { passport: seededPassport() } });
    const originalFetch = context.manager.fetchFn;
    const revokeEntered = deferred();
    const releaseRevokes = deferred();
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      if (url.endsWith("/discovered/revoke")) {
        revokeEntered.resolve();
        await releaseRevokes.promise;
      }
      return originalFetch(url, options);
    });

    const firstLogout = context.manager.logout();
    await revokeEntered.promise;
    context.manager.invalidateAuthOperations();
    context.store.setPassport(seededPassport({
      refreshToken: `opaque-refresh~${"B".repeat(43)}`,
      account: {
        ...seededPassport().account,
        passport_user_id: "3793bbfa-7c55-47b4-adb3-cb95f47ef915",
      },
    }));
    const secondLogout = context.manager.logout();
    expect(context.store.getPassport()).toBeNull();
    expect(context.store.clear).toHaveBeenCalledTimes(2);

    releaseRevokes.resolve();
    await Promise.all([firstLogout, secondLogout]);
    expect(context.store.getPassport()).toBeNull();
  });

  it("revokes a newly issued rotation when secure refresh persistence fails", async () => {
    const context = fixture({
      storeOptions: {
        passport: seededPassport(),
        setPassportRefreshTokenResult: false,
      },
    });

    await expect(context.manager.refresh()).rejects.toMatchObject({
      code: "SECURE_STORAGE_REQUIRED",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const revokeCall = context.manager.fetchFn.mock.calls.find(([url]) =>
      url.endsWith("/discovered/revoke"),
    );
    expect(new URLSearchParams(revokeCall?.[1]?.body || "").get("token")).toBe(
      `opaque-refresh~${"S".repeat(43)}`,
    );
  });

  it("keeps an already persisted rotated family when the access-memory commit fails", async () => {
    const context = fixture({
      storeOptions: {
        passport: seededPassport(),
        setPassportResult: false,
      },
    });

    await expect(context.manager.refresh()).rejects.toMatchObject({
      code: "SECURE_STORAGE_REQUIRED",
    });
    expect(context.store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"S".repeat(43)}`,
      account: { passport_user_id: PASSPORT_USER_ID },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const revokedTokens = context.manager.fetchFn.mock.calls
      .filter(([url]) => url.endsWith("/discovered/revoke"))
      .map(([, options]) => new URLSearchParams(options.body).get("token"));
    expect(revokedTokens).not.toContain(`opaque-refresh~${"S".repeat(43)}`);
  });

  it("does not let an older revoke operation suppress logout after legacy reauthentication", async () => {
    const context = fixture({ storeOptions: { passport: seededPassport(), legacy: null } });
    const originalFetch = context.manager.fetchFn;
    const revokeEntered = deferred();
    const releaseRevokes = deferred();
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      if (url.endsWith("/discovered/revoke")) {
        revokeEntered.resolve();
        await releaseRevokes.promise;
      }
      return originalFetch(url, options);
    });

    const firstLogout = context.manager.logout();
    await revokeEntered.promise;
    context.store.setLegacy({
      accessToken: "new-legacy-token",
      account: { userId: "42", nickname: "重新登录" },
    });
    const secondLogout = context.manager.logout();
    expect(context.store.getLegacy()).toBeNull();
    expect(context.store.clear).toHaveBeenCalledTimes(2);

    releaseRevokes.resolve();
    await Promise.all([firstLogout, secondLogout]);
    expect(context.store.getLegacy()).toBeNull();
  });

  it("prevents an in-flight refresh from restoring credentials after local logout", async () => {
    const context = fixture();
    await completeLogin(context);
    const originalFetch = context.manager.fetchFn;
    const entered = deferred();
    const release = deferred();
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "refresh_token") {
        entered.resolve();
        await release.promise;
      }
      return originalFetch(url, options);
    });

    const refreshing = context.manager.refresh();
    const rejected = expect(refreshing).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    await entered.promise;
    await expect(context.manager.logout()).resolves.toEqual({ success: true, globalLogout: false });
    release.resolve();
    await rejected;
    expect(context.store.getPassport()).toBeNull();
  });

  it("merges delayed userinfo into the latest rotated refresh-token family", async () => {
    const context = fixture({ storeOptions: { passport: seededPassport() } });
    const originalFetch = context.manager.fetchFn;
    const userinfoEntered = deferred();
    const releaseUserinfo = deferred();
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      if (
        url.endsWith("/discovered/userinfo") &&
        options.headers?.Authorization === "Bearer persisted-access-token"
      ) {
        userinfoEntered.resolve();
        await releaseUserinfo.promise;
      }
      return originalFetch(url, options);
    });

    const checking = context.manager.ensureFreshUserInfo({ force: true });
    await userinfoEntered.promise;
    await context.manager.refresh();
    releaseUserinfo.resolve();
    await checking;
    expect(context.store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"S".repeat(43)}`,
    });
  });

  it("does not let a stale access-token userinfo 401 clear a newly rotated family", async () => {
    const context = fixture({ storeOptions: { passport: seededPassport() } });
    const originalFetch = context.manager.fetchFn;
    const staleUserinfoEntered = deferred();
    const releaseStaleUserinfo = deferred();
    let userinfoRequests = 0;
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      if (url.endsWith("/discovered/userinfo")) {
        userinfoRequests += 1;
        if (userinfoRequests === 1) {
          staleUserinfoEntered.resolve();
          await releaseStaleUserinfo.promise;
          return jsonResponse({ error: "invalid_token" }, 401);
        }
      }
      return originalFetch(url, options);
    });

    const staleCheck = context.manager.ensureFreshUserInfo({ force: true });
    const staleRejected = expect(staleCheck).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    await staleUserinfoEntered.promise;
    await expect(context.manager.refresh()).resolves.toMatchObject({ success: true });
    releaseStaleUserinfo.resolve();
    await staleRejected;
    expect(context.store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"S".repeat(43)}`,
      accessToken: expect.stringMatching(/^eyJ/),
    });
    expect(context.store.clearPassport).not.toHaveBeenCalled();
  });

  it("preserves a newer profile while committing a delayed refresh rotation", async () => {
    const context = fixture({
      storeOptions: { passport: seededPassport() },
      userinfoStatuses: [200, 503],
      profileVersions: [4],
      profileNames: ["新资料"],
    });
    const originalFetch = context.manager.fetchFn;
    const refreshEntered = deferred();
    const releaseRefresh = deferred();
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "refresh_token") {
        refreshEntered.resolve();
        await releaseRefresh.promise;
      }
      return originalFetch(url, options);
    });

    const refreshWork = context.manager.refresh();
    await refreshEntered.promise;
    await context.manager.ensureFreshUserInfo({ force: true });
    expect(context.store.getPassport().account).toMatchObject({
      nickname: "新资料",
      profile_version: 4,
    });

    releaseRefresh.resolve();
    await expect(refreshWork).rejects.toMatchObject({ retryable: true });
    expect(context.store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"S".repeat(43)}`,
      account: { nickname: "新资料", profile_version: 4 },
    });
  });

  it("invalidates every in-flight session operation after an authentication 401", async () => {
    const context = fixture({ storeOptions: { passport: seededPassport() } });
    const originalFetch = context.manager.fetchFn;
    const userinfoEntered = deferred();
    const releaseUserinfo = deferred();
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      if (url.endsWith("/discovered/userinfo")) {
        userinfoEntered.resolve();
        await releaseUserinfo.promise;
      }
      return originalFetch(url, options);
    });
    const checking = context.manager.ensureFreshUserInfo({ force: true });
    const rejected = expect(checking).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    await userinfoEntered.promise;
    await expect(context.manager.invalidatePassportSession()).resolves.toMatchObject({
      provider: "legacy",
    });
    releaseUserinfo.resolve();
    await rejected;
    expect(context.store.getPassport()).toBeNull();
  });

  it("rejects profile commits when the Passport sub changes without reusing the auth epoch", async () => {
    const runRace = async (operation) => {
      const context = fixture({ storeOptions: { passport: seededPassport() } });
      const originalFetch = context.manager.fetchFn;
      const userinfoEntered = deferred();
      const releaseUserinfo = deferred();
      context.manager.fetchFn = vi.fn(async (url, options = {}) => {
        if (url.endsWith("/discovered/userinfo")) {
          userinfoEntered.resolve();
          await releaseUserinfo.promise;
        }
        return originalFetch(url, options);
      });
      const work = operation(context.manager);
      const rejected = expect(work).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
      await userinfoEntered.promise;
      context.store.setPassport(seededPassport({
        account: {
          ...seededPassport().account,
          passport_user_id: "3793bbfa-7c55-47b4-adb3-cb95f47ef915",
        },
      }));
      releaseUserinfo.resolve();
      await rejected;
    };

    await runRace((manager) => manager.refresh());
    await runRace((manager) => manager.ensureFreshUserInfo({ force: true }));
  });

  it("does not let a delayed 401 from an older auth epoch clear a replacement session", async () => {
    const replacement = () => seededPassport({
      account: {
        ...seededPassport().account,
        passport_user_id: "3793bbfa-7c55-47b4-adb3-cb95f47ef915",
      },
    });

    const userinfo = fixture({ storeOptions: { passport: seededPassport() } });
    const originalUserinfoFetch = userinfo.manager.fetchFn;
    const userinfoEntered = deferred();
    const releaseUserinfo = deferred();
    userinfo.manager.fetchFn = vi.fn(async (url, options = {}) => {
      if (url.endsWith("/discovered/userinfo")) {
        userinfoEntered.resolve();
        await releaseUserinfo.promise;
        return jsonResponse({ error: "invalid_token" }, 401);
      }
      return originalUserinfoFetch(url, options);
    });
    const profileWork = userinfo.manager.ensureFreshUserInfo({ force: true });
    const profileRejected = expect(profileWork).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    await userinfoEntered.promise;
    userinfo.manager.invalidateAuthOperations();
    userinfo.store.setPassport(replacement());
    releaseUserinfo.resolve();
    await profileRejected;
    expect(userinfo.store.getPassport()?.account.passport_user_id).toBe(
      "3793bbfa-7c55-47b4-adb3-cb95f47ef915",
    );

    const refreshing = fixture({ storeOptions: { passport: seededPassport() } });
    const originalRefreshFetch = refreshing.manager.fetchFn;
    const refreshEntered = deferred();
    const releaseRefresh = deferred();
    refreshing.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "refresh_token") {
        refreshEntered.resolve();
        await releaseRefresh.promise;
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      return originalRefreshFetch(url, options);
    });
    const refreshWork = refreshing.manager.refresh();
    const refreshRejected = expect(refreshWork).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    await refreshEntered.promise;
    refreshing.manager.invalidateAuthOperations();
    refreshing.store.setPassport(replacement());
    releaseRefresh.resolve();
    await refreshRejected;
    expect(refreshing.store.getPassport()?.account.passport_user_id).toBe(
      "3793bbfa-7c55-47b4-adb3-cb95f47ef915",
    );

    const callback = fixture();
    await callback.manager.startLogin();
    const state = new URL(callback.openExternal.mock.calls[0][0]).searchParams.get("state");
    const originalCallbackFetch = callback.manager.fetchFn;
    const callbackEntered = deferred();
    const releaseCallback = deferred();
    callback.manager.fetchFn = vi.fn(async (url, options = {}) => {
      const body = new URLSearchParams(options.body || "");
      if (url.endsWith("/discovered/token") && body.get("grant_type") === "authorization_code") {
        callbackEntered.resolve();
        await releaseCallback.promise;
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      return originalCallbackFetch(url, options);
    });
    const callbackWork = callback.manager.handleCallback(
      `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${state}`,
    );
    const callbackRejected = expect(callbackWork).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    await callbackEntered.promise;
    callback.manager.invalidateAuthOperations();
    callback.store.setPassport(replacement());
    releaseCallback.resolve();
    await callbackRejected;
    expect(callback.store.getPassport()?.account.passport_user_id).toBe(
      "3793bbfa-7c55-47b4-adb3-cb95f47ef915",
    );
  });

  it("prevents in-flight userinfo or callback work from restoring a logged-out session", async () => {
    const established = fixture();
    await completeLogin(established);
    const originalEstablishedFetch = established.manager.fetchFn;
    const userinfoEntered = deferred();
    const releaseUserinfo = deferred();
    established.manager.fetchFn = vi.fn(async (url, options = {}) => {
      if (url.endsWith("/discovered/userinfo")) {
        userinfoEntered.resolve();
        await releaseUserinfo.promise;
      }
      return originalEstablishedFetch(url, options);
    });
    const checking = established.manager.ensureFreshUserInfo({ force: true });
    const checkRejected = expect(checking).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    await userinfoEntered.promise;
    await established.manager.logout();
    releaseUserinfo.resolve();
    await checkRejected;
    expect(established.store.getPassport()).toBeNull();

    const callback = fixture();
    await callback.manager.startLogin();
    const authorizationUrl = new URL(callback.openExternal.mock.calls[0][0]);
    const originalCallbackFetch = callback.manager.fetchFn;
    const tokenEntered = deferred();
    const releaseToken = deferred();
    callback.manager.fetchFn = vi.fn(async (url, options = {}) => {
      if (url.endsWith("/discovered/token")) {
        tokenEntered.resolve();
        await releaseToken.promise;
      }
      return originalCallbackFetch(url, options);
    });
    const callbackWork = callback.manager.handleCallback(
      `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${authorizationUrl.searchParams.get("state")}`,
    );
    const callbackRejected = expect(callbackWork).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    await tokenEntered.promise;
    await callback.manager.logout();
    releaseToken.resolve();
    await callbackRejected;
    expect(callback.store.getPassport()).toBeNull();
  });

  it("best-effort revokes an issued refresh token when logout cancels callback commit", async () => {
    const context = fixture();
    await context.manager.startLogin();
    const authorizationUrl = new URL(context.openExternal.mock.calls.at(-1)[0]);
    const originalFetch = context.manager.fetchFn;
    const userinfoEntered = deferred();
    const releaseUserinfo = deferred();
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      if (url.endsWith("/discovered/userinfo")) {
        userinfoEntered.resolve();
        await releaseUserinfo.promise;
      }
      return originalFetch(url, options);
    });

    const callbackWork = context.manager.handleCallback(
      `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${authorizationUrl.searchParams.get("state")}`,
    );
    const callbackRejected = expect(callbackWork).rejects.toMatchObject({
      code: "AUTH_CANCELLED",
    });
    await userinfoEntered.promise;
    await context.manager.logout();
    releaseUserinfo.resolve();
    await callbackRejected;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const revokeCall = context.manager.fetchFn.mock.calls.find(([url]) =>
      url.endsWith("/discovered/revoke"),
    );
    expect(new URLSearchParams(revokeCall?.[1]?.body || "").get("token")).toBe(
      `opaque-refresh~${"R".repeat(43)}`,
    );
    expect(context.store.getPassport()).toBeNull();
  });

  it("normalizes network, protocol and malformed JSON failures", async () => {
    const context = fixture();
    const cases = [
      {
        response: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); },
        code: "PASSPORT_TIMEOUT",
      },
      { response: async () => { throw new Error("offline"); }, code: "PASSPORT_UNAVAILABLE" },
      {
        response: async () => ({ ok: true, status: 200, text: async () => { throw new Error("read"); } }),
        code: "INVALID_RESPONSE",
      },
      {
        response: async () => ({
          ok: true,
          status: 200,
          text: async () => { throw Object.assign(new Error("aborted body"), { name: "AbortError" }); },
        }),
        code: "PASSPORT_TIMEOUT",
      },
      { response: async () => ({ ok: true, status: 200, text: async () => ({}) }), code: "INVALID_RESPONSE" },
      { response: async () => ({ ok: true, status: 200, text: async () => "x".repeat(128 * 1024 + 1) }), code: "INVALID_RESPONSE" },
      { response: async () => ({ ok: true, status: 200, text: async () => "not-json" }), code: "INVALID_RESPONSE" },
      { response: async () => jsonResponse([], 200), code: "INVALID_RESPONSE" },
      { response: async () => jsonResponse({ error: "invalid_grant" }, 400), code: "AUTH_REQUIRED" },
      { response: async () => jsonResponse({ error: "invalid_token" }, 400), code: "AUTH_REQUIRED" },
      { response: async () => jsonResponse({}, 401), code: "AUTH_REQUIRED" },
      { response: async () => jsonResponse({}, 429), code: "PASSPORT_RATE_LIMITED" },
      { response: async () => jsonResponse({ error: "invalid_scope" }, 400), code: "invalid_scope" },
      { response: async () => jsonResponse({}, 400), code: "PASSPORT_REQUEST_FAILED" },
      { response: async () => jsonResponse({}, 500), code: "PASSPORT_REQUEST_FAILED" },
    ];
    for (const entry of cases) {
      context.manager.fetchFn = entry.response;
      await expect(context.manager.requestJson(`${OIDC_ISSUER}/test`)).rejects.toMatchObject({
        code: entry.code,
      });
    }
    context.manager.fetchFn = async () => ({ ok: true, status: 200, text: async () => "" });
    await expect(context.manager.requestJson(`${OIDC_ISSUER}/test`)).resolves.toEqual({});
  });

  it("validates constructor boundaries and contains notification/logging failures", () => {
    expect(() => new PassportAuthManager()).toThrow(/tokenStore/);
    expect(() =>
      new PassportAuthManager({ tokenStore: memoryStore(), openExternal: null, fetchFn: null }),
    ).toThrow(/openExternal/);
    const context = fixture({ onAuthResult: () => { throw new Error("renderer closed"); } });
    expect(() => context.manager.notify({ success: true })).not.toThrow();
    context.manager.logger = null;
    expect(() => context.manager.log("warn", "ignored")).not.toThrow();
  });

  it("aborts an actually pending network request at the timeout boundary", async () => {
    const context = fixture();
    context.manager.setTimeoutFn = (callback) => {
      queueMicrotask(callback);
      return 1;
    };
    context.manager.fetchFn = (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    await expect(context.manager.requestJson(`${OIDC_ISSUER}/slow`)).rejects.toMatchObject({
      code: "PASSPORT_TIMEOUT",
      retryable: true,
    });
  });

  it("keeps the network deadline active while reading the response body", async () => {
    const context = fixture();
    const bodyEntered = deferred();
    const releaseBody = deferred();
    context.manager.setTimeoutFn = vi.fn(() => 77);
    context.manager.clearTimeoutFn = vi.fn();
    context.manager.fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => {
        bodyEntered.resolve();
        await releaseBody.promise;
        return "{}";
      },
    }));

    const request = context.manager.requestJson(`${OIDC_ISSUER}/slow-body`);
    await bodyEntered.promise;
    expect(context.manager.clearTimeoutFn).not.toHaveBeenCalled();
    releaseBody.resolve();
    await expect(request).resolves.toEqual({});
    expect(context.manager.clearTimeoutFn).toHaveBeenCalledWith(77);
  });

  it("stops reading a streamed JSON response at the byte limit", async () => {
    const context = fixture();
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const chunks = [
      Uint8Array.from(Buffer.alloc(70 * 1024, 65)),
      Uint8Array.from(Buffer.alloc(70 * 1024, 66)),
    ];
    context.manager.fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: vi.fn(async () =>
            chunks.length ? { done: false, value: chunks.shift() } : { done: true }),
          cancel,
          releaseLock,
        }),
      },
      text: async () => "{}",
    }));

    await expect(
      context.manager.requestJson(`${OIDC_ISSUER}/oversized-stream`),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);

    const successful = fixture();
    const jsonChunks = [
      Uint8Array.from(Buffer.from('{"ok":')),
      Uint8Array.from(Buffer.from("true}")),
    ];
    successful.manager.fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () =>
            jsonChunks.length ? { done: false, value: jsonChunks.shift() } : { done: true },
          releaseLock: vi.fn(),
        }),
      },
    }));
    await expect(
      successful.manager.requestJson(`${OIDC_ISSUER}/streamed-json`),
    ).resolves.toEqual({ ok: true });

    const oversizedHeader = fixture();
    const text = vi.fn(async () => "{}");
    oversizedHeader.manager.fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name === "content-length" ? String(256 * 1024) : null },
      text,
    }));
    await expect(
      oversizedHeader.manager.requestJson(`${OIDC_ISSUER}/oversized-header`),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(text).not.toHaveBeenCalled();

    const failedCancel = fixture();
    const failedChunks = [Uint8Array.from(Buffer.alloc(129 * 1024, 65))];
    failedCancel.manager.fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () =>
            failedChunks.length ? { done: false, value: failedChunks.shift() } : { done: true },
          cancel: async () => { throw new Error("cancel failed"); },
          releaseLock: vi.fn(),
        }),
      },
    }));
    await expect(
      failedCancel.manager.requestJson(`${OIDC_ISSUER}/failed-cancel`),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("reloads JWKS for the signed initial ID token but never for opaque refresh access", async () => {
    const initial = fixture();
    await initial.manager.startLogin();
    const originalInitialLoader = initial.manager.loadJwks.bind(initial.manager);
    initial.manager.loadJwks = vi
      .fn()
      .mockResolvedValueOnce({ keys: [] })
      .mockImplementation(originalInitialLoader);
    const state = new URL(initial.openExternal.mock.calls[0][0]).searchParams.get("state");
    await expect(
      initial.manager.handleCallback(
        `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${state}`,
      ),
    ).resolves.toMatchObject({ success: true });
    expect(initial.manager.loadJwks).toHaveBeenCalledTimes(2);

    const refreshing = fixture({ storeOptions: { passport: seededPassport() } });
    const originalRefreshLoader = refreshing.manager.loadJwks.bind(refreshing.manager);
    refreshing.manager.loadJwks = vi
      .fn()
      .mockResolvedValueOnce({ keys: [] })
      .mockImplementation(originalRefreshLoader);
    await expect(refreshing.manager.refresh()).resolves.toMatchObject({ success: true });
    expect(refreshing.manager.loadJwks).not.toHaveBeenCalled();
  });

  it("runs scheduled refresh failure handling without leaking sensitive values", async () => {
    const scheduled = [];
    const context = fixture({
      setTimeoutFn: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
    });
    await completeLogin(context);
    context.manager.refresh = vi.fn(async () => {
      throw { code: "REFRESH_FAILED", retryable: true };
    });
    const refreshTimer = scheduled.find(({ delay }) => delay === 13 * 60 * 1000);
    refreshTimer.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.logger.warn).toHaveBeenCalledWith(
      "望三通行证自动刷新失败",
      { code: "REFRESH_FAILED" },
    );
    expect(scheduled.some(({ delay }) => delay === 60_000)).toBe(true);
  });

  it("replaces auth timers and only retries while a Passport session remains", async () => {
    const scheduled = [];
    const cleared = [];
    const context = fixture({
      storeOptions: { passport: seededPassport() },
      setTimeoutFn: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
      clearTimeoutFn: (timer) => cleared.push(timer),
    });

    context.manager.refreshTimer = 41;
    context.manager.refresh = vi.fn(async () => {
      throw {};
    });
    context.manager.scheduleRefresh(NOW_MS + 900_000);
    expect(cleared).toContain(41);
    const refreshTimer = scheduled.at(-1);
    refreshTimer.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.logger.warn).toHaveBeenCalledWith(
      "望三通行证自动刷新失败",
      { code: "unknown" },
    );

    context.manager.profileTimer = 42;
    context.manager.ensureFreshUserInfo = vi.fn(async () => {
      throw {};
    });
    context.manager.scheduleProfileRecheck(0, true);
    expect(cleared).toContain(42);
    const retryingProfileTimer = scheduled.at(-1);
    retryingProfileTimer.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduled.at(-1).delay).toBe(60_000);

    context.store.clearPassport();
    context.manager.scheduleProfileRecheck(0, true);
    const finalTimer = scheduled.at(-1);
    const countBeforeFailure = scheduled.length;
    finalTimer.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduled).toHaveLength(countBeforeFailure);
  });

  it("contains retryable state checks and a session disappearing during startup", async () => {
    const retryable = fixture({ storeOptions: { passport: seededPassport() } });
    retryable.manager.ensureSessionReady = vi.fn(async () => {
      throw Object.assign(new Error("offline"), { retryable: true });
    });
    await expect(retryable.manager.getAuthState()).resolves.toMatchObject({
      success: true,
      provider: "passport",
    });
    expect(retryable.logger.warn).not.toHaveBeenCalled();

    const disappearing = fixture({ storeOptions: { passport: seededPassport() } });
    disappearing.manager.ensureSessionReady = vi.fn(async () => {
      disappearing.store.clearPassport();
    });
    await expect(disappearing.manager.initialize()).resolves.toMatchObject({
      provider: "legacy",
    });
  });

  it("refreshes stale startup/profile state and contains get-state recheck failures", async () => {
    const stale = fixture({
      storeOptions: {
        passport: seededPassport({ profileCheckedAt: NOW_MS - 5 * 60 * 1000 }),
      },
    });
    await expect(stale.manager.initialize()).resolves.toMatchObject({ provider: "passport" });
    expect(stale.getUserinfoCalls()).toBe(1);

    stale.store.getPassport().profileCheckedAt = 0;
    stale.manager.fetchFn = async () => jsonResponse({ error: "invalid_request" }, 400);
    await expect(stale.manager.getAuthState()).resolves.toMatchObject({ success: true });
    expect(stale.logger.warn).toHaveBeenCalledWith(
      "通行证资料复核失败",
      expect.objectContaining({ code: "invalid_request" }),
    );

    const empty = fixture({ storeOptions: { passport: null } });
    await expect(empty.manager.refresh()).resolves.toMatchObject({ provider: "legacy" });
    await expect(empty.manager.ensureFreshUserInfo()).resolves.toMatchObject({ provider: "legacy" });
    await expect(empty.manager.handleForeground()).resolves.toMatchObject({ provider: "legacy" });
    await expect(empty.manager.getAuthState()).resolves.toMatchObject({ success: true, provider: "legacy" });
  });

  it("retries a no-session logout and handles revocation errors without protocol codes", async () => {
    const empty = fixture({ storeOptions: { passport: null, legacy: null } });
    await expect(empty.manager.logout()).resolves.toEqual({ success: true, globalLogout: false });
    expect(empty.store.clear).toHaveBeenCalledOnce();

    const context = fixture({ storeOptions: { passport: seededPassport() } });
    context.manager.loadDiscovery = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(context.manager.logout()).resolves.toEqual({ success: true, globalLogout: false });
    expect(context.logger.warn).toHaveBeenCalledWith(
      "通行证 refresh token 撤销未完成",
      { code: "PASSPORT_UNAVAILABLE" },
    );
  });

  it("retains a refresh token only for revocation after a failed local-delete retry", async () => {
    const events = [];
    const context = fixture({
      events,
      storeOptions: { passport: seededPassport(), clearResults: [false, true] },
    });
    await expect(context.manager.logout()).resolves.toMatchObject({
      success: false,
      code: "LOCAL_LOGOUT_FAILED",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["clear-all", "revoke"]);

    await expect(context.manager.logout()).resolves.toEqual({ success: true, globalLogout: false });
    expect(events).toEqual(["clear-all", "revoke", "clear-all"]);
    const revokeCall = context.manager.fetchFn.mock.calls.find(([url]) =>
      url.endsWith("/discovered/revoke"),
    );
    expect(new URLSearchParams(revokeCall[1].body).get("token")).toBe(
      `opaque-refresh~${"R".repeat(43)}`,
    );
  });

  it("does not forget a failed-logout revocation when a new login succeeds", async () => {
    const abandonedRefreshToken = `opaque-refresh~${"Q".repeat(43)}`;
    const context = fixture({
      storeOptions: {
        passport: seededPassport({ refreshToken: abandonedRefreshToken }),
        clearResults: [false],
      },
    });
    await expect(context.manager.logout()).resolves.toMatchObject({
      success: false,
      code: "LOCAL_LOGOUT_FAILED",
    });
    await expect(completeLogin(context)).resolves.toMatchObject({ success: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const revokedTokens = context.manager.fetchFn.mock.calls
      .filter(([url]) => url.endsWith("/discovered/revoke"))
      .map(([, options]) => new URLSearchParams(options.body).get("token"));
    expect(revokedTokens).toContain(abandonedRefreshToken);
    expect(context.store.getPassport()).toMatchObject({
      refreshToken: `opaque-refresh~${"R".repeat(43)}`,
    });
  });

  it("single-flights revocation and lets a compatible login drain an abandoned token", async () => {
    const abandonedRefreshToken = `opaque-refresh~${"Q".repeat(43)}`;
    const context = fixture({
      storeOptions: {
        passport: seededPassport({ refreshToken: abandonedRefreshToken }),
        clearResults: [false],
      },
    });
    const originalFetch = context.manager.fetchFn;
    const revokeEntered = deferred();
    const releaseRevoke = deferred();
    let revokeAttempts = 0;
    context.manager.fetchFn = vi.fn(async (url, options = {}) => {
      if (url.endsWith("/discovered/revoke")) {
        revokeAttempts += 1;
        if (revokeAttempts === 1) return jsonResponse({ error: "server_error" }, 503);
        revokeEntered.resolve();
        await releaseRevoke.promise;
      }
      return originalFetch(url, options);
    });
    await expect(context.manager.logout()).resolves.toMatchObject({
      code: "LOCAL_LOGOUT_FAILED",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    context.store.setLegacy({ accessToken: "new-legacy", account: { userId: "42" } });
    context.manager.drainPendingRevocations();
    await revokeEntered.promise;
    const duplicate = context.manager.revokeRefreshToken(abandonedRefreshToken);
    const originalOperation = context.manager.revocationPromises.get(abandonedRefreshToken);
    expect(duplicate).toBe(originalOperation);
    releaseRevoke.resolve();
    await duplicate;

    const revokeCalls = context.manager.fetchFn.mock.calls.filter(([url]) =>
      url.endsWith("/discovered/revoke"),
    );
    expect(revokeCalls).toHaveLength(2);
    expect(revokeAttempts).toBe(2);
    expect(context.manager.pendingRevocationTokens.has(abandonedRefreshToken)).toBe(false);
  });

  it("contains unexpected callback failures and both startup recheck error classes", async () => {
    const notifications = [];
    const callback = fixture({ onAuthResult: (result) => notifications.push(result) });
    await callback.manager.startLogin();
    callback.manager.verifyInitialTokens = vi.fn(async () => {
      throw new Error("unexpected validator failure");
    });
    const state = new URL(callback.openExternal.mock.calls[0][0]).searchParams.get("state");
    await expect(
      callback.manager.handleCallback(
        `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=${state}`,
      ),
    ).rejects.toThrow("unexpected validator failure");
    expect(notifications.at(-1)).toEqual({
      success: false,
      code: "PASSPORT_UNAVAILABLE",
      error: "统一登录暂不可用，请稍后重试",
    });

    for (const [status, shouldLog] of [[400, true], [500, false]]) {
      const startup = fixture({
        storeOptions: {
          passport: seededPassport({ profileCheckedAt: 0 }),
        },
      });
      const originalFetch = startup.manager.fetchFn;
      startup.manager.fetchFn = (url, options) =>
        url.endsWith("/discovered/userinfo")
          ? Promise.resolve(jsonResponse(status === 400 ? { error: "invalid_request" } : {}, status))
          : originalFetch(url, options);
      await startup.manager.initialize();
      expect(startup.logger.warn.mock.calls.some(([message]) => message === "恢复统一登录会话失败")).toBe(
        shouldLog,
      );
    }
  });
});
