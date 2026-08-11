/**
 * 收费后端（ai-input-method-server）统一 API client。仅主进程使用。
 *
 * 自动注入请求头：x-device-id、x-platform: mac、x-fingerprint（可空）、
 * 以及登录后 Authorization: Bearer <token>。
 *
 * 抛出的错误统一为「结构化错误」：Error 对象附带
 *   err.kind        —— 'network' | 'timeout' | 'http'
 *   err.code        —— 后端业务码（如 INSUFFICIENT_QUOTA / DAILY_CAP_EXCEEDED），若有
 *   err.status      —— HTTP 状态码（http 错误时）
 * 调用方据 kind/code 决定：贴原文+提示 / 降级回退 relay / 其它。
 */

const {
  AI_BACKEND_URL,
  API_PREFIX,
  CLIENT_PLATFORM,
  BACKEND_REQUEST_TIMEOUT_MS,
} = require("./backendConfig");
const deviceIdentity = require("./deviceIdentity");
const tokenStore = require("./tokenStore");
const { fetchWithAuthFallback } = require("./authenticatedFetch");

let authFailureHandler = null;
let sensitiveAuthPreflightHandler = null;
const SENSITIVE_AUTH_PATHS = new Set([
  "/polish",
  "/payment/order",
  "/payment/mock/pay",
  "/redeem",
]);

function setAuthFailureHandler(handler) {
  if (handler !== null && typeof handler !== "function") {
    throw new TypeError("auth failure handler must be a function or null");
  }
  authFailureHandler = handler;
}

function setSensitiveAuthPreflightHandler(handler) {
  if (handler !== null && typeof handler !== "function") {
    throw new TypeError("sensitive auth preflight handler must be a function or null");
  }
  sensitiveAuthPreflightHandler = handler;
}

function makeError(kind, message, extra = {}) {
  const err = new Error(message);
  err.kind = kind;
  Object.assign(err, extra);
  return err;
}

function baseUrl() {
  return `${AI_BACKEND_URL}${API_PREFIX}`;
}

// 组装公共头：device / platform。Bearer 由 authenticatedFetch 按来源注入，
// 以便统一通行证灰度期间保留旧 AIM 会话的只读回退。
function buildHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    "x-device-id": deviceIdentity.getDeviceId(),
    "x-platform": CLIENT_PLATFORM,
    ...extra,
  };
}

function captureAuthSnapshot(method, authPurpose) {
  const credentials = tokenStore
    .getAccessTokenCandidates({ method, purpose: authPurpose })
    .map((credential) => ({ ...credential }));
  const passport = tokenStore.getPassport();
  const passportIdentity = passport
    ? {
        issuer: passport.issuer,
        passport_user_id: passport.account?.passport_user_id || null,
      }
    : null;
  const authContext = {
    passport: credentials.some((credential) => credential.provider === "passport")
      ? {
          identity: passportIdentity,
          generation: tokenStore.getProviderGeneration("passport"),
        }
      : null,
    legacy: credentials.some((credential) => credential.provider === "legacy")
      ? { generation: tokenStore.getProviderGeneration("legacy") }
      : null,
  };
  return { credentials, passportIdentity, authContext };
}

function sameIdentity(left, right) {
  if (left === null || right === null) return left === right;
  return (
    left?.issuer === right?.issuer &&
    left?.passport_user_id === right?.passport_user_id
  );
}

function sameAuthContext(left, right) {
  return (
    left?.passport?.generation === right?.passport?.generation &&
    sameIdentity(left?.passport?.identity || null, right?.passport?.identity || null) &&
    left?.legacy?.generation === right?.legacy?.generation
  );
}

function sameAuthSnapshot(left, right) {
  return (
    left.credentials.length === right.credentials.length &&
    left.credentials.every((credential, index) => (
      credential.provider === right.credentials[index]?.provider &&
      credential.accessToken === right.credentials[index]?.accessToken
    )) &&
    sameAuthContext(left.authContext, right.authContext)
  );
}

