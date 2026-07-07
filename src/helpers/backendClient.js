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

function makeError(kind, message, extra = {}) {
  const err = new Error(message);
  err.kind = kind;
  Object.assign(err, extra);
  return err;
}

function baseUrl() {
  return `${AI_BACKEND_URL}${API_PREFIX}`;
}

// 组装公共头：device / platform / fingerprint / Bearer。
function buildHeaders(extra = {}) {
  const headers = {
    "Content-Type": "application/json",
    "x-device-id": deviceIdentity.getDeviceId(),
    "x-platform": CLIENT_PLATFORM,
    ...extra,
  };
  const token = tokenStore.getAccessToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/**
 * 统一请求。成功返回后端 JSON（已解析）；失败抛结构化错误。
 * 只对「后端计费接口」用超时（避免后端挂死），到点 abort → timeout 错误。
 */
async function request(pathname, { method = "GET", body = null, timeoutMs } = {}) {
  const url = `${baseUrl()}${pathname}`;
  const controller = new AbortController();
  const to = timeoutMs ?? BACKEND_REQUEST_TIMEOUT_MS;
  const timer = to > 0 ? setTimeout(() => controller.abort(), to) : null;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: buildHeaders(),
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
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
    throw makeError("http", message, { status: res.status, code, body: json });
  }

  return json;
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
// 后端 dev 验证码固定 000000。登录/注册可带 inviteCode、deviceId（匿名合并）。

async function authSmsSend(phone) {
  return request("/auth/sms/send", { method: "POST", body: { phone } });
}
async function authSmsLogin(phone, code, inviteCode) {
  const body = { phone, code };
  if (inviteCode) body.inviteCode = inviteCode;
  body.deviceId = deviceIdentity.getDeviceId();
  return request("/auth/sms/login", { method: "POST", body });
}
async function authEmailSend(email) {
  return request("/auth/email/send", { method: "POST", body: { email } });
}
async function authEmailLogin(email, code, inviteCode) {
  const body = { email, code };
  if (inviteCode) body.inviteCode = inviteCode;
  body.deviceId = deviceIdentity.getDeviceId();
  return request("/auth/email/login", { method: "POST", body });
}
async function authMe() {
  return request("/auth/me", { method: "GET" });
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
  const body = { code, deviceId: deviceIdentity.getDeviceId() };
  if (inviteCode) body.inviteCode = inviteCode;
  return request("/auth/wechat/callback", { method: "POST", body });
}

module.exports = {
  request,
  polish,
  getQuota,
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
