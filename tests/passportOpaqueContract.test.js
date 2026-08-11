import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  CLIENT_ID,
  OIDC_ISSUER,
  REDIRECT_URI,
  REQUESTED_SCOPE,
  parseCallbackUrl,
  validateTokenResponse,
  verifyTokenSet,
} = require("../src/helpers/passportOidc.js");
const { createTokenStore } = require("../src/helpers/tokenStore.js");

const PASSPORT_USER_ID = "b118e5a6-1258-4d1d-9e42-a25306d3085a";
const CENTRAL_SESSION_ID = "f430586a-5aad-49a1-85f8-1bb4102f32a6";
const NOW_SECONDS = 1_800_000_000;
const tempDirectories = [];

function signIdToken() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const encodedHeader = Buffer.from(JSON.stringify({
    alg: "RS256",
    kid: "opaque-contract-key",
    typ: "JWT",
  })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify({
    iss: OIDC_ISSUER,
    aud: CLIENT_ID,
    sub: PASSPORT_USER_ID,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 300,
    nonce: "nonce-value-is-long-enough",
    token_use: "id",
    auth_time: NOW_SECONDS - 10,
    jti: "0f13be9a-e100-4377-b43e-a2599aaf472d",
    sid: CENTRAL_SESSION_ID,
  })).toString("base64url");
  const input = `${encodedHeader}.${encodedPayload}`;
  const signature = signBytes("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  const jwk = publicKey.export({ format: "jwk" });
  return {
    token: `${input}.${signature}`,
    jwks: { keys: [{ ...jwk, alg: "RS256", kid: "opaque-contract-key", use: "sig" }] },
  };
}

function tokenResponse(overrides = {}) {
  const signed = signIdToken();
  return {
    signed,
    raw: {
      access_token: "opaque~access.token_value-without-jwt-segments",
      id_token: signed.token,
      refresh_token: "opaque~refresh.token_value-without-prefix",
      token_type: "Bearer",
      expires_in: 900,
      scope: REQUESTED_SCOPE,
      ...overrides,
    },
  };
}

function createSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptString: (value) => Buffer.from(value, "utf8").reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString("utf8"),
  };
}

afterEach(() => {
  while (tempDirectories.length) {
    fs.rmSync(tempDirectories.pop(), { recursive: true, force: true });
  }
});

describe("opaque native OAuth credentials", () => {
  it("accepts authorization codes without ac1 prefixes at the exact frozen bounds", () => {
    const state = "state-value-is-long-enough";
    for (const code of ["A".repeat(16), "._~-".repeat(128)]) {
      expect(parseCallbackUrl(
        `${REDIRECT_URI}?code=${encodeURIComponent(code)}&state=${state}`,
        state,
      ).code).toBe(code);
    }

    for (const code of [
      "A".repeat(15),
      "A".repeat(513),
      "opaque code value",
      "opaque\ncode-value",
      "opaque/code/value",
      "令牌令牌令牌令牌令牌令牌令牌令牌",
    ]) {
      expect(() => parseCallbackUrl(
        `${REDIRECT_URI}?code=${encodeURIComponent(code)}&state=${state}`,
        state,
      )).toThrow(/code|callback/i);
    }
  });

  it("treats access and refresh credentials as opaque while keeping the ID token signed", () => {
    const fixture = tokenResponse();
    const parsed = validateTokenResponse(fixture.raw);
    const verified = verifyTokenSet({
      tokenResponse: parsed,
      jwks: fixture.signed.jwks,
      expectedNonce: "nonce-value-is-long-enough",
      nowSeconds: NOW_SECONDS,
    });

    expect(parsed.accessToken).toBe(fixture.raw.access_token);
    expect(parsed.refreshToken).toBe(fixture.raw.refresh_token);
    expect(verified).toMatchObject({
      passportUserId: PASSPORT_USER_ID,
      centralSessionId: CENTRAL_SESSION_ID,
    });
    expect(verified).not.toHaveProperty("accessClaims");
  });

  it("enforces only the frozen character/control/size boundary for opaque bearers", () => {
    const validRefreshTokens = ["R".repeat(16), "._~-".repeat(128)];
    for (const refreshToken of validRefreshTokens) {
      expect(validateTokenResponse(tokenResponse({ refresh_token: refreshToken }).raw).refreshToken)
        .toBe(refreshToken);
    }
    expect(validateTokenResponse(tokenResponse({ access_token: "A".repeat(32 * 1024) }).raw).accessToken)
      .toHaveLength(32 * 1024);

    for (const refreshToken of [
      "R".repeat(15),
      "R".repeat(513),
      "opaque refresh token",
      "opaque\trefresh-token",
      "opaque/refresh/token",
    ]) {
      expect(() => validateTokenResponse(tokenResponse({ refresh_token: refreshToken }).raw))
        .toThrow(/refresh_token/i);
    }
    for (const accessToken of [
      "A".repeat(15),
      "A".repeat(32 * 1024 + 1),
      "opaque access token",
      "opaque\raccess-token",
      "opaque/access/token",
    ]) {
      expect(() => validateTokenResponse(tokenResponse({ access_token: accessToken }).raw))
        .toThrow(/access_token/i);
    }
  });

  it("persists, reloads, rotates and quarantines opaque refresh credentials", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-opaque-store-"));
    tempDirectories.push(directory);
    const options = {
      dataDirectory: directory,
      safeStorage: createSafeStorage(),
      platform: "darwin",
      now: () => NOW_SECONDS * 1000,
    };
    const first = createTokenStore(options);
    const original = "opaque~refresh.token_value-original";
    const rotated = "opaque~refresh.token_value-rotated";
    expect(first.setPassport({
      accessToken: "opaque~access.token_value-original",
      refreshToken: original,
      expiresAt: NOW_SECONDS * 1000 + 900_000,
      scope: REQUESTED_SCOPE,
      centralSessionId: CENTRAL_SESSION_ID,
      profileCheckedAt: NOW_SECONDS * 1000,
      account: { passport_user_id: PASSPORT_USER_ID, profile_version: 1 },
    })).toBe(true);

    const reloaded = createTokenStore(options);
    expect(reloaded.getPassport()).toMatchObject({ refreshToken: original, accessToken: null });
    expect(reloaded.quarantinePassportRefreshToken(original)).toBe(true);
    expect(reloaded.setPassportRefreshToken(original, rotated)).toBe(true);
    expect(reloaded.getPassport()).toMatchObject({
      refreshToken: rotated,
      refreshOutcomeUnknown: false,
    });
  });
});
