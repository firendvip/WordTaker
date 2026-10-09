/**
 * 后端登录态安全存储。仅主进程持有，渲染层永远拿不到 token。
 *
 * v2 文件只保存 Electron safeStorage 加密后的密文；首次读取旧版明文文件时会
 * 原地迁移。refresh 写回使用会话代次做 compare-and-swap，防止退出登录后
 * 已在途的刷新请求把旧会话重新写回来。
 */

const fs = require("fs");
const path = require("path");

const FILE_NAME = "backend-token.json";
const STORE_VERSION = 2;

let _cached = undefined; // undefined=未读, null=无, object=有
let _generation = 0; // 登录/退出的会话代次；同一会话续期不改变代次。

function electronApi() {
  return require("electron");
}

function userDataDir() {
  return electronApi().app.getPath("userData");
}

function filePath() {
  return path.join(userDataDir(), FILE_NAME);
}

function normalizedSession(value) {
  if (!value || typeof value.accessToken !== "string" || !value.accessToken.trim()) {
    return null;
  }
  return {
    accessToken: value.accessToken,
    refreshToken:
      typeof value.refreshToken === "string" && value.refreshToken.trim()
        ? value.refreshToken
        : null,
    account: value.account ?? null,
    savedAt:
      typeof value.savedAt === "string" && value.savedAt
        ? value.savedAt
        : new Date().toISOString(),
  };
}

function encryptionAvailable() {
  try {
    const safeStorage = electronApi().safeStorage;
    if (safeStorage?.isEncryptionAvailable() !== true) return false;
    if (
      process.platform === "linux" &&
      safeStorage.getSelectedStorageBackend?.() === "basic_text"
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function writeEncrypted(session) {
  if (!encryptionAvailable()) return false;
  const fp = filePath();
  const temporaryPath = `${fp}.tmp`;
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const encrypted = electronApi().safeStorage
      .encryptString(JSON.stringify(session))
      .toString("base64");
    const envelope = JSON.stringify({ version: STORE_VERSION, encrypted });
    fs.writeFileSync(temporaryPath, envelope, {
      encoding: "utf8",
      mode: 0o600,
      flag: "w",
    });
    fs.renameSync(temporaryPath, fp);
    try {
      fs.chmodSync(fp, 0o600);
    } catch {
      // Windows 不保证 POSIX mode；密文仍由 safeStorage 保护。
    }
    return true;
  } catch {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {
      // 清理临时文件失败不覆盖原会话文件。
    }
    return false;
  }
}

function decryptEnvelope(envelope) {
  if (
    !envelope ||
    envelope.version !== STORE_VERSION ||
    typeof envelope.encrypted !== "string" ||
    !envelope.encrypted
  ) {
    return null;
  }
  if (!encryptionAvailable()) return null;
  const plaintext = electronApi().safeStorage.decryptString(
    Buffer.from(envelope.encrypted, "base64"),
  );
  return normalizedSession(JSON.parse(plaintext));
}

/** 无文件返回 null；暂时无法读取时抛可重试错误，保留磁盘文件。 */
function get() {
  if (_cached !== undefined) return _cached;
  try {
    const fp = filePath();
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (parsed?.version === STORE_VERSION) {
      const restored = decryptEnvelope(parsed);
      // 钥匙串暂时不可用时保持 undefined；下次调用仍会重试磁盘解密。
      if (!restored) throw new Error("会话暂时无法解密");
      _cached = restored;
      return restored;
    }

    // v1 兼容：先恢复现有登录，再尽快把明文原地迁成 safeStorage 密文。
    const legacy = normalizedSession(parsed);
    // 迁移失败仍可使用旧会话，但保留 undefined 以便恢复后重试加密。
    if (legacy && writeEncrypted(legacy)) _cached = legacy;
    return legacy;
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      _cached = null;
      return null;
    }
    // 读盘/解密异常不等于没有会话；保留文件与重试资格。
    const error = new Error("暂时无法读取已保存的登录，请稍后重试");
    error.kind = "auth";
    error.code = "AUTH_STORAGE_UNAVAILABLE";
    throw error;
  }
}

function getAccessToken() {
  return get()?.accessToken || null;
}

function getRefreshToken() {
  return get()?.refreshToken || null;
}

function getGeneration() {
  return _generation;
}

/** 新登录替换整套会话。 */
function set(data) {
  const payload = normalizedSession({
    ...data,
    savedAt: new Date().toISOString(),
  });
  if (!payload) throw new Error("tokenStore.set 需要 accessToken");
  if (!writeEncrypted(payload)) return false;
  _generation += 1;
  _cached = payload;
  return true;
}

/** 只更新账号摘要，不改变凭据与会话代次。 */
function updateAccount(account) {
  const current = get();
  if (!current) return false;
  const next = { ...current, account: account ?? null };
  if (!writeEncrypted(next)) return false;
  _cached = next;
  return true;
}

/**
 * 仅当刷新开始时的会话仍然是当前会话才写回新 token。
 * 返回 false 表示期间已退出或重新登录，调用方必须丢弃刷新结果。
 */
function replaceTokensIfCurrent(expectedGeneration, expectedRefreshToken, tokens) {
  const current = get();
  if (
    !current ||
    _generation !== expectedGeneration ||
    current.refreshToken !== expectedRefreshToken
  ) {
    return false;
  }
  const next = normalizedSession({
    accessToken: tokens?.accessToken,
    refreshToken: tokens?.refreshToken,
    account: current.account,
    savedAt: new Date().toISOString(),
  });
  if (!next) return false;
  if (!writeEncrypted(next)) {
    const error = new Error("无法安全保存登录续期，请稍后重试");
    error.kind = "auth";
    error.code = "AUTH_PERSISTENCE_FAILED";
    throw error;
  }
  _cached = next;
  return true;
}

/** 磁盘删除成功才退出；失败保留旧会话并由调用方明确提示重试。 */
function clear() {
  // 先处理临时文件；若删除失败，不先移除仍可恢复的正式文件。
  for (const fp of [`${filePath()}.tmp`, filePath()]) {
    try {
      fs.unlinkSync(fp);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      return false;
    }
  }
  _generation += 1;
  _cached = null;
  return true;
}

module.exports = {
  get,
  getAccessToken,
  getRefreshToken,
  getGeneration,
  set,
  updateAccount,
  replaceTokensIfCurrent,
  clear,
};