function primaryAuthEvidence(snapshot) {
  const provider = snapshot.credentials[0]?.provider || null;
  if (!provider) return { provider: null, generation: null, identity: null };
  return {
    provider,
    generation: snapshot.authContext[provider]?.generation ?? null,
    identity: provider === "passport" ? snapshot.passportIdentity : null,
  };
}

function approvalMatchesInitialIdentity(initialSnapshot, approvedCredential) {
  const initial = primaryAuthEvidence(initialSnapshot);
  if (initial.provider) {
    return (
      approvedCredential.provider === initial.provider &&
      (initial.provider !== "passport" ||
        sameIdentity(initial.identity, approvedCredential.identity || null))
    );
  }
  return (
    approvedCredential.provider === "passport" &&
    sameIdentity(initialSnapshot.passportIdentity, approvedCredential.identity || null)
  );
}

function matchesApprovedCredential(snapshot, approvedCredential, initialSnapshot) {
  if (!approvedCredential || !["passport", "legacy"].includes(approvedCredential.provider)) {
    return false;
  }
  const current = primaryAuthEvidence(snapshot);
  return (
    approvalMatchesInitialIdentity(initialSnapshot, approvedCredential) &&
    current.provider === approvedCredential.provider &&
    current.generation === approvedCredential.generation &&
    sameIdentity(current.identity, approvedCredential.identity || null)
  );
}

function publicAuthSnapshot(snapshot) {
  return {
    credentials: snapshot.credentials.map(({ provider }) => ({ provider })),
    authContext: {
      passport: snapshot.authContext.passport
        ? {
            generation: snapshot.authContext.passport.generation,
            identity: snapshot.authContext.passport.identity
              ? { ...snapshot.authContext.passport.identity }
              : null,
          }
        : null,
      legacy: snapshot.authContext.legacy
        ? { generation: snapshot.authContext.legacy.generation }
        : null,
    },
  };
}

/**
 * 统一请求。成功返回后端 JSON（已解析）；失败抛结构化错误。
 * 只对「后端计费接口」用超时（避免后端挂死），到点 abort → timeout 错误。
 */
async function request(
  pathname,
  {
    method = "GET",
    body = null,
    timeoutMs,
    includeAuthMetadata = false,
    authPurpose = null,
  } = {},
) {
  let authSnapshot = captureAuthSnapshot(method, authPurpose);
  if (sensitiveAuthPreflightHandler && SENSITIVE_AUTH_PATHS.has(pathname)) {
    const approval = await sensitiveAuthPreflightHandler({
      pathname,
      method,
      authSnapshot: publicAuthSnapshot(authSnapshot),
    });
    const currentSnapshot = captureAuthSnapshot(method, authPurpose);
    if (approval?.refreshAuthSnapshot === true) {
      if (!matchesApprovedCredential(
        currentSnapshot,
        approval.approvedCredential,
        authSnapshot,
      )) {
        throw makeError("auth", "登录状态已变化，请重试", { code: "AUTH_REQUIRED" });
      }
      authSnapshot = currentSnapshot;
    } else if (!sameAuthSnapshot(authSnapshot, currentSnapshot)) {
      throw makeError("auth", "登录状态已变化，请重试", { code: "AUTH_REQUIRED" });
    }
  }
  const url = `${baseUrl()}${pathname}`;
  const controller = new AbortController();
  const to = timeoutMs ?? BACKEND_REQUEST_TIMEOUT_MS;
  const timer = to > 0 ? setTimeout(() => controller.abort(), to) : null;

  let res;
  let authProvider = null;
  let authIdentity = null;
  let authContext = { passport: null, legacy: null };
  let rejectedProviders = [];
  try {
    const { credentials, passportIdentity } = authSnapshot;
    authContext = authSnapshot.authContext;
    const result = await fetchWithAuthFallback({
      fetchFn: fetch,
      url,
      options: {
        method,
        headers: buildHeaders(),
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      },
      credentials,
    });
    res = result.response;
    authProvider = result.provider;
    authIdentity = authProvider === "passport" ? passportIdentity : null;
    rejectedProviders = result.rejectedProviders.map((provider) => ({
      provider,
      identity: provider === "passport" ? passportIdentity : null,
      generation: authContext[provider]?.generation ?? null,
    }));
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (e && e.name === "AbortError") {
      throw makeError("timeout", "后端请求超时", { cause: e });
    }
    // 连接失败 / DNS / ECONNREFUSED 等
    throw makeError("network", `无法连接后端: ${e?.message || e}`, { cause: e });
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (authFailureHandler && rejectedProviders.length > 0) {
    await authFailureHandler(rejectedProviders);
  }

  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    // 后端业务错误体形如 { code, message } 或 NestJS 默认 { statusCode, message }
    const code = json && (json.code || json.error) ? json.code || json.error : null;
    const message =
      (json && json.message) || `后端错误 HTTP ${res.status}`;
    throw makeError("http", message, {
      status: res.status,
      code,
      body: json,
      authProvider,
      authIdentity,
      authContext,
    });
  }

  return includeAuthMetadata
    ? { response: json, authProvider, authIdentity, authContext }
    : json;
}

