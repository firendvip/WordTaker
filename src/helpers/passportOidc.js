const {
  createHash,
  createPublicKey,
  randomBytes: nodeRandomBytes,
  timingSafeEqual,
  verify: verifySignature,
} = require("crypto");

const OIDC_ISSUER = "https://auth.yaa3.com";
const DISCOVERY_URL = `${OIDC_ISSUER}/.well-known/openid-configuration`;
const CLIENT_ID = "wordtaker-desktop";
const REDIRECT_URI = "wangsan-wordtaker://oauth/callback";
const REQUESTED_SCOPES = Object.freeze([
  "openid",
  "profile",
  "offline_access",
  "aim.api",
]);
const REQUESTED_SCOPE = REQUESTED_SCOPES.join(" ");

const OPAQUE_PARAMETER = /^[A-Za-z0-9._~-]{16,512}$/;
const PKCE_VALUE = /^[A-Za-z0-9_-]{43,128}$/;
const AUTHORIZATION_CODE = /^ac1\.[A-Za-z0-9_-]{43}$/;
const REFRESH_TOKEN = /^rt1\.[A-Za-z0-9_-]{43}$/;
const JWT_PART = /^[A-Za-z0-9_-]+$/;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_URL_LENGTH = 4096;
const MAX_JWT_LENGTH = 32 * 1024;
const CLOCK_SKEW_SECONDS = 60;

class PassportAuthError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "PassportAuthError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable === true;
    this.stateValidated = options.stateValidated === true;
    if (options.cause) this.cause = options.cause;
  }
}

function fail(code, message, options) {
  throw new PassportAuthError(code, message, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsAsciiControl(value, { includeSpace = false } = {}) {
  const upper = includeSpace ? 32 : 31;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= upper || code === 127) return true;
  }
  return false;
}

function hasEvery(value, expected) {
  return Array.isArray(value) && expected.every((item) => value.includes(item));
}

function validateEndpoint(value, label) {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
    return fail("INVALID_DISCOVERY", `OIDC discovery ${label} endpoint 无效`);
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.origin !== OIDC_ISSUER ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname === "/"
    ) {
      return fail("INVALID_DISCOVERY", `OIDC discovery ${label} endpoint 无效`);
    }
    return url.toString();
  } catch {
    return fail("INVALID_DISCOVERY", `OIDC discovery ${label} endpoint 无效`);
  }
}

function validateDiscovery(raw) {
  if (!isPlainObject(raw) || raw.issuer !== OIDC_ISSUER) {
    return fail("INVALID_DISCOVERY", "OIDC discovery issuer 不匹配");
  }
  if (!hasEvery(raw.response_types_supported, ["code"])) {
    return fail("INVALID_DISCOVERY", "OIDC discovery 不支持 authorization code");
  }
  if (!hasEvery(raw.grant_types_supported, ["authorization_code", "refresh_token"])) {
    return fail("INVALID_DISCOVERY", "OIDC discovery grant type 不完整");
  }
  if (!hasEvery(raw.code_challenge_methods_supported, ["S256"])) {
    return fail("INVALID_DISCOVERY", "OIDC discovery 不支持 S256 PKCE");
  }
  if (!hasEvery(raw.id_token_signing_alg_values_supported, ["RS256"])) {
    return fail("INVALID_DISCOVERY", "OIDC discovery 不支持 RS256");
  }
  if (!hasEvery(raw.token_endpoint_auth_methods_supported, ["none"])) {
    return fail("INVALID_DISCOVERY", "OIDC discovery 不支持 native public client");
  }
  if (!hasEvery(raw.scopes_supported, REQUESTED_SCOPES)) {
    return fail("INVALID_DISCOVERY", "OIDC discovery scope 不完整");
  }
  return Object.freeze({
    issuer: raw.issuer,
    authorizationEndpoint: validateEndpoint(raw.authorization_endpoint, "authorization"),
    tokenEndpoint: validateEndpoint(raw.token_endpoint, "token"),
    userinfoEndpoint: validateEndpoint(raw.userinfo_endpoint, "userinfo"),
    jwksUri: validateEndpoint(raw.jwks_uri, "JWKS"),
    revocationEndpoint: validateEndpoint(raw.revocation_endpoint, "revocation"),
  });
}

function entropy(randomBytes, size, label) {
  const bytes = randomBytes(size);
  if (!Buffer.isBuffer(bytes) || bytes.length !== size) {
    return fail("ENTROPY_UNAVAILABLE", `${label} 随机数生成失败`);
  }
  return bytes.toString("base64url");
}

