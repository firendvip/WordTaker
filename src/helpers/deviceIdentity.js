/**
 * 稳定设备身份（deviceId）——硬件派生优先。
 *
 * 优先从硬件标识派生（重装应用/清 userData 后不变，避免重复获赠）：
 * - macOS：ioreg IOPlatformUUID
 * - Windows：注册表 HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid
 * 取到后 sha256 截 32 位小写 hex（不泄露原始 GUID，且满足后端 8-64 位 [A-Za-z0-9._:-]）。
 *
 * 硬件读取失败才回退旧方案：userData 下持久化随机 UUID（backend-device-id 文件）。
 * 硬件派生可用时，旧文件中的随机 ID 直接弃用。
 *
 * 供后端计费请求头 x-device-id 使用（匿名身份，跨会话稳定）。
 * 仅主进程使用；渲染层不直接持有，经 IPC/后端 client 注入。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const FILE_NAME = "backend-device-id";
const EXEC_TIMEOUT_MS = 3000;
const HASH_HEX_LEN = 32;

let _cached = null;

// 返回 userData 目录；app 尚未就绪时抛出，由调用方兜底。
function userDataDir() {
  const { app } = require("electron");
  return app.getPath("userData");
}

function filePath() {
  return path.join(userDataDir(), FILE_NAME);
}

// UUID v4：优先用 crypto.randomUUID（Node 22 原生），兜底手工拼。
function genUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function isValidUuid(s) {
  return (
    typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim())
  );
}

/**
 * 读取硬件级机器 GUID（跨平台分支）。读不到返回 null，由调用方兜底。
 * @returns {string|null}
 */
function readHardwareGuid() {
  try {
    if (process.platform === "darwin") {
      const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice', {
        encoding: "utf8",
        timeout: EXEC_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/);
      return m ? m[1] : null;
    }
    if (process.platform === "win32") {
      const out = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        {
          encoding: "utf8",
          timeout: EXEC_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "ignore"],
        }
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{36})/);
      return m ? m[1] : null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 硬件 GUID → deviceId：sha256 截 32 位小写 hex。
 * 加固定前缀做域分离，避免与其它用途的同源哈希撞值。
 */
function deriveFromGuid(guid) {
  return crypto
    .createHash("sha256")
    .update(`wordtaker-device:${String(guid).toLowerCase()}`)
    .digest("hex")
    .slice(0, HASH_HEX_LEN);
}

// 旧回退方案：userData 持久化随机 UUID（仅硬件读取失败时使用）。
function fallbackPersistedUuid() {
  try {
    const fp = filePath();
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, "utf8").trim();
      if (isValidUuid(raw)) return raw;
    }
    const id = genUuid();
    fs.writeFileSync(fp, id, { encoding: "utf8", mode: 0o600 });
    return id;
  } catch (e) {
    // IO 失败：内存态 UUID，本次会话稳定，下次重启会重新生成（已尽力持久化）。
    return genUuid();
  }
}

/**
 * 读取稳定 deviceId。同步实现（主进程启动早期即可用）。
 * 硬件派生优先；任何异常回退随机+持久化，绝不阻断主链路。
 */
function getDeviceId() {
  if (_cached) return _cached;
  const guid = readHardwareGuid();
  _cached = guid ? deriveFromGuid(guid) : fallbackPersistedUuid();
  return _cached;
}

module.exports = { getDeviceId };
