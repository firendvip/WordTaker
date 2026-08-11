import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createAuthFailureHandler } = require("../src/helpers/authFailureCoordinator.js");

const PASSPORT_USER_ID = "b118e5a6-1258-4d1d-9e42-a25306d3085a";
const identity = {
  issuer: "https://auth.yaa3.com",
  passport_user_id: PASSPORT_USER_ID,
};

function tokenStore({ passport = true, clearResult = true } = {}) {
  const generations = { passport: 3, legacy: 5 };
  return {
    getPassport: vi.fn(() => passport ? {
      issuer: identity.issuer,
      account: { passport_user_id: identity.passport_user_id },
    } : null),
    clearProvider: vi.fn(() => clearResult),
    getProviderGeneration: vi.fn((provider) => generations[provider] ?? null),
  };
}

describe("AIM rejected-credential invalidation", () => {
  it("invalidates each rejected provider once without mixing credentials", async () => {
    const store = tokenStore();
    const passportAuthManager = { invalidatePassportSession: vi.fn(async () => ({})) };
    const handler = createAuthFailureHandler({ tokenStore: store, passportAuthManager });
    await expect(handler([
      { provider: "passport", identity, generation: 3 },
      { provider: "passport", identity, generation: 3 },
      { provider: "legacy", identity: null, generation: 5 },
    ])).resolves.toBe(true);
    expect(passportAuthManager.invalidatePassportSession).toHaveBeenCalledOnce();
    expect(store.clearProvider).toHaveBeenCalledOnce();
    expect(store.clearProvider).toHaveBeenCalledWith("legacy");
  });

  it("does not let an old Passport response clear a newly selected sub", async () => {
    const store = tokenStore();
    const passportAuthManager = { invalidatePassportSession: vi.fn(async () => ({})) };
    const handler = createAuthFailureHandler({ tokenStore: store, passportAuthManager });
    await expect(handler([{
      provider: "passport",
      identity: { ...identity, passport_user_id: "3793bbfa-7c55-47b4-adb3-cb95f47ef915" },
      generation: 3,
    }])).resolves.toBe(true);
    expect(passportAuthManager.invalidatePassportSession).not.toHaveBeenCalled();

    await expect(handler([{ provider: "legacy", identity: null, generation: 4 }])).resolves.toBe(true);
    expect(store.clearProvider).not.toHaveBeenCalled();
  });

  it("fails closed when durable provider deletion fails", async () => {
    const store = tokenStore({ clearResult: false });
    const handler = createAuthFailureHandler({ tokenStore: store, passportAuthManager: null });
    await expect(handler([{ provider: "legacy", identity: null, generation: 5 }])).rejects.toMatchObject({
      code: "LOCAL_SESSION_CLEAR_FAILED",
    });
    await expect(handler([{ provider: "passport", identity, generation: 3 }])).rejects.toMatchObject({
      code: "LOCAL_SESSION_CLEAR_FAILED",
    });
  });

  it("validates construction and ignores unknown provider records", async () => {
    expect(() => createAuthFailureHandler()).toThrow(/tokenStore/);
    const store = tokenStore({ passport: false });
    const handler = createAuthFailureHandler({ tokenStore: store, passportAuthManager: null });
    await expect(handler([null, {}, { provider: "unknown" }])).resolves.toBe(true);
    expect(store.clearProvider).not.toHaveBeenCalled();
  });
});