function createAuthorizationRequest({
  discovery,
  randomBytes = nodeRandomBytes,
  now = Date.now,
} = {}) {
  if (!discovery || typeof discovery.authorizationEndpoint !== "string") {
    return fail("INVALID_DISCOVERY", "尚未取得可信 OIDC discovery");
  }
  const state = entropy(randomBytes, 24, "state");
  const nonce = entropy(randomBytes, 24, "nonce");
  const codeVerifier = entropy(randomBytes, 32, "PKCE");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier, "ascii")
    .digest("base64url");
  if (
    !OPAQUE_PARAMETER.test(state) ||
    !OPAQUE_PARAMETER.test(nonce) ||
    !PKCE_VALUE.test(codeVerifier) ||
    !PKCE_VALUE.test(codeChallenge)
  ) {
    return fail("ENTROPY_UNAVAILABLE", "OAuth 随机参数格式无效");
  }
  const url = new URL(discovery.authorizationEndpoint);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", REQUESTED_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return Object.freeze({
    authorizationUrl: url.toString(),
    state,
    nonce,
    codeVerifier,
    createdAt: Number(now()),
  });
}

function exactCallbackUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    return null;
  }
  if (containsAsciiControl(raw)) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "wangsan-wordtaker:" ||
      url.hostname !== "oauth" ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/callback" ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function extractCallbackUrl(argv) {
  if (!Array.isArray(argv)) return null;
  for (const argument of argv) {
    if (exactCallbackUrl(argument)) return argument;
  }
  return null;
}

function singleQueryValue(url, name, required = false) {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) return fail("INVALID_CALLBACK", `OAuth callback duplicate ${name}`);
  if (required && values.length !== 1) {
    return fail("INVALID_CALLBACK", `OAuth callback 缺少 ${name}`);
  }
  return values[0] ?? null;
}

function safeOpaqueEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function parseCallbackUrl(raw, expectedState) {
  const url = exactCallbackUrl(raw);
  if (!url) return fail("INVALID_CALLBACK", "OAuth callback 地址无效");
  const allowed = new Set(["code", "state", "error", "error_description"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) return fail("INVALID_CALLBACK", "OAuth callback 含未知参数");
  }
  const state = singleQueryValue(url, "state", true);
  if (!OPAQUE_PARAMETER.test(state) || !safeOpaqueEqual(state, expectedState)) {
    return fail("STATE_MISMATCH", "OAuth state 校验失败");
  }
  const errorCode = singleQueryValue(url, "error");
  singleQueryValue(url, "error_description");
  if (errorCode) {
    const safeMessage = errorCode === "access_denied" ? "授权已取消" : "统一登录授权失败";
    return fail(errorCode, safeMessage, { stateValidated: true });
  }
  const code = singleQueryValue(url, "code", true);
  if (!AUTHORIZATION_CODE.test(code)) {
    return fail("INVALID_CALLBACK", "OAuth authorization code 无效");
  }
  return Object.freeze({ code, state });
}

function validateTokenString(value, name, maximum = MAX_JWT_LENGTH) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > maximum ||
    containsAsciiControl(value, { includeSpace: true })
  ) {
    return fail("INVALID_TOKEN_RESPONSE", `${name} 无效`);
  }
  return value;
}

function normalizedScope(raw) {
  if (typeof raw !== "string" || raw.length > 512 || containsAsciiControl(raw)) {
    return fail("INVALID_TOKEN_RESPONSE", "token scope 无效");
  }
  const values = raw.split(" ").filter(Boolean);
  if (values.length !== new Set(values).size || !REQUESTED_SCOPES.every((scope) => values.includes(scope))) {
    return fail("INVALID_TOKEN_RESPONSE", "token scope 缺少授权范围");
  }
  return values.join(" ");
}

function commonTokenFields(raw) {
  if (!isPlainObject(raw)) return fail("INVALID_TOKEN_RESPONSE", "token response 无效");
  if (typeof raw.token_type !== "string" || raw.token_type.toLowerCase() !== "bearer") {
    return fail("INVALID_TOKEN_RESPONSE", "token_type 必须是 Bearer");
  }
  if (!Number.isSafeInteger(raw.expires_in) || raw.expires_in < 60 || raw.expires_in > 86400) {
    return fail("INVALID_TOKEN_RESPONSE", "expires_in 无效");
  }
  const refreshToken = validateTokenString(raw.refresh_token, "refresh_token", 1024);
  if (!REFRESH_TOKEN.test(refreshToken)) {
    return fail("INVALID_TOKEN_RESPONSE", "refresh_token 无效");
  }
  return {
    accessToken: validateTokenString(raw.access_token, "access_token"),
    refreshToken,
    tokenType: "Bearer",
    expiresIn: raw.expires_in,
    scope: normalizedScope(raw.scope),
  };
}

