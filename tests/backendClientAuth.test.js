import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const modulePaths = {
  backend: require.resolve("../src/helpers/backendClient.js"),
  config: require.resolve("../src/helpers/backendConfig.js"),
  device: require.resolve("../src/helpers/deviceIdentity.js"),
  store: require.resolve("../src/helpers/tokenStore.js"),
  authenticatedFetch: require.resolve("../src/helpers/authenticatedFetch.js"),
};
const originalCache = new Map(
  Object.values(modulePaths).map((modulePath) => [modulePath, require.cache[modulePath]]),
);
const originalFetch = globalThis.fetch;

function installModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function response(body, { ok = true, status = 200, textError = null } = {}) {
  return {
    ok,
    status,
    text: vi.fn(async () => {
      if (textError) throw textError;
      return typeof body === "string" ? body : JSON.stringify(body);
    }),
  };
}

function loadClient({
  deviceId = "device-12345678",
  tokenStore = {},
  fallback,
} = {}) {
  const store = {
    getAccessTokenCandidates: vi.fn(() => []),
    getPassport: vi.fn(() => null),
    getProviderGeneration: vi.fn(() => 0),
    ...tokenStore,
  };
  const fetchWithAuthFallback = vi.fn(
    fallback || (async () => ({
      response: response({ success: true, data: {} }),
      provider: null,
      rejectedProviders: [],
    })),
  );
  const getDeviceId = vi.fn(() => deviceId);
  installModule(modulePaths.config, {
    AI_BACKEND_URL: "https://aim.example",
    API_PREFIX: "/aiapi",
    CLIENT_PLATFORM: "mac",
    BACKEND_REQUEST_TIMEOUT_MS: 5_000,
  });
  installModule(modulePaths.device, { getDeviceId });
  installModule(modulePaths.store, store);
  installModule(modulePaths.authenticatedFetch, { fetchWithAuthFallback });
  delete require.cache[modulePaths.backend];
  globalThis.fetch = vi.fn();
  return {
    client: require(modulePaths.backend),
    fetchWithAuthFallback,
    getDeviceId,
    store,
  };
}

