/**
 * 收费后端（ai-input-method-server）统一 API client。仅主进程使用。
 *
 * 自动注入请求头：x-device-id、x-platform: mac、x-fingerprint（可空）、
 * 以及登录后 Authorization: Bearer <token>。access 过期时自动用主进程持有的
 * refresh token 单飞续期并重试一次，renderer 不接触任何凭据。
 *
 * 抛出的错误统一为「结构化错误」：Error 对象附带
 *   err.kind        —— 'network' | 'timeout' | 'http' | 'auth'
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

let refreshInFlight = null;

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
function buildHeaders(extra = {}, accessToken = tokenStore.getAccessToken()) {
  const headers = {
    "Content-Type": "application/json",
    "x-device-id": deviceIdentity.getDeviceId(),
    "x-platform": CLIENT_PLATFORM,
    ...extra,
  };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  return headers;
}

/**
 * 执行一次请求，不负责刷新。accessToken 显式传 null 时不带 Authorization。
 */
async function requestOnce(
  pathname,
  { method = "GET", body = null, timeoutMs, accessToken } = {},
) {
  const url = `${baseUrl()}${pathname}`;
  const controller = new AbortController();
  const to = timeoutMs ?? BACKEND_REQUEST_TIMEOUT_MS;
  const timer = to > 0 ? setTimeout(() => controller.abort(), to) : null;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: buildHeaders({}, accessToken),
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

function sessionChangedError() {
  return makeError("auth", "登录状态已变更", { code: "SESSION_CHANGED" });
}

function clearRejectedSession(generation, refreshToken) {
  if (
    tokenStore.getGeneration() === generation &&
    tokenStore.getRefreshToken() === refreshToken
  ) {
    if (!tokenStore.clear()) {
      throw makeError("auth", "登录已失效，本地凭据清理失败，请重试退出登录", {
        status: 401,
        code: "AUTH_LOGOUT_PERSISTENCE_FAILED",
      });
    }
  }
}

/** 单飞刷新：并发 401 共用一次刷新；断网/超时/5xx 不清本地凭据。 */
function refreshSession(generation) {
  if (tokenStore.getGeneration() !== generation) {
    return Promise.reject(sessionChangedError());
  }
  if (refreshInFlight?.generation === generation) return refreshInFlight.promise;

  const refreshToken = tokenStore.getRefreshToken();
  if (!refreshToken) {
    return Promise.reject(
      makeError("auth", "当前登录缺少刷新凭证", { code: "NO_REFRESH_TOKEN" }),
    );
  }

  const flight = { generation, promise: null };
  flight.promise = (async () => {
    let json;
    try {
      json = await requestOnce("/auth/refresh", {
        method: "POST",
        body: { refresh_token: refreshToken },
        accessToken: null,
      });
    } catch (error) {
      if (tokenStore.getGeneration() !== generation) throw sessionChangedError();
      // refresh 端点 401 是服务端对刷新凭证的明确拒绝（过期/撤销/账号停用）。
      // 网络、超时与 5xx 仅是暂时不可验证，绝不能清除会话。
      if (error?.status === 401) clearRejectedSession(generation, refreshToken);
      throw error;
    }

    const data = (json && json.data) || {};
    if (
      json?.success !== true ||
      typeof data.accessToken !== "string" ||
      !data.accessToken.trim() ||
      typeof data.refreshToken !== "string" ||
      !data.refreshToken.trim()
    ) {
      throw makeError("auth", "刷新登录返回无效", { code: "INVALID_REFRESH_RESPONSE" });
    }

    const applied = tokenStore.replaceTokensIfCurrent(
      generation,
      refreshToken,
      { accessToken: data.accessToken, refreshToken: data.refreshToken },
    );
    if (!applied) throw sessionChangedError();
    return data.accessToken;
  })().finally(() => {
    // 新会话可能已开始自己的刷新；旧请求结束不能清掉新会话的单飞引用。
    if (refreshInFlight === flight) refreshInFlight = null;
  });
  refreshInFlight = flight;
  return flight.promise;
}

/**
 * 请求绑定起始会话。access 失效时自动刷新并只重试一次；只有 refresh 被
 * 明确拒绝或新 access 仍被 401 拒绝才清凭据，暂时网络/服务故障保留登录态。
 */
async function request(pathname, options = {}) {
  const accessToken = tokenStore.getAccessToken();
  const generation = tokenStore.getGeneration();
  try {
    const result = await requestOnce(pathname, { ...options, accessToken });
    if (tokenStore.getGeneration() !== generation) throw sessionChangedError();
    return result;
  } catch (error) {
    if (tokenStore.getGeneration() !== generation) throw sessionChangedError();
    if (error?.status !== 401 || !accessToken || pathname === "/auth/refresh") {
      throw error;
    }

    // 其它请求可能已经完成刷新；此时直接使用新 access 重试，避免二次刷新。
    let retryAccessToken = tokenStore.getAccessToken();
    if (!retryAccessToken || retryAccessToken === accessToken) {
      try {
        retryAccessToken = await refreshSession(generation);
      } catch (refreshError) {
        // 存量旧客户端会话没有 refresh：保留仍可恢复的本地登录摘要，不误清。
        if (refreshError?.code === "NO_REFRESH_TOKEN") throw error;
        throw refreshError;
      }
    }

    if (tokenStore.getGeneration() !== generation) throw sessionChangedError();
    try {
      const result = await requestOnce(pathname, {
        ...options,
        accessToken: retryAccessToken,
      });
      if (tokenStore.getGeneration() !== generation) throw sessionChangedError();
      return result;
    } catch (retryError) {
      if (tokenStore.getGeneration() !== generation) throw sessionChangedError();
      if (
        retryError?.status === 401 &&
        tokenStore.getAccessToken() === retryAccessToken
      ) {
        clearRejectedSession(generation, tokenStore.getRefreshToken());
      }
      throw retryError;
    }
  }
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
 * 拉取本地模型系统提示词（后端下发，匿名设备可取）。GET /prompt?mode=normal|polish|translate_en。
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
// 查当前账号的具体订单; 服务端验签查单并完成入账后才返回 paid。
async function getPaymentOrder(orderId) {
  const json = await request(`/payment/order/${encodeURIComponent(String(orderId))}`, { method: "GET" });
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
async function authMe() {
  return request("/auth/me", { method: "GET" });
}

module.exports = {
  request,
  polish,
  getQuota,
  getLocalPrompt,
  // CP3 会员/计费
  listPlans,
  createOrder,
  getPaymentOrder,
  mockPay,
  redeem,
  // CP2 登录
  authSmsSend,
  authSmsLogin,
  authMe,
};