function validateTokenResponse(raw) {
  return Object.freeze({
    ...commonTokenFields(raw),
    idToken: validateTokenString(raw.id_token, "id_token"),
  });
}

function validateRefreshTokenResponse(raw) {
  return Object.freeze(commonTokenFields(raw));
}

function extractRefreshTokenCandidate(raw) {
  if (!isPlainObject(raw)) return null;
  return typeof raw.refresh_token === "string" && REFRESH_TOKEN.test(raw.refresh_token)
    ? raw.refresh_token
    : null;
}

function decodeJwtPart(part, label) {
  if (!JWT_PART.test(part) || part.length > MAX_JWT_LENGTH) {
    return fail("INVALID_TOKEN", `${label} JWT 编码无效`);
  }
  try {
    const bytes = Buffer.from(part, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== part) {
      return fail("INVALID_TOKEN", `${label} JWT 编码无效`);
    }
    const value = JSON.parse(bytes.toString("utf8"));
    if (!isPlainObject(value)) return fail("INVALID_TOKEN", `${label} JWT 内容无效`);
    return value;
  } catch (error) {
    if (error instanceof PassportAuthError) throw error;
    return fail("INVALID_TOKEN", `${label} JWT 内容无效`);
  }
}

function selectVerificationKey(jwks, kid) {
  if (!isPlainObject(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length < 1 || jwks.keys.length > 16) {
    return fail("INVALID_JWKS", "OIDC JWKS 无效");
  }
  const matches = jwks.keys.filter((key) => isPlainObject(key) && key.kid === kid);
  if (matches.length !== 1) return fail("INVALID_JWKS", "OIDC signing key 不唯一");
  const key = matches[0];
  if (
    key.kty !== "RSA" ||
    key.alg !== "RS256" ||
    key.use !== "sig" ||
    typeof key.n !== "string" ||
    typeof key.e !== "string" ||
    !JWT_PART.test(key.n) ||
    !JWT_PART.test(key.e) ||
    key.n.length < 342 ||
    key.n.length > 1024 ||
    key.e.length < 3 ||
    key.e.length > 8
  ) {
    return fail("INVALID_JWKS", "OIDC signing key 无效");
  }
  try {
    return createPublicKey({ key, format: "jwk" });
  } catch {
    return fail("INVALID_JWKS", "OIDC signing key 无法解析");
  }
}

function verifySignedJwt(token, jwks) {
  if (typeof token !== "string" || token.length > MAX_JWT_LENGTH) {
    return fail("INVALID_TOKEN", "JWT 无效");
  }
  const parts = token.split(".");
  if (parts.length !== 3) return fail("INVALID_TOKEN", "JWT 无效");
  const header = decodeJwtPart(parts[0], "header");
  const payload = decodeJwtPart(parts[1], "payload");
  if (header.alg !== "RS256" || !KEY_ID.test(header.kid || "") || (header.typ && header.typ !== "JWT")) {
    return fail("INVALID_TOKEN", "JWT algorithm 或 key id 无效");
  }
  let signature;
  try {
    signature = Buffer.from(parts[2], "base64url");
    if (signature.length === 0 || signature.toString("base64url") !== parts[2]) throw new Error("bad");
  } catch {
    return fail("INVALID_TOKEN", "JWT signature 编码无效");
  }
  const key = selectVerificationKey(jwks, header.kid);
  const valid = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
    key,
    signature,
  );
  if (!valid) return fail("INVALID_TOKEN", "JWT signature 校验失败");
  return payload;
}

function validateCommonClaims(payload, nowSeconds, maximumLifetimeSeconds) {
  if (
    payload.iss !== OIDC_ISSUER ||
    payload.aud !== CLIENT_ID ||
    typeof payload.sub !== "string" ||
    !UUID.test(payload.sub) ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    typeof payload.jti !== "string" ||
    !UUID.test(payload.jti)
  ) {
    return fail("INVALID_TOKEN", "OIDC token claims 无效");
  }
  if (payload.exp < nowSeconds - CLOCK_SKEW_SECONDS) {
    return fail("INVALID_TOKEN", "OIDC token expired");
  }
  if (
    payload.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > maximumLifetimeSeconds
  ) {
    return fail("INVALID_TOKEN", "OIDC token lifetime 无效");
  }
  return payload.sub.toLowerCase();
}

