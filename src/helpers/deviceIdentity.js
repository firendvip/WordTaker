/**
 * 稳定设备身份（deviceId）。
 *
 * 在 Electron userData 下持久化一个 UUID（backend-device-id 文件），无则生成一次。
 * 供后端计费请求头 x-device-id 使用（匿名身份，跨会话稳定）。
 *
 * 仅主进程使用；渲染层不直接持有，经 IPC/后端 client 注入。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FILE_NAME = "backend-device-id";

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
 * 读取或创建稳定 deviceId。同步实现（主进程启动早期即可用）。
 * 任何 IO 异常都退化为「内存态一次性 UUID」，绝不阻断主链路。
 */
function getDeviceId() {
  if (_cached) return _cached;
  try {
    const fp = filePath();
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, "utf8").trim();
      if (isValidUuid(raw)) {
        _cached = raw;
        return _cached;
      }
    }
    const id = genUuid();
    fs.writeFileSync(fp, id, { encoding: "utf8", mode: 0o600 });
    _cached = id;
    return _cached;
  } catch (e) {
    // IO 失败：内存态 UUID，本次会话稳定，下次重启会重新生成（已尽力持久化）。
    if (!_cached) _cached = genUuid();
    return _cached;
  }
}

module.exports = { getDeviceId };