/**
 * 云端润色（计费）。POST /polish {text, mode, word_map?}。
 * wordMap：词转词规则数组 [{from,to}]，非空时随请求带上 word_map（与 relay 端字段名一致），供后端做替换。
 * 成功返回 { text, visibleChars, cloudRemaining, subscription, dailyUsed, dailyCap }。
 * 后端响应形状：{ success, data:{ output, visibleChars, cloudRemaining, subscription, dailyUsed, dailyCap }, error }。
 * 额度不足/超日上限由 request() 以 http 错误抛出（code=INSUFFICIENT_QUOTA / DAILY_CAP_EXCEEDED）。
 */
async function polish(text, mode, wordMap) {
  const body = { text, mode };
  if (Array.isArray(wordMap) && wordMap.length > 0) body.word_map = wordMap;
  const json = await request("/polish", {
    method: "POST",
    body,
  });
  const d = (json && json.data) || {};
  return {
    text: typeof d.output === "string" ? d.output : "",
    visibleChars: d.visibleChars ?? null,
    cloudRemaining: d.cloudRemaining ?? null,
    subscription: d.subscription ?? null,
    dailyUsed: d.dailyUsed ?? null,
    dailyCap: d.dailyCap ?? null,
  };
}

/**
 * 云端额度查询（匿名可用）。GET /quota。
 * 返回 { userId, registered, cloudRemaining, subscription, dailyUsed, dailyCap }。
 */
async function getQuota() {
  const json = await request("/quota", { method: "GET" });
  const d = (json && json.data) || {};
  return {
    userId: d.userId ?? null,
    registered: !!d.registered,
    cloudRemaining: d.cloudRemaining ?? null,
    subscription: d.subscription ?? null,
    dailyUsed: d.dailyUsed ?? null,
    dailyCap: d.dailyCap ?? null,
  };
}

/**
 * 拉取本地模型系统提示词（后端下发，匿名设备可取）。GET /prompt?mode=polish|translate_en。
 * 复用统一 request()（自动带 x-device-id/x-platform + 可选 Bearer）。
 * 用短超时（4s）：拿不到就静默降级用 llm_server 内置精简提示词，不能拖住本地润色。
 * 成功返回 data（含 { mode, systemPrompt, version }）；失败抛结构化错误由调用方降级。
 */
async function getLocalPrompt(mode) {
  const json = await request(`/prompt?mode=${encodeURIComponent(mode)}`, {
    method: "GET",
    timeoutMs: 4000,
  });
  return (json && json.data) || null;
}