function verifyIdToken(idToken, { jwks, expectedNonce, nowSeconds }) {
  const payload = verifySignedJwt(idToken, jwks);
  const passportUserId = validateCommonClaims(payload, nowSeconds, 5 * 60);
  if (
    payload.token_use !== "id" ||
    !safeOpaqueEqual(payload.nonce, expectedNonce) ||
    typeof payload.sid !== "string" ||
    !UUID.test(payload.sid)
  ) {
    return fail("INVALID_TOKEN", "OIDC ID token nonce 无效");
  }
  if (
    !Number.isSafeInteger(payload.auth_time) ||
    payload.auth_time < 0 ||
    payload.auth_time > payload.iat + CLOCK_SKEW_SECONDS
  ) {
    return fail("INVALID_TOKEN", "OIDC auth_time 无效");
  }
  return {
    payload,
    passportUserId,
    centralSessionId: payload.sid.toLowerCase(),
  };
}

function verifyAccessToken(accessToken, { jwks, nowSeconds }) {
  const payload = verifySignedJwt(accessToken, jwks);
  const passportUserId = validateCommonClaims(payload, nowSeconds, 15 * 60);
  if (
    payload.token_use !== "access" ||
    typeof payload.scope !== "string" ||
    typeof payload.sid !== "string" ||
    !UUID.test(payload.sid)
  ) {
    return fail("INVALID_TOKEN", "OIDC access token claims 无效");
  }
  normalizedScope(payload.scope);
  return {
    payload,
    passportUserId,
    centralSessionId: payload.sid.toLowerCase(),
  };
}

function verifyTokenSet({ tokenResponse, jwks, expectedNonce, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const id = verifyIdToken(tokenResponse.idToken, { jwks, expectedNonce, nowSeconds });
  const access = verifyAccessToken(tokenResponse.accessToken, { jwks, nowSeconds });
  if (id.passportUserId !== access.passportUserId) {
    return fail("INVALID_TOKEN", "OIDC token subject 不一致");
  }
  if (id.centralSessionId !== access.centralSessionId) {
    return fail("INVALID_TOKEN", "OIDC token session 不一致");
  }
  return Object.freeze({
    passportUserId: id.passportUserId,
    centralSessionId: access.centralSessionId,
    idClaims: id.payload,
    accessClaims: access.payload,
  });
}

function validateUserInfo(raw, expectedPassportUserId) {
  if (!isPlainObject(raw) || typeof raw.sub !== "string" || !UUID.test(raw.sub)) {
    return fail("INVALID_USERINFO", "OIDC userinfo sub 无效");
  }
  const passportUserId = raw.sub.toLowerCase();
  if (passportUserId !== String(expectedPassportUserId || "").toLowerCase()) {
    return fail("INVALID_USERINFO", "OIDC userinfo sub 不匹配");
  }
  let nickname = null;
  if (raw.name !== undefined && raw.name !== null) {
    if (typeof raw.name !== "string") return fail("INVALID_USERINFO", "OIDC userinfo name 无效");
    nickname = raw.name.trim().normalize("NFC");
    if (nickname.length === 0) nickname = null;
    if (nickname && ([...nickname].length > 64 || containsAsciiControl(nickname))) {
      return fail("INVALID_USERINFO", "OIDC userinfo name 无效");
    }
  }
  let picture = null;
  if (raw.picture !== undefined && raw.picture !== null) {
    if (typeof raw.picture !== "string" || raw.picture.length > MAX_URL_LENGTH) {
      return fail("INVALID_USERINFO", "OIDC userinfo picture 无效");
    }
    try {
      const url = new URL(raw.picture);
      const expectedPath = `/api/profile/avatar/${passportUserId}`;
      if (
        url.origin !== OIDC_ISSUER ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== expectedPath
      ) {
        return fail("INVALID_USERINFO", "OIDC userinfo picture 无效");
      }
      picture = url.toString();
    } catch (error) {
      if (error instanceof PassportAuthError) throw error;
      return fail("INVALID_USERINFO", "OIDC userinfo picture 无效");
    }
  }
  const profileVersion = raw.profile_version;
  if (!Number.isSafeInteger(profileVersion) || profileVersion < 1) {
    return fail("INVALID_USERINFO", "OIDC userinfo profile_version 无效");
  }
  return Object.freeze({ passportUserId, nickname, picture, profileVersion });
}

module.exports = {
  AUTHORIZATION_CODE,
  CLIENT_ID,
  DISCOVERY_URL,
  OIDC_ISSUER,
  PassportAuthError,
  REDIRECT_URI,
  REQUESTED_SCOPE,
  REQUESTED_SCOPES,
  createAuthorizationRequest,
  extractRefreshTokenCandidate,
  extractCallbackUrl,
  parseCallbackUrl,
  validateDiscovery,
  validateRefreshTokenResponse,
  validateTokenResponse,
  validateUserInfo,
  verifyAccessToken,
  verifyTokenSet,
};
