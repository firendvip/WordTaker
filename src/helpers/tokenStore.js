/**
 * 后端登录态（JWT）存储。仅主进程持有。
 *
 * 在 userData 下 backend-token.json 存/读 token（accessToken + 账号摘要）。
 * 渲染层不直接持有密钥，只经白名单 IPC 触发 get/set/clear。
 *
 * 结构：
 *   { accessToken, account: { userId, registered, nickname, inviteCode, ... }, savedAt }
 */

const fs = require("fs");
const path = require("path");

const FILE_NAME = "backend-token.json";

let _cached = undefined; // undefined=未读, null=无, object=有

function userDataDir() {
  const { app } = require("electron");
  return app.getPath("userData");
}

function filePath() {
  return path.join(userDataDir(), FILE_NAME);
}

/** 读取当前登录态；无则返回 null。异常一律返回 null（视为未登录）。 */
function get() {
  if (_cached !== undefined) return _cached;
  try {
    const fp = filePath();
    if (!fs.existsSync(fp)) {
      _cached = null;
      return null;
    }
    const raw = fs.readFileSync(fp, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj.accessToken === "string" && obj.accessToken) {
      _cached = obj;
      return obj;
    }
    _cached = null;
    return null;
  } catch (e) {
    _cached = null;
    return null;
  }
}

/** 仅返回 accessToken（无则 null）。 */
function getAccessToken() {
  const t = get();
  return t && t.accessToken ? t.accessToken : null;
}

/**
 * 写入登录态。data 至少含 accessToken；account 为账号摘要（可空）。
 * 返回是否成功持久化（失败也更新内存缓存，保证本次会话可用）。
 */
function set(data) {
  if (!data || typeof data.accessToken !== "string" || !data.accessToken) {
    throw new Error("tokenStore.set 需要 accessToken");
  }
  const payload = {
    accessToken: data.accessToken,
    account: data.account ?? null,
    savedAt: new Date().toISOString(),
  };
  _cached = payload;
  try {
    fs.writeFileSync(filePath(), JSON.stringify(payload), {
      encoding: "utf8",
      mode: 0o600,
    });
    return true;
  } catch (e) {
    return false;
  }
}

/** 清除登录态（退出登录）。 */
function clear() {
  _cached = null;
  try {
    const fp = filePath();
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { get, getAccessToken, set, clear };