afterEach(() => {
  delete require.cache[modulePaths.backend];
  for (const [modulePath, cached] of originalCache) {
    if (cached) require.cache[modulePath] = cached;
    else delete require.cache[modulePath];
  }
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("backendClient Passport routing", () => {
  it("returns authenticated AIM metadata and reports every rejected credential", async () => {
    const passport = {
      issuer: "https://auth.yaa3.com",
      account: { passport_user_id: "b118e5a6-1258-4d1d-9e42-a25306d3085a" },
    };
    const credentials = [
      { provider: "passport", accessToken: "passport-token" },
      { provider: "legacy", accessToken: "legacy-token" },
    ];
    const context = loadClient({
      tokenStore: {
        getAccessTokenCandidates: vi.fn(() => credentials),
        getPassport: vi.fn(() => passport),
        getProviderGeneration: vi.fn((provider) => (provider === "passport" ? 7 : 4)),
      },
      fallback: async () => ({
        response: response({ success: true, data: { userId: "42" } }),
        provider: "passport",
        rejectedProviders: ["legacy"],
      }),
    });
    const failureHandler = vi.fn(async () => undefined);
    context.client.setAuthFailureHandler(failureHandler);

    await expect(context.client.authMe()).resolves.toEqual({
      response: { success: true, data: { userId: "42" } },
      authProvider: "passport",
      authIdentity: {
        issuer: "https://auth.yaa3.com",
        passport_user_id: "b118e5a6-1258-4d1d-9e42-a25306d3085a",
      },
      authContext: {
        passport: {
          identity: {
            issuer: "https://auth.yaa3.com",
            passport_user_id: "b118e5a6-1258-4d1d-9e42-a25306d3085a",
          },
          generation: 7,
        },
        legacy: { generation: 4 },
      },
    });
    expect(context.store.getAccessTokenCandidates).toHaveBeenCalledWith({
      method: "GET",
      purpose: "aim-mapping",
    });
    expect(failureHandler).toHaveBeenCalledWith([
      { provider: "legacy", identity: null, generation: 4 },
    ]);
    expect(context.fetchWithAuthFallback).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://aim.example/aiapi/auth/me",
      credentials,
      options: expect.objectContaining({
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-device-id": "device-12345678",
          "x-platform": "mac",
        },
      }),
    }));

    expect(() => context.client.setAuthFailureHandler("bad")).toThrow(TypeError);
    expect(() => context.client.setSensitiveAuthPreflightHandler({})).toThrow(TypeError);
    expect(() => context.client.setAuthFailureHandler(null)).not.toThrow();
    expect(() => context.client.setSensitiveAuthPreflightHandler(null)).not.toThrow();
  });

  it("preflights sensitive writes and preserves their exact request bodies", async () => {
    const calls = [];
    const context = loadClient({
      fallback: async ({ url, options }) => {
        calls.push({ url, options });
        return {
          response: response({
            success: true,
            data: {
              output: "润色结果",
              visibleChars: 4,
              cloudRemaining: 96,
              subscription: "pro",
              dailyUsed: 4,
              dailyCap: 100,
            },
          }),
          provider: null,
          rejectedProviders: [],
        };
      },
    });
    const preflight = vi.fn(async () => undefined);
    context.client.setSensitiveAuthPreflightHandler(preflight);

    await expect(
      context.client.polish("原文", "normal", [{ from: "原", to: "新" }]),
    ).resolves.toEqual({
      text: "润色结果",
      visibleChars: 4,
      cloudRemaining: 96,
      subscription: "pro",
      dailyUsed: 4,
      dailyCap: 100,
    });
    await context.client.createOrder("pro", "wechat");
    await context.client.mockPay(123);
    await context.client.redeem("CODE");
    expect(preflight.mock.calls.map(([value]) => value.pathname)).toEqual([
      "/polish",
      "/payment/order",
      "/payment/mock/pay",
      "/redeem",
    ]);
    expect(JSON.parse(calls[0].options.body)).toEqual({
      text: "原文",
      mode: "normal",
      word_map: [{ from: "原", to: "新" }],
    });
    expect(JSON.parse(calls[1].options.body)).toEqual({ planCode: "pro", channel: "wechat" });
    expect(JSON.parse(calls[2].options.body)).toEqual({ orderId: "123" });
    expect(JSON.parse(calls[3].options.body)).toEqual({ code: "CODE" });
  });

  it("binds a sensitive preflight to the credential snapshot it actually approves", async () => {
    let candidates = [{ provider: "legacy", accessToken: "legacy-token" }];
    let passport = null;
    let passportGeneration = 1;
    const fallback = vi.fn(async ({ credentials }) => ({
      response: response({ success: true, data: {} }),
      provider: credentials[0]?.provider || null,
      rejectedProviders: [],
    }));
    const context = loadClient({
      tokenStore: {
        getAccessTokenCandidates: vi.fn(() => candidates),
        getPassport: vi.fn(() => passport),
        getProviderGeneration: vi.fn((provider) =>
          provider === "passport" ? passportGeneration : 1),
      },
      fallback,
    });
    context.client.setSensitiveAuthPreflightHandler(vi.fn(async ({ authSnapshot }) => {
      expect(authSnapshot.credentials[0].provider).toBe("legacy");
      passport = {
        issuer: "https://auth.yaa3.com",
        account: { passport_user_id: "b118e5a6-1258-4d1d-9e42-a25306d3085a" },
      };
      passportGeneration += 1;
      candidates = [{ provider: "passport", accessToken: "passport-token" }];
      return { refreshAuthSnapshot: false };
    }));
    await expect(context.client.createOrder("pro", "wechat")).rejects.toMatchObject({
      kind: "auth",
      code: "AUTH_REQUIRED",
    });
    expect(fallback).not.toHaveBeenCalled();

    const refreshed = loadClient({
      tokenStore: {
        getAccessTokenCandidates: vi.fn(() => candidates),
        getPassport: vi.fn(() => passport),
        getProviderGeneration: vi.fn(() => passportGeneration),
      },
      fallback,
    });
    candidates = [];
    refreshed.client.setSensitiveAuthPreflightHandler(vi.fn(async ({ authSnapshot }) => {
      expect(authSnapshot.credentials).toEqual([]);
      candidates = [{ provider: "passport", accessToken: "fresh-passport-token" }];
      passportGeneration += 1;
      return {
        refreshAuthSnapshot: true,
        approvedCredential: {
          provider: "passport",
          generation: passportGeneration,
          identity: {
            issuer: passport.issuer,
            passport_user_id: passport.account.passport_user_id,
          },
        },
      };
    }));
    await refreshed.client.redeem("CODE");
    expect(fallback.mock.calls.at(-1)[0].credentials).toEqual([
      { provider: "passport", accessToken: "fresh-passport-token" },
    ]);

    const denied = loadClient({
      tokenStore: {
        getAccessTokenCandidates: vi.fn(() => [
          { provider: "legacy", accessToken: "legacy-token" },
        ]),
      },
      fallback,
    });
    denied.client.setSensitiveAuthPreflightHandler(vi.fn(async () => ({
      refreshAuthSnapshot: true,
      approvedCredential: {
        provider: "passport",
        generation: passportGeneration,
        identity: {
          issuer: passport.issuer,
          passport_user_id: passport.account.passport_user_id,
        },
      },
    })));
    await expect(denied.client.mockPay("order")).rejects.toMatchObject({
      kind: "auth",
      code: "AUTH_REQUIRED",
    });
  });

  it("rejects a Passport account switch after sensitive proof", async () => {
    const passportA = {
      issuer: "https://auth.yaa3.com",
      account: { passport_user_id: "b118e5a6-1258-4d1d-9e42-a25306d3085a" },
    };
    const passportB = {
      issuer: "https://auth.yaa3.com",
      account: { passport_user_id: "3793bbfa-7c55-47b4-adb3-cb95f47ef915" },
    };
    let currentPassport = passportA;
    let generation = 4;
    let credentials = [{ provider: "passport", accessToken: "passport-a-token" }];
    const fallback = vi.fn();
    const context = loadClient({
      tokenStore: {
        getAccessTokenCandidates: vi.fn(() => credentials),
        getPassport: vi.fn(() => currentPassport),
        getProviderGeneration: vi.fn(() => generation),
      },
      fallback,
    });
    context.client.setSensitiveAuthPreflightHandler(vi.fn(async ({ authSnapshot }) => {
      expect(authSnapshot.credentials[0]).toEqual({ provider: "passport" });
      currentPassport = passportB;
      credentials = [{ provider: "passport", accessToken: "passport-b-token" }];
      generation += 1;
      return {
        refreshAuthSnapshot: true,
        approvedCredential: {
          provider: "passport",
          generation,
          identity: {
            issuer: passportB.issuer,
            passport_user_id: passportB.account.passport_user_id,
          },
        },
      };
    }));

    await expect(context.client.redeem("CODE")).rejects.toMatchObject({
      kind: "auth",
      code: "AUTH_REQUIRED",
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("allows only a same-account Passport rotation during sensitive proof", async () => {
    const passport = {
      issuer: "https://auth.yaa3.com",
      account: { passport_user_id: "b118e5a6-1258-4d1d-9e42-a25306d3085a" },
    };
    let generation = 8;
    let credentials = [{ provider: "passport", accessToken: "old-passport-token" }];
    const fallback = vi.fn(async ({ credentials: approved }) => ({
      response: response({ success: true, data: {} }),
      provider: approved[0]?.provider || null,
      rejectedProviders: [],
    }));
    const context = loadClient({
      tokenStore: {
        getAccessTokenCandidates: vi.fn(() => credentials),
        getPassport: vi.fn(() => passport),
        getProviderGeneration: vi.fn(() => generation),
      },
      fallback,
    });
    context.client.setSensitiveAuthPreflightHandler(vi.fn(async () => {
      generation += 1;
      credentials = [{ provider: "passport", accessToken: "new-passport-token" }];
      return {
        refreshAuthSnapshot: true,
        approvedCredential: {
          provider: "passport",
          generation,
          identity: {
            issuer: passport.issuer,
            passport_user_id: passport.account.passport_user_id,
          },
        },
      };
    }));

    await expect(context.client.createOrder("pro", "wechat")).resolves.toEqual({});
    expect(fallback).toHaveBeenCalledWith(expect.objectContaining({
      credentials: [{ provider: "passport", accessToken: "new-passport-token" }],
    }));
  });

  it("does not silently move a Passport sensitive action onto legacy fallback", async () => {
    const passport = {
      issuer: "https://auth.yaa3.com",
      account: { passport_user_id: "b118e5a6-1258-4d1d-9e42-a25306d3085a" },
    };
    let currentPassport = passport;
    let credentials = [{ provider: "passport", accessToken: "passport-token" }];
    let passportGeneration = 3;
    let legacyGeneration = 7;
    const fallback = vi.fn();
    const context = loadClient({
      tokenStore: {
        getAccessTokenCandidates: vi.fn(() => credentials),
        getPassport: vi.fn(() => currentPassport),
        getProviderGeneration: vi.fn((provider) =>
          provider === "passport" ? passportGeneration : legacyGeneration),
      },
      fallback,
    });
    context.client.setSensitiveAuthPreflightHandler(vi.fn(async () => {
      currentPassport = null;
      passportGeneration += 1;
      legacyGeneration += 1;
      credentials = [{ provider: "legacy", accessToken: "legacy-token" }];
      return {
        refreshAuthSnapshot: true,
        approvedCredential: {
          provider: "legacy",
          generation: legacyGeneration,
          identity: null,
        },
      };
    }));

    await expect(context.client.redeem("CODE")).rejects.toMatchObject({
      kind: "auth",
      code: "AUTH_REQUIRED",
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("classifies timeout, network and HTTP failures with auth evidence", async () => {
    const passport = {
      issuer: "https://auth.yaa3.com",
      account: { passport_user_id: "b118e5a6-1258-4d1d-9e42-a25306d3085a" },
    };
    const fallback = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("late"), { name: "AbortError" }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        response: response({ error: "AUTH_REQUIRED", message: "expired" }, { ok: false, status: 401 }),
        provider: "passport",
        rejectedProviders: ["passport"],
      })
      .mockResolvedValueOnce({
        response: response("not-json", { ok: false, status: 503 }),
        provider: null,
        rejectedProviders: [],
      })
      .mockResolvedValueOnce({
        response: response(null, { textError: new Error("body unavailable") }),
        provider: null,
        rejectedProviders: [],
      });
    const context = loadClient({
      tokenStore: {
        getAccessTokenCandidates: vi.fn(() => [
          { provider: "passport", accessToken: "passport-token" },
        ]),
        getPassport: vi.fn(() => passport),
        getProviderGeneration: vi.fn(() => 8),
      },
      fallback,
    });

    await expect(context.client.request("/quota", { timeoutMs: 0 })).rejects.toMatchObject({
      kind: "timeout",
      cause: expect.objectContaining({ name: "AbortError" }),
    });
    await expect(context.client.request("/quota")).rejects.toMatchObject({
      kind: "network",
      cause: expect.objectContaining({ message: "offline" }),
    });
    await expect(context.client.request("/quota")).rejects.toMatchObject({
      kind: "http",
      status: 401,
      code: "AUTH_REQUIRED",
      authProvider: "passport",
      authIdentity: passport.account && {
        issuer: passport.issuer,
        passport_user_id: passport.account.passport_user_id,
      },
      authContext: expect.objectContaining({ passport: expect.objectContaining({ generation: 8 }) }),
    });
    await expect(context.client.request("/quota")).rejects.toMatchObject({
      kind: "http",
      status: 503,
      code: null,
      message: "后端错误 HTTP 503",
      body: null,
    });
    await expect(context.client.request("/quota")).resolves.toBeNull();
  });

  it("covers the legacy account, quota and public API wrappers", async () => {
    const calls = [];
    const dataByPath = {
      "/quota": {
        userId: "42",
        registered: 1,
        cloudRemaining: 88,
        subscription: "free",
        dailyUsed: 12,
        dailyCap: 100,
      },
      "/prompt?mode=normal%20mode": { mode: "normal mode", systemPrompt: "prompt" },
      "/payment/plans": [{ code: "pro" }],
      "/payment/order": { orderId: "o1" },
      "/payment/mock/pay": { ok: true },
      "/redeem": { charAmount: 10 },
      "/auth/sms/send": { sent: true },
      "/auth/sms/login": { accessToken: "legacy" },
      "/auth/email/send": { sent: true },
      "/auth/email/login": { accessToken: "legacy" },
      "/auth/wechat/url": { url: "https://wechat.example" },
      "/auth/wechat/callback": { accessToken: "legacy" },
    };
    const context = loadClient({
      deviceId: "device!123456789",
      fallback: async ({ url, options }) => {
        const parsed = new URL(url);
        const path = `${parsed.pathname.replace("/aiapi", "")}${parsed.search}`;
        calls.push({ path, options });
        return {
          response: response({ success: true, data: dataByPath[path] }),
          provider: null,
          rejectedProviders: [],
        };
      },
    });

    await expect(context.client.getQuota()).resolves.toEqual({
      userId: "42",
      registered: true,
      cloudRemaining: 88,
      subscription: "free",
      dailyUsed: 12,
      dailyCap: 100,
    });
    await expect(context.client.getLocalPrompt("normal mode")).resolves.toEqual({
      mode: "normal mode",
      systemPrompt: "prompt",
    });
    await expect(context.client.listPlans()).resolves.toEqual([{ code: "pro" }]);
    await expect(context.client.createOrder("pro", "wechat")).resolves.toEqual({ orderId: "o1" });
    await expect(context.client.mockPay("o1")).resolves.toEqual({ ok: true });
    await expect(context.client.redeem("CODE")).resolves.toEqual({ charAmount: 10 });
    await expect(context.client.authSmsSend("13800000000")).resolves.toMatchObject({ success: true });
    await context.client.authSmsLogin("13800000000", "123456", "invite");
    await expect(context.client.authEmailSend("a@example.com")).resolves.toMatchObject({ success: true });
    await context.client.authEmailLogin("a@example.com", "123456", "invite");
    await expect(context.client.getWechatAuthUrl()).resolves.toEqual({ url: "https://wechat.example" });
    await context.client.authWechatLogin("wechat-code", "invite");

    for (const path of ["/auth/sms/login", "/auth/email/login", "/auth/wechat/callback"]) {
      const body = JSON.parse(calls.find((call) => call.path === path).options.body);
      expect(body.deviceId).toBe("device123456789");
      expect(body.inviteCode).toBe("invite");
    }
  });

  it("uses safe defaults for malformed successful business responses and short device ids", async () => {
    const context = loadClient({
      deviceId: "bad!",
      fallback: async ({ url }) => ({
        response: response({ success: true, data: new URL(url).pathname.endsWith("/payment/plans") ? {} : null }),
        provider: null,
        rejectedProviders: [],
      }),
    });
    await expect(context.client.polish("text", "normal")).resolves.toEqual({
      text: "",
      visibleChars: null,
      cloudRemaining: null,
      subscription: null,
      dailyUsed: null,
      dailyCap: null,
    });
    await expect(context.client.getQuota()).resolves.toEqual({
      userId: null,
      registered: false,
      cloudRemaining: null,
      subscription: null,
      dailyUsed: null,
      dailyCap: null,
    });
    await expect(context.client.getLocalPrompt("normal")).resolves.toBeNull();
    await expect(context.client.listPlans()).resolves.toEqual([]);
    await expect(context.client.createOrder("pro", "wechat")).resolves.toEqual({});
    await expect(context.client.mockPay(1)).resolves.toEqual({});
    await expect(context.client.redeem("CODE")).resolves.toEqual({});
    await expect(context.client.getWechatAuthUrl()).resolves.toEqual({});
    const sms = await context.client.authSmsLogin("13800000000", "123456");
    const email = await context.client.authEmailLogin("a@example.com", "123456");
    const wechat = await context.client.authWechatLogin("code");
    for (const call of [sms, email, wechat]) expect(call).toMatchObject({ success: true });
    const loginBodies = context.fetchWithAuthFallback.mock.calls
      .filter(([{ url }]) => /\/auth\/(sms\/login|email\/login|wechat\/callback)$/.test(url))
      .map(([{ options }]) => JSON.parse(options.body));
    expect(loginBodies.every((body) => !("deviceId" in body) && !("inviteCode" in body))).toBe(true);
  });
});
