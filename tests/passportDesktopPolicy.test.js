import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  evaluateAimMapping,
  isPassportRolloutEnabled,
  isTrustedSettingsUrl,
  shouldPreflightSensitivePassport,
} = require("../src/helpers/passportDesktopPolicy.js");

const SETTINGS_PATH = path.resolve("src/dist/settings.html");
const PASSPORT_USER_ID = "b118e5a6-1258-4d1d-9e42-a25306d3085a";
const passportSession = {
  issuer: "https://auth.yaa3.com",
  account: { passport_user_id: PASSPORT_USER_ID },
};
const authenticatedIdentity = {
  issuer: "https://auth.yaa3.com",
  passport_user_id: PASSPORT_USER_ID,
};

describe("desktop Passport security policy", () => {
  it("keeps the independent rollout switch default-off and exact", () => {
    for (const value of ["1", "true", "TRUE", 1]) expect(isPassportRolloutEnabled(value)).toBe(true);
    for (const value of [undefined, null, "", "0", "yes", true, false]) {
      expect(isPassportRolloutEnabled(value)).toBe(false);
    }
  });

  it("preflights sensitive writes only when Passport is the actual or sole candidate", () => {
    expect(shouldPreflightSensitivePassport({
      hasPassport: true,
      writeCandidates: [{ provider: "legacy", accessToken: "legacy" }],
    })).toBe(false);
    expect(shouldPreflightSensitivePassport({
      hasPassport: true,
      writeCandidates: [{ provider: "passport", accessToken: "passport" }],
    })).toBe(true);
    expect(shouldPreflightSensitivePassport({ hasPassport: true, writeCandidates: [] })).toBe(true);
    expect(shouldPreflightSensitivePassport({
      hasPassport: false,
      writeCandidates: [{ provider: "passport" }],
    })).toBe(false);
  });

  it("accepts only the exact development settings main-frame URL", () => {
    const options = { development: true, settingsFilePath: SETTINGS_PATH };
    expect(isTrustedSettingsUrl("http://localhost:5173/?page=settings", options)).toBe(true);
    expect(isTrustedSettingsUrl("http://localhost:5173/?page=settings&tab=account", options)).toBe(true);
    for (const value of [
      "https://localhost:5173/?page=settings",
      "http://127.0.0.1:5173/?page=settings",
      "http://localhost:5174/?page=settings",
      "http://localhost:5173/other?page=settings",
      "http://localhost:5173/?page=settings&extra=1",
      "http://localhost:5173/?page=settings&page=settings",
      "http://localhost:5173/?page=settings&tab=../account",
      "http://localhost:5173/?page=settings#remote",
      "not-a-url",
    ]) {
      expect(isTrustedSettingsUrl(value, options)).toBe(false);
    }
  });

  it("accepts only the packaged settings file and a bounded tab query", () => {
    const base = pathToFileURL(SETTINGS_PATH).href;
    const options = { development: false, settingsFilePath: SETTINGS_PATH };
    expect(isTrustedSettingsUrl(base, options)).toBe(true);
    expect(isTrustedSettingsUrl(`${base}?tab=permissions`, options)).toBe(true);
    for (const value of [
      pathToFileURL(path.resolve("src/dist/index.html")).href,
      `${base}?page=settings`,
      `${base}?tab=../account`,
      `${base}#remote`,
      "file:///tmp/settings.html",
      "https://auth.yaa3.com/account",
      "",
    ]) {
      expect(isTrustedSettingsUrl(value, options)).toBe(false);
    }
    expect(isTrustedSettingsUrl(base, { development: false, settingsFilePath: "relative" })).toBe(false);
  });

  it("accepts AIM writes only after a Passport-authenticated same-user proof", () => {
    expect(evaluateAimMapping({
      authProvider: "passport",
      passportSession: null,
      authenticatedIdentity,
    })).toEqual({
      status: "auth-required",
    });
    for (const businessAccount of [null, {}, { userId: 0 }, { userId: "not-an-id" }]) {
      expect(
        evaluateAimMapping({
          authProvider: "passport",
          passportSession,
          authenticatedIdentity,
          businessAccount,
        }),
      ).toEqual({ status: "identity-conflict" });
    }
    expect(
      evaluateAimMapping({
        authProvider: "passport",
        passportSession,
        authenticatedIdentity,
        businessAccount: { userId: 42 },
      }),
    ).toEqual({ status: "accept", aimUserId: "42" });
    expect(
      evaluateAimMapping({
        authProvider: "passport",
        passportSession,
        authenticatedIdentity,
        legacyAccount: { userId: "42" },
        businessAccount: { userId: 42 },
      }),
    ).toEqual({ status: "accept", aimUserId: "42" });
    for (const legacyAccount of [{}, { userId: "41" }, { userId: "bad" }]) {
      expect(
        evaluateAimMapping({
          authProvider: "passport",
          passportSession,
          authenticatedIdentity,
          legacyAccount,
          businessAccount: { userId: "42" },
        }),
      ).toEqual({ status: "identity-conflict" });
    }
    for (const legacyAccount of [null, {}]) {
      expect(
        evaluateAimMapping({
          authProvider: "passport",
          passportSession,
          authenticatedIdentity,
          hasLegacyCredential: true,
          legacyAccount,
          businessAccount: { userId: "42" },
        }),
      ).toEqual({ status: "identity-conflict" });
    }

    const mappedPassport = {
      ...passportSession,
      aimMapping: {
        issuer: "https://auth.yaa3.com",
        passport_user_id: PASSPORT_USER_ID,
        aim_user_id: "42",
      },
    };
    expect(
      evaluateAimMapping({
        authProvider: "passport",
        passportSession: mappedPassport,
        authenticatedIdentity,
        businessAccount: { userId: "99" },
      }),
    ).toEqual({ status: "identity-conflict" });

    expect(
      evaluateAimMapping({
        authProvider: "passport",
        passportSession,
        authenticatedIdentity: {
          ...authenticatedIdentity,
          passport_user_id: "3793bbfa-7c55-47b4-adb3-cb95f47ef915",
        },
        businessAccount: { userId: "42" },
      }),
    ).toEqual({ status: "stale-auth-response" });
  });

  it("rejects stale Passport proof on legacy/unknown responses without inventing an account", () => {
    expect(evaluateAimMapping({ authProvider: "legacy", passportSession })).toEqual({
      status: "reject",
    });
    expect(evaluateAimMapping({ authProvider: "legacy", passportSession: null })).toEqual({
      status: "neutral",
    });
    expect(evaluateAimMapping({ authProvider: "unexpected", passportSession })).toEqual({
      status: "reject",
    });
  });
});