// —— CP3 会员/计费：套餐 / 下单 / dev 直付 / 兑换码 ——
// 套餐列表（公开，无需 Bearer）。返回 { data:[{code,name,priceCents,type,charAmount,validityDays,durationDays}] }。
async function listPlans() {
  const json = await request("/payment/plans", { method: "GET" });
  const d = (json && json.data) || [];
  return Array.isArray(d) ? d : [];
}
// 下单（Bearer）。返回 { data:{ orderId, outTradeNo, planCode, priceCents, kind, channel, payload } }。
async function createOrder(planCode, channel) {
  const json = await request("/payment/order", {
    method: "POST",
    body: { planCode, channel },
  });
  return (json && json.data) || {};
}
// dev 直付（Bearer）。返回 { data:{ ok, message } }。
async function mockPay(orderId) {
  const json = await request("/payment/mock/pay", {
    method: "POST",
    body: { orderId: String(orderId) },
  });
  return (json && json.data) || {};
}
// 兑换码（Bearer）。返回 { data:{ charAmount, cloudRemaining } }；错误 code=INVALID_CODE/CODE_USED/CODE_EXPIRED。
async function redeem(code) {
  const json = await request("/redeem", { method: "POST", body: { code } });
  return (json && json.data) || {};
}

// —— 以下为 CP2（登录）预留的薄封装，接口以 CLIENT_INTEGRATION_SPEC 为准 ——
// 登录/注册可带 inviteCode、deviceId（后端登录不再赠送/合并，deviceGift 仅回 already_granted/no_device/invalid_device）。

// 登录 body 里的 deviceId：后端约束 8-64 位 [A-Za-z0-9._:-]。
// 硬件派生 sha256 截 32 位 hex 天然合规；仍做规整（剔除非法字符 + 截断 64），规整后不足 8 位则不带（后端按 no_device 处理）。
function loginDeviceId() {
  const raw = String(deviceIdentity.getDeviceId() || "");
  const cleaned = raw.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 64);
  return cleaned.length >= 8 ? cleaned : null;
}

async function authSmsSend(phone) {
  return request("/auth/sms/send", { method: "POST", body: { phone } });
}
async function authSmsLogin(phone, code, inviteCode) {
  const body = { phone, code };
  if (inviteCode) body.inviteCode = inviteCode;
  const did = loginDeviceId();
  if (did) body.deviceId = did;
  return request("/auth/sms/login", { method: "POST", body });
}
async function authEmailSend(email) {
  return request("/auth/email/send", { method: "POST", body: { email } });
}
async function authEmailLogin(email, code, inviteCode) {
  const body = { email, code };
  if (inviteCode) body.inviteCode = inviteCode;
  const did = loginDeviceId();
  if (did) body.deviceId = did;
  return request("/auth/email/login", { method: "POST", body });
}
async function authMe() {
  return request("/auth/me", {
    method: "GET",
    includeAuthMetadata: true,
    authPurpose: "aim-mapping",
  });
}

// 微信登录：先取官方 qrconnect 授权 URL（含 redirect_uri + state），
// 由主进程用内嵌窗承载官方页并拦截回调 code，再回传后端换取 JWT。
async function getWechatAuthUrl() {
  const json = await request("/auth/wechat/url", { method: "GET" });
  return (json && json.data) || {};
}

// 微信登录：拿到官方回调 code 后回传后端换取 JWT。
// 带 deviceId 做匿名合并、可选 inviteCode。
async function authWechatLogin(code, inviteCode) {
  const body = { code };
  const did = loginDeviceId();
  if (did) body.deviceId = did;
  if (inviteCode) body.inviteCode = inviteCode;
  return request("/auth/wechat/callback", { method: "POST", body });
}

module.exports = {
  setAuthFailureHandler,
  setSensitiveAuthPreflightHandler,
  request,
  polish,
  getQuota,
  getLocalPrompt,
  // CP3 会员/计费
  listPlans,
  createOrder,
  mockPay,
  redeem,
  // CP2 登录
  authSmsSend,
  authSmsLogin,
  authEmailSend,
  authEmailLogin,
  getWechatAuthUrl,
  authWechatLogin,
  authMe,
};
