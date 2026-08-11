import { createRequire } from "node:module";
import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  CLIENT_ID,
  OIDC_ISSUER,
  REDIRECT_URI,
  REQUESTED_SCOPE,
  createAuthorizationRequest,
  extractCallbackUrl,
  parseCallbackUrl,
  validateDiscovery,
  validateRefreshTokenResponse,
  validateTokenResponse,
  validateUserInfo,
  verifyTokenSet,
} = require("../src/helpers/passportOidc.js");

const PASSPORT_USER_ID = "b118e5a6-1258-4d1d-9e42-a25306d3085a";
const CENTRAL_SESSION_ID = "f430586a-5aad-49a1-85f8-1bb4102f32a6";
const JWT_IDENTIFIER = "00000000-0000-4000-8000-000000000007";

function metadata(overrides = {}) {
  return {
    issuer: OIDC_ISSUER,
    authorization_endpoint: `${OIDC_ISSUER}/oauth2/authorize-v2`,
    token_endpoint: `${OIDC_ISSUER}/oauth2/token-v2`,
    userinfo_endpoint: `${OIDC_ISSUER}/oauth2/userinfo-v2`,
    jwks_uri: `${OIDC_ISSUER}/.well-known/jwks-v2.json`,
    revocation_endpoint: `${OIDC_ISSUER}/oauth2/revoke-v2`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["openid", "profile", "offline_access", "aim.api"],
    ...overrides,
  };
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwt(privateKey, payload, header = {}) {
  const encodedHeader = base64urlJson({ alg: "RS256", kid: "test-key", typ: "JWT", ...header });
  const encodedPayload = base64urlJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = signBytes("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function replaceJwt(privateKey, token, payloadOverrides = {}, headerOverrides = {}) {
  const [, encodedPayload] = token.split(".");
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  return signJwt(privateKey, { ...payload, ...payloadOverrides }, headerOverrides);
}

function tokenFixture({ nonce = "nonce-value-is-long-enough", now = 1_800_000_000 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const common = {
    iss: OIDC_ISSUER,
    aud: CLIENT_ID,
    sub: PASSPORT_USER_ID,
    iat: now,
    exp: now + 300,
  };
  const idToken = signJwt(privateKey, {
    ...common,
    nonce,
    token_use: "id",
    auth_time: now - 20,
    jti: JWT_IDENTIFIER,
    sid: CENTRAL_SESSION_ID,
    name: "弦外小猫用户",
    picture: `${OIDC_ISSUER}/api/profile/avatar/${PASSPORT_USER_ID}?v=7`,
    profile_version: 7,
  });
  const accessToken = "opaque.access.fixture";
  return {
    privateKey,
    jwks: { keys: [{ ...jwk, alg: "RS256", kid: "test-key", use: "sig" }] },
    response: {
      access_token: accessToken,
      id_token: idToken,
      refresh_token: `opaque-refresh~${"R".repeat(43)}`,
      token_type: "Bearer",
      expires_in: 900,
      scope: REQUESTED_SCOPE,
    },
  };
}

describe("passport OIDC contract", () => {
  it("accepts only issuer-bound discovery metadata with native public-client capabilities", () => {
    const discovered = validateDiscovery(metadata());

    expect(discovered.authorizationEndpoint).toBe(`${OIDC_ISSUER}/oauth2/authorize-v2`);
    expect(discovered.tokenEndpoint).toBe(`${OIDC_ISSUER}/oauth2/token-v2`);
    expect(discovered.userinfoEndpoint).toBe(`${OIDC_ISSUER}/oauth2/userinfo-v2`);
    expect(discovered.jwksUri).toBe(`${OIDC_ISSUER}/.well-known/jwks-v2.json`);
    expect(discovered.revocationEndpoint).toBe(`${OIDC_ISSUER}/oauth2/revoke-v2`);

    expect(() => validateDiscovery(metadata({ issuer: "https://attacker.example" }))).toThrow(/issuer/i);
    expect(() => validateDiscovery(metadata({ token_endpoint: "https://attacker.example/token" }))).toThrow(/endpoint/i);
    expect(() => validateDiscovery(metadata({ code_challenge_methods_supported: ["plain"] }))).toThrow(/S256/);
    expect(() => validateDiscovery(metadata({ token_endpoint_auth_methods_supported: ["client_secret_basic"] }))).toThrow(/public client/i);
  });

  it("builds authorization from discovery with state, nonce and S256 PKCE but never exposes the verifier", () => {
    const values = [Buffer.alloc(24, 1), Buffer.alloc(24, 2), Buffer.alloc(32, 3)];
    const request = createAuthorizationRequest({
      discovery: validateDiscovery(metadata()),
      randomBytes: () => values.shift(),
      now: () => 1_800_000_000_000,
    });
    const url = new URL(request.authorizationUrl);

    expect(url.origin + url.pathname).toBe(`${OIDC_ISSUER}/oauth2/authorize-v2`);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(REQUESTED_SCOPE);
    expect(url.searchParams.get("state")).toBe(request.state);
    expect(url.searchParams.get("nonce")).toBe(request.nonce);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_verifier")).toBeNull();
    expect(url.searchParams.get("client_secret")).toBeNull();
    expect(request.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(request.codeVerifier, "ascii").digest("base64url"),
    );
  });

  it("accepts only the exact callback and consumes a matching state", () => {
    const valid = `${REDIRECT_URI}?code=opaque-code~${"A".repeat(43)}&state=state-value-is-long-enough`;
    expect(parseCallbackUrl(valid, "state-value-is-long-enough")).toEqual({
      code: `opaque-code~${"A".repeat(43)}`,
      state: "state-value-is-long-enough",
    });
    expect(extractCallbackUrl(["electron", ".", "--flag", valid])).toBe(valid);

    expect(() => parseCallbackUrl(valid, "different-state-value")).toThrow(/state/i);
    expect(() => parseCallbackUrl(valid.replace("/callback", "/callback/extra"), "state-value-is-long-enough")).toThrow(/callback/i);
    expect(() => parseCallbackUrl(valid.replace("oauth", "evil"), "state-value-is-long-enough")).toThrow(/callback/i);
    expect(() => parseCallbackUrl(`${valid}&state=state-value-is-long-enough`, "state-value-is-long-enough")).toThrow(/duplicate/i);
    expect(extractCallbackUrl(["electron", "https://attacker.example"])).toBeNull();
  });

  it("normalizes protocol errors without reflecting untrusted descriptions", () => {
    const url = `${REDIRECT_URI}?error=access_denied&error_description=${encodeURIComponent("<script>secret</script>")}&state=state-value-is-long-enough`;
    try {
      parseCallbackUrl(url, "state-value-is-long-enough");
      throw new Error("expected parseCallbackUrl to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "access_denied",
        message: "授权已取消",
      });
      expect(error.message).not.toContain("script");
    }
  });

  it("validates the signed ID token while treating the access bearer as opaque", () => {
    const now = 1_800_000_000;
    const fixture = tokenFixture({ now });
    const tokenResponse = validateTokenResponse(fixture.response);
    const verified = verifyTokenSet({
      tokenResponse,
      jwks: fixture.jwks,
      expectedNonce: "nonce-value-is-long-enough",
      nowSeconds: now,
    });

    expect(verified.passportUserId).toBe(PASSPORT_USER_ID);
    expect(verified.centralSessionId).toBe(CENTRAL_SESSION_ID);
    expect(verified.idClaims.name).toBe("弦外小猫用户");
    expect(verified).not.toHaveProperty("accessClaims");
  });

  it("rejects token substitution, bad nonce, expiry, wrong audience and malformed responses", () => {
    const now = 1_800_000_000;
    const fixture = tokenFixture({ now });
    const tokenResponse = validateTokenResponse(fixture.response);

    expect(() => verifyTokenSet({ tokenResponse, jwks: fixture.jwks, expectedNonce: "wrong-nonce-value", nowSeconds: now })).toThrow(/nonce/i);
    expect(() => verifyTokenSet({ tokenResponse, jwks: fixture.jwks, expectedNonce: "nonce-value-is-long-enough", nowSeconds: now + 901 })).toThrow(/expired/i);

    const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const tampered = {
      ...tokenResponse,
      idToken: signJwt(attacker.privateKey, {
        iss: OIDC_ISSUER,
        aud: CLIENT_ID,
        sub: PASSPORT_USER_ID,
        nonce: "nonce-value-is-long-enough",
        token_use: "id",
        auth_time: now,
        jti: JWT_IDENTIFIER,
        sid: CENTRAL_SESSION_ID,
        iat: now,
        exp: now + 300,
      }),
    };
    expect(() => verifyTokenSet({ tokenResponse: tampered, jwks: fixture.jwks, expectedNonce: "nonce-value-is-long-enough", nowSeconds: now })).toThrow(/signature/i);

    expect(() => validateTokenResponse({ ...fixture.response, token_type: "MAC" })).toThrow(/Bearer/);
    expect(() => validateTokenResponse({ ...fixture.response, refresh_token: undefined })).toThrow(/refresh/i);
    expect(() => validateTokenResponse({ ...fixture.response, scope: "openid profile" })).toThrow(/scope/i);
  });

  it("takes global profile only from validated userinfo and binds it to the same sub", () => {
    const profile = validateUserInfo(
      {
        sub: PASSPORT_USER_ID,
        name: "望三用户",
        picture: `${OIDC_ISSUER}/api/profile/avatar/${PASSPORT_USER_ID}?v=8`,
        profile_version: 8,
        role: "admin",
        tenant: "central",
        plan: "pro",
      },
      PASSPORT_USER_ID,
    );

    expect(profile).toEqual({
      passportUserId: PASSPORT_USER_ID,
      nickname: "望三用户",
      picture: `${OIDC_ISSUER}/api/profile/avatar/${PASSPORT_USER_ID}?v=8`,
      profileVersion: 8,
    });
    expect(() => validateUserInfo({ sub: "0b063c6d-e397-40ff-b6b0-bba646f10f74" }, PASSPORT_USER_ID)).toThrow(/sub/i);
    expect(() => validateUserInfo({ sub: PASSPORT_USER_ID, picture: "https://attacker.example/avatar" }, PASSPORT_USER_ID)).toThrow(/picture/i);
  });

  it("fails closed on incomplete discovery capabilities and unsafe endpoint forms", () => {
    const invalidMetadata = [
      null,
      [],
      metadata({ response_types_supported: [] }),
      metadata({ grant_types_supported: ["authorization_code"] }),
      metadata({ id_token_signing_alg_values_supported: [] }),
      metadata({ scopes_supported: ["openid", "profile"] }),
      metadata({ authorization_endpoint: null }),
      metadata({ authorization_endpoint: "not a url" }),
      metadata({ authorization_endpoint: `http://auth.yaa3.com/authorize` }),
      metadata({ authorization_endpoint: `https://user@auth.yaa3.com/authorize` }),
      metadata({ authorization_endpoint: `${OIDC_ISSUER}/authorize#fragment` }),
      metadata({ authorization_endpoint: `${OIDC_ISSUER}/` }),
    ];
    for (const value of invalidMetadata) {
      expect(() => validateDiscovery(value)).toThrow();
    }
  });

  it("rejects unavailable entropy and authorization without trusted discovery", () => {
    expect(() => createAuthorizationRequest()).toThrow(/discovery/i);
    expect(() =>
      createAuthorizationRequest({
        discovery: validateDiscovery(metadata()),
        randomBytes: () => new Uint8Array(24),
      }),
    ).toThrow(/随机数/);
    expect(() =>
      createAuthorizationRequest({
        discovery: validateDiscovery(metadata()),
        randomBytes: (size) => Buffer.alloc(Math.max(0, size - 1)),
      }),
    ).toThrow(/随机数/);
  });

  it("rejects malformed, ambiguous and replay-oriented callbacks", () => {
    const state = "state-value-is-long-enough";
    const code = `opaque-code~${"A".repeat(43)}`;
    const invalid = [
      null,
      "",
      `wangsan-wordtaker://oauth/callback?code=${code}&state=${state}\n`,
      "not a url",
      `wangsan-wordtaker://oauth/other?code=${code}&state=${state}`,
      `wangsan-wordtaker://oauth/callback#code=${code}`,
      `${REDIRECT_URI}?code=${code}`,
      `${REDIRECT_URI}?code=${code}&state=short`,
      `${REDIRECT_URI}?code=${code}&state=${state}&unexpected=1`,
      `${REDIRECT_URI}?code=bad&state=${state}`,
      `${REDIRECT_URI}?state=${state}`,
      `${REDIRECT_URI}?code=${code}&code=${code}&state=${state}`,
    ];
    for (const value of invalid) {
      expect(() => parseCallbackUrl(value, state)).toThrow();
    }
    expect(extractCallbackUrl(null)).toBeNull();
    expect(() =>
      parseCallbackUrl(`${REDIRECT_URI}?error=server_error&state=${state}`, state),
    ).toThrow("统一登录授权失败");
  });

  it("validates authorization and refresh response boundary fields", () => {
    const fixture = tokenFixture();
    expect(validateRefreshTokenResponse(fixture.response)).toMatchObject({
      refreshToken: `opaque-refresh~${"R".repeat(43)}`,
      tokenType: "Bearer",
    });
    const invalid = [
      null,
      { ...fixture.response, token_type: null },
      { ...fixture.response, expires_in: 59 },
      { ...fixture.response, expires_in: 86_401 },
      { ...fixture.response, expires_in: 900.5 },
      { ...fixture.response, refresh_token: "bad/refresh/token-value" },
      { ...fixture.response, access_token: "short" },
      { ...fixture.response, access_token: `bad\ntoken-value-long` },
      { ...fixture.response, id_token: "short" },
      { ...fixture.response, scope: null },
      { ...fixture.response, scope: "openid profile offline_access aim.api aim.api" },
      { ...fixture.response, scope: `${REQUESTED_SCOPE}\n` },
      { ...fixture.response, scope: "x".repeat(513) },
    ];
    for (const value of invalid) {
      expect(() => validateTokenResponse(value)).toThrow();
    }
  });

  it("enforces final ID-token jti, sid, auth_time, subject and TTL claims", () => {
    const now = 1_800_000_000;
    const fixture = tokenFixture({ now });
    const original = validateTokenResponse(fixture.response);
    const verify = (response) =>
      verifyTokenSet({
        tokenResponse: response,
        jwks: fixture.jwks,
        expectedNonce: "nonce-value-is-long-enough",
        nowSeconds: now,
      });
    const idCases = [
      { jti: undefined },
      { sid: undefined },
      { auth_time: undefined },
      { auth_time: -1 },
      { auth_time: now + 61 },
      { exp: now + 301 },
      { iat: now + 61, exp: now + 300 },
      { exp: now },
      { token_use: "access" },
    ];
    for (const overrides of idCases) {
      expect(() =>
        verify({
          ...original,
          idToken: replaceJwt(fixture.privateKey, original.idToken, overrides),
        }),
      ).toThrow();
    }
    expect(verify({
      ...original,
      accessToken: "opaque~replacement.access-token-value",
    }).passportUserId).toBe(PASSPORT_USER_ID);
  });

  it("rejects malformed JWT encodings, algorithms, keys and signatures", () => {
    const now = 1_800_000_000;
    const fixture = tokenFixture({ now });
    const original = validateTokenResponse(fixture.response);
    const idToken = original.idToken;
    const verifyId = (token, jwks = fixture.jwks) =>
      verifyTokenSet({
        tokenResponse: { ...original, idToken: token },
        jwks,
        expectedNonce: "nonce-value-is-long-enough",
        nowSeconds: now,
      });
    const malformed = [
      null,
      "x".repeat(32 * 1024 + 1),
      "one.two",
      `!.${idToken.split(".")[1]}.${idToken.split(".")[2]}`,
      `${base64urlJson([])}.${idToken.split(".")[1]}.${idToken.split(".")[2]}`,
      `${idToken.split(".")[0]}.${base64urlJson([])}.${idToken.split(".")[2]}`,
      replaceJwt(fixture.privateKey, idToken, {}, { alg: "HS256" }),
      replaceJwt(fixture.privateKey, idToken, {}, { typ: "NOT-JWT" }),
      `${idToken.split(".")[0]}.${idToken.split(".")[1]}.!`,
    ];
    for (const token of malformed) expect(() => verifyId(token)).toThrow();

    expect(() => verifyId(idToken, null)).toThrow(/JWKS/i);
    expect(() => verifyId(idToken, { keys: [] })).toThrow(/JWKS/i);
    expect(() => verifyId(idToken, { keys: [...fixture.jwks.keys, ...fixture.jwks.keys] })).toThrow(/key/i);
    expect(() => verifyId(idToken, { keys: [{ ...fixture.jwks.keys[0], kty: "EC" }] })).toThrow(/key/i);
    expect(() => verifyId(idToken, { keys: [{ ...fixture.jwks.keys[0], n: "A" }] })).toThrow(/key/i);
  });

  it("validates userinfo optional profile fields without accepting identity hints", () => {
    const base = { sub: PASSPORT_USER_ID, profile_version: 2 };
    expect(validateUserInfo(base, PASSPORT_USER_ID)).toEqual({
      passportUserId: PASSPORT_USER_ID,
      nickname: null,
      picture: null,
      profileVersion: 2,
    });
    expect(validateUserInfo({ ...base, name: "   " }, PASSPORT_USER_ID).nickname).toBeNull();
    const invalid = [
      null,
      { sub: "bad", profile_version: 1 },
      { ...base, name: 42 },
      { ...base, name: "x".repeat(65) },
      { ...base, name: "bad\nname" },
      { ...base, picture: 42 },
      { ...base, picture: "not a url" },
      { ...base, picture: `${OIDC_ISSUER}/api/profile/avatar/${PASSPORT_USER_ID}#fragment` },
      { ...base, profile_version: undefined },
      { ...base, profile_version: 0 },
    ];
    for (const value of invalid) {
      expect(() => validateUserInfo(value, PASSPORT_USER_ID)).toThrow();
    }
  });
});
