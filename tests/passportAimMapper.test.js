import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createPassportAimMapper } = require("../src/helpers/passportAimMapper.js");

const PASSPORT_USER_ID = "b118e5a6-1258-4d1d-9e42-a25306d3085a";
const OTHER_PASSPORT_USER_ID = "3793bbfa-7c55-47b4-adb3-cb95f47ef915";
const identity = {
  issuer: "https://auth.yaa3.com",
  passport_user_id: PASSPORT_USER_ID,
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function passport(overrides = {}) {
  return {
    issuer: identity.issuer,
    refreshToken: `rt1.${"R".repeat(43)}`,
    account: {
      passport_user_id: PASSPORT_USER_ID,
      nickname: "中央昵称",
      picture: "https://auth.yaa3.com/avatar",
      profile_version: 4,
    },
    aimMapping: null,
    ...overrides,
  };
}

function fixture({
  passportSession = passport(),
  legacy = { accessToken: "legacy-token", account: { userId: "42", nickname: "旧昵称" } },
  authProvider = "passport",
  authIdentity = identity,
  businessAccount = { userId: "42", role: "member", nickname: "业务昵称" },
  ensureError = null,
  backendError = null,
  markResult = true,
  setLegacyResult = true,
  clearProviderResult = true,
  invalidateError = null,
  requestPassportIdentity = authIdentity,
  passportEnabled = true,
} = {}) {
  let currentPassport = passportSession;
  let currentLegacy = legacy;
  let passportGeneration = 1;
  let legacyGeneration = 2;
  const tokenStore = {
    getPassport: vi.fn(() => currentPassport),
    getLegacy: vi.fn(() => currentLegacy),
    markPassportAimApiAccepted: vi.fn(() => markResult),
    setLegacy: vi.fn((value) => {
      if (setLegacyResult) {
        currentLegacy = value;
        legacyGeneration += 1;
      }
      return setLegacyResult;
    }),
    clearProvider: vi.fn((provider) => {
      if (clearProviderResult) {
        if (provider === "passport") currentPassport = null;
        if (provider === "legacy") currentLegacy = null;
        if (provider === "passport") passportGeneration += 1;
        if (provider === "legacy") legacyGeneration += 1;
      }
      return clearProviderResult;
    }),
    getProviderGeneration: vi.fn((provider) =>
      provider === "passport" ? passportGeneration : legacyGeneration,
    ),
  };
  const passportAuthManager = {
    ensureSessionReady: vi.fn(async () => {
      if (ensureError) throw ensureError;
      return {};
    }),
    invalidatePassportSession: vi.fn(async () => {
      if (invalidateError) throw invalidateError;
      currentPassport = null;
      passportGeneration += 1;
      return {};
    }),
  };
  const backendClient = {
    authMe: vi.fn(async () => {
      if (backendError) throw backendError;
      return {
        response: {
          data: {
            account: businessAccount,
            cloudRemaining: 120,
            subscription: { active: true },
          },
        },
        authProvider,
        authIdentity,
        authContext: {
          passport: requestPassportIdentity
            ? { identity: requestPassportIdentity, generation: passportGeneration }
            : null,
          legacy: legacy ? { generation: legacyGeneration } : null,
        },
      };
    }),
  };
  return {
    mapper: createPassportAimMapper({
      tokenStore,
      passportAuthManager,
      backendClient,
      passportEnabled,
    }),
    tokenStore,
    passportAuthManager,
    backendClient,
  };
}

describe("Passport to AIM stable mapping", () => {
  it("accepts only the exact request identity and overlays global profile fields", async () => {
    const context = fixture();
    await expect(context.mapper.resolve({ sensitive: true })).resolves.toMatchObject({
      success: true,
      authProvider: "passport",
      authEvidence: {
        provider: "passport",
        generation: 1,
        identity,
      },
      account: {
        userId: "42",
        role: "member",
        nickname: "中央昵称",
        passport_user_id: PASSPORT_USER_ID,
      },
    });
    expect(context.passportAuthManager.ensureSessionReady).toHaveBeenCalledWith({
      forceProfile: true,
    });
    expect(context.tokenStore.markPassportAimApiAccepted).toHaveBeenCalledWith(true, "42");
  });

  it("never overwrites an established AIM owner and preserves the legacy fallback", async () => {
    const context = fixture({
      passportSession: passport({
        aimMapping: { ...identity, aim_user_id: "42" },
      }),
      legacy: { accessToken: "legacy-token", account: { userId: "42" } },
      businessAccount: { userId: "99" },
    });
    await expect(context.mapper.resolve()).resolves.toMatchObject({
      success: false,
      code: "IDENTITY_CONFLICT",
      fallbackAccount: { userId: "42" },
    });
    expect(context.passportAuthManager.invalidatePassportSession).toHaveBeenCalledOnce();
    expect(context.tokenStore.markPassportAimApiAccepted).not.toHaveBeenCalledWith(true, "99");
  });

  it("never treats a legacy credential with missing local account identity as a new user", async () => {
    for (const account of [null, {}]) {
      const context = fixture({
        legacy: { accessToken: "legacy-token", account },
        businessAccount: { userId: "99" },
      });
      await expect(context.mapper.resolve()).resolves.toMatchObject({
        success: false,
        code: "IDENTITY_CONFLICT",
        compatibilityFallback: true,
      });
      expect(context.tokenStore.markPassportAimApiAccepted).not.toHaveBeenCalledWith(true, "99");
      expect(context.passportAuthManager.invalidatePassportSession).toHaveBeenCalledOnce();
      expect(context.tokenStore.getLegacy()).toMatchObject({ accessToken: "legacy-token" });
    }
  });

  it("rejects a Passport mapping response when its legacy proof disappears in flight", async () => {
    const context = fixture();
    const response = deferred();
    context.backendClient.authMe.mockImplementation(async () => response.promise);
    const resolving = context.mapper.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.tokenStore.clearProvider("legacy")).toBe(true);
    response.resolve({
      response: { data: { account: { userId: "99" } } },
      authProvider: "passport",
      authIdentity: identity,
      authContext: {
        passport: { identity, generation: 1 },
        legacy: { generation: 2 },
      },
    });

    await expect(resolving).resolves.toMatchObject({
      success: false,
      code: "AUTH_REQUIRED",
    });
    expect(context.tokenStore.markPassportAimApiAccepted).not.toHaveBeenCalled();
    expect(context.passportAuthManager.invalidatePassportSession).not.toHaveBeenCalled();
  });

  it("ignores a late response from Passport A after the user switches to B", async () => {
    const context = fixture({
      passportSession: passport({
        account: { ...passport().account, passport_user_id: OTHER_PASSPORT_USER_ID },
      }),
      authIdentity: identity,
      requestPassportIdentity: identity,
    });
    await expect(context.mapper.resolve()).resolves.toMatchObject({
      success: false,
      code: "AUTH_REQUIRED",
    });
    expect(context.passportAuthManager.invalidatePassportSession).not.toHaveBeenCalled();
  });

  it("keeps a recoverable RT when central refresh is offline and no legacy exists", async () => {
    const context = fixture({
      legacy: null,
      ensureError: Object.assign(new Error("offline"), {
        code: "PASSPORT_UNAVAILABLE",
        retryable: true,
      }),
    });
    await expect(context.mapper.resolve()).resolves.toMatchObject({
      success: false,
      code: "PASSPORT_UNAVAILABLE",
    });
    expect(context.backendClient.authMe).not.toHaveBeenCalled();
    expect(context.passportAuthManager.invalidatePassportSession).not.toHaveBeenCalled();
  });

  it("continues with legacy when Passport refresh is temporarily unavailable", async () => {
    const context = fixture({
      ensureError: Object.assign(new Error("offline"), { retryable: true }),
      authProvider: "legacy",
      authIdentity: null,
    });
    await expect(context.mapper.resolve()).resolves.toMatchObject({
      success: true,
      authProvider: "legacy",
      compatibilityFallback: true,
    });
    expect(context.tokenStore.markPassportAimApiAccepted).not.toHaveBeenCalled();
    expect(context.tokenStore.setLegacy).toHaveBeenCalled();
  });

  it("uses legacy only and never contacts central auth while rollout is disabled", async () => {
    const context = fixture({
      passportEnabled: false,
      authProvider: "legacy",
      authIdentity: null,
    });

    await expect(context.mapper.resolve()).resolves.toMatchObject({
      success: true,
      authProvider: "legacy",
      compatibilityFallback: false,
    });
    expect(context.passportAuthManager.ensureSessionReady).not.toHaveBeenCalled();
    expect(context.tokenStore.markPassportAimApiAccepted).not.toHaveBeenCalled();
    expect(context.passportAuthManager.invalidatePassportSession).not.toHaveBeenCalled();
  });

  it("fails closed for a sensitive mapping proof when forced central verification fails", async () => {
    const context = fixture({
      ensureError: Object.assign(new Error("offline"), {
        code: "PASSPORT_UNAVAILABLE",
        retryable: true,
      }),
    });
    await expect(context.mapper.resolve({ sensitive: true })).resolves.toMatchObject({
      success: false,
      code: "PASSPORT_UNAVAILABLE",
    });
    expect(context.backendClient.authMe).not.toHaveBeenCalled();
  });

  it("fails closed for missing authentication evidence and durable store failures", async () => {
    const anonymous = fixture({ authProvider: null, authIdentity: null });
    await expect(anonymous.mapper.resolve()).resolves.toMatchObject({
      success: false,
      code: "AUTH_REQUIRED",
    });
    expect(anonymous.passportAuthManager.invalidatePassportSession).not.toHaveBeenCalled();
    expect(anonymous.tokenStore.clearProvider).toHaveBeenCalledWith("legacy");

    const mappingWrite = fixture({ markResult: false });
    await expect(mappingWrite.mapper.resolve()).resolves.toMatchObject({
      success: false,
      code: "LOCAL_SESSION_CLEAR_FAILED",
    });

    const legacyWrite = fixture({
      authProvider: "legacy",
      authIdentity: null,
      setLegacyResult: false,
    });
    await expect(legacyWrite.mapper.resolve()).resolves.toMatchObject({
      success: false,
      code: "SECURE_STORAGE_REQUIRED",
    });
  });

  it("normalizes backend 401/409 and ordinary failures without clearing a new sub", async () => {
    const unauthorized = fixture({
      backendError: Object.assign(new Error("expired"), {
        status: 401,
        authProvider: "passport",
        authIdentity: identity,
      }),
    });
    await expect(unauthorized.mapper.resolve()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(unauthorized.passportAuthManager.invalidatePassportSession).toHaveBeenCalledOnce();

    const staleConflict = fixture({
      passportSession: passport({
        account: { ...passport().account, passport_user_id: OTHER_PASSPORT_USER_ID },
      }),
      backendError: Object.assign(new Error("conflict"), {
        status: 409,
        authProvider: "passport",
        authIdentity: identity,
      }),
    });
    await expect(staleConflict.mapper.resolve()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(staleConflict.passportAuthManager.invalidatePassportSession).not.toHaveBeenCalled();

    const legacyConflict = fixture({
      backendError: Object.assign(new Error("legacy conflict"), {
        status: 409,
        authProvider: "legacy",
        authContext: { passport: null, legacy: { generation: 2 } },
      }),
    });
    await expect(legacyConflict.mapper.resolve()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(legacyConflict.passportAuthManager.invalidatePassportSession).not.toHaveBeenCalled();

    const unavailable = fixture({ backendError: Object.assign(new Error("down"), { code: "DOWN" }) });
    await expect(unavailable.mapper.resolve()).resolves.toMatchObject({
      success: false,
      code: "DOWN",
    });
  });

  it("queues a new generation and forced profile proof behind an older mapping request", async () => {
    const context = fixture();
    let passportGeneration = 1;
    context.tokenStore.getProviderGeneration.mockImplementation((provider) =>
      provider === "passport" ? passportGeneration : 2,
    );
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    context.backendClient.authMe.mockImplementation(async () => {
      calls += 1;
      const requestGeneration = passportGeneration;
      if (calls === 1) {
        entered.resolve();
        await release.promise;
      }
      return {
        response: { data: { account: { userId: "42" } } },
        authProvider: "passport",
        authIdentity: identity,
        authContext: {
          passport: { identity, generation: requestGeneration },
          legacy: { generation: 2 },
        },
      };
    });
    const first = context.mapper.resolve();
    await entered.promise;
    passportGeneration = 2;
    const second = context.mapper.resolve();
    release.resolve();
    await first;
    await expect(second).resolves.toMatchObject({ success: true, authProvider: "passport" });
    expect(context.backendClient.authMe).toHaveBeenCalledTimes(2);
    expect(context.passportAuthManager.ensureSessionReady).toHaveBeenLastCalledWith({
      forceProfile: false,
    });
  });

  it("validates construction and supports the token-store clear fallback", async () => {
    expect(() => createPassportAimMapper()).toThrow(/tokenStore/);
    expect(() => createPassportAimMapper({ tokenStore: fixture().tokenStore })).toThrow(
      /backendClient/,
    );
    const context = fixture();
    context.mapper = createPassportAimMapper({
      tokenStore: context.tokenStore,
      passportAuthManager: null,
      backendClient: {
        authMe: vi.fn(async () => ({
          response: { data: {} },
          authProvider: null,
          authContext: {
            passport: { identity, generation: 1 },
            legacy: { generation: 2 },
          },
        })),
      },
    });
    await expect(context.mapper.resolve()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(context.tokenStore.clearProvider).toHaveBeenCalledWith("passport");
  });

  it("supports legacy-only proof and normalizes missing central error details", async () => {
    const legacyOnly = fixture({
      passportSession: null,
      authProvider: "legacy",
      authIdentity: null,
      requestPassportIdentity: null,
    });
    await expect(legacyOnly.mapper.resolve()).resolves.toMatchObject({
      success: true,
      authProvider: "legacy",
      compatibilityFallback: false,
    });
    expect(legacyOnly.passportAuthManager.ensureSessionReady).not.toHaveBeenCalled();

    const centralOffline = fixture({
      legacy: null,
      ensureError: new Error(),
    });
    await expect(centralOffline.mapper.resolve()).resolves.toEqual({
      success: false,
      code: "PASSPORT_UNAVAILABLE",
      error: "获取账号失败",
    });
  });

  it("fails closed when invalid credentials or mapping denial cannot be durably cleared", async () => {
    const anonymous = fixture({
      authProvider: null,
      authIdentity: null,
      requestPassportIdentity: identity,
      invalidateError: new Error("secure delete failed"),
    });
    await expect(anonymous.mapper.resolve()).resolves.toMatchObject({
      code: "LOCAL_SESSION_CLEAR_FAILED",
    });

    const invalidPassportProof = fixture({
      authIdentity: null,
      requestPassportIdentity: identity,
      invalidateError: new Error("secure delete failed"),
    });
    await expect(invalidPassportProof.mapper.resolve()).resolves.toMatchObject({
      code: "LOCAL_SESSION_CLEAR_FAILED",
    });

    const deniedLegacyFallback = fixture({
      authProvider: "legacy",
      authIdentity: null,
      requestPassportIdentity: identity,
      markResult: false,
    });
    await expect(deniedLegacyFallback.mapper.resolve()).resolves.toMatchObject({
      code: "LOCAL_SESSION_CLEAR_FAILED",
    });
    expect(deniedLegacyFallback.tokenStore.markPassportAimApiAccepted).toHaveBeenCalledWith(false);
  });

  it("handles stale proof, exact conflicts, and provider-specific 401 cleanup", async () => {
    const staleProof = fixture({
      authIdentity: { ...identity, passport_user_id: OTHER_PASSPORT_USER_ID },
      requestPassportIdentity: identity,
    });
    await expect(staleProof.mapper.resolve()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(staleProof.passportAuthManager.invalidatePassportSession).not.toHaveBeenCalled();

    const exactConflict = fixture({
      backendError: Object.assign(new Error("conflict"), {
        status: 409,
        authProvider: "passport",
        authContext: { passport: { identity, generation: 1 }, legacy: null },
      }),
      invalidateError: new Error("secure delete failed"),
    });
    await expect(exactConflict.mapper.resolve()).resolves.toMatchObject({
      code: "LOCAL_SESSION_CLEAR_FAILED",
    });

    const legacyUnauthorized = fixture({
      backendError: Object.assign(new Error("expired"), {
        status: 401,
        authProvider: "legacy",
        authContext: { passport: null, legacy: { generation: 2 } },
      }),
    });
    await expect(legacyUnauthorized.mapper.resolve()).resolves.toMatchObject({
      code: "AUTH_REQUIRED",
      loggedIn: false,
    });
    expect(legacyUnauthorized.tokenStore.clearProvider).toHaveBeenCalledWith("legacy");

    const blockedLegacyClear = fixture({
      clearProviderResult: false,
      backendError: Object.assign(new Error("expired"), {
        status: 401,
        authProvider: "legacy",
        authContext: { passport: null, legacy: { generation: 2 } },
      }),
    });
    await expect(blockedLegacyClear.mapper.resolve()).resolves.toMatchObject({
      code: "LOCAL_SESSION_CLEAR_FAILED",
    });
  });

  it("single-flights identical mapping requests without skipping a stronger follow-up", async () => {
    const context = fixture();
    const entered = deferred();
    const release = deferred();
    const response = {
      response: { data: { account: { userId: "42" } } },
      authProvider: "passport",
      authIdentity: identity,
      authContext: {
        passport: { identity, generation: 1 },
        legacy: { generation: 2 },
      },
    };
    context.backendClient.authMe.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return response;
    });
    const first = context.mapper.resolve();
    await entered.promise;
    const second = context.mapper.resolve();
    release.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ success: true }),
      expect.objectContaining({ success: true }),
    ]);
    expect(context.backendClient.authMe).toHaveBeenCalledOnce();
  });
});
