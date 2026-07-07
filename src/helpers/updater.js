/**
 * 应用内更新器（免签名版）——单一来源。
 *
 * 弦外小猫无代码签名，不用 electron-updater 的静默安装；改为：
 *   查版本清单 → semver 比对 → 下载 dmg 到「下载」目录 → shell.openPath 打开 dmg
 *   （Finder 弹出拖拽安装窗口，用户手动拖入「应用程序」完成更新）。
 *
 * 版本清单接口：GET {AI_BACKEND_URL}{API_PREFIX}/app/mac/latest
 *   经 nginx 生产可公网访问 https://look3.cn/aiapi/app/mac/latest。
 *   返回 { version, url, notes, mandatory }。
 *
 * 全程 try/catch，任何失败都不崩主进程：网络失败静默返回 hasUpdate:false + log。
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { app, shell } = require("electron");
const { AI_BACKEND_URL, API_PREFIX } = require("./backendConfig");

// 版本清单地址（与计费后端同源，经 nginx 映射到后端 /api/v1/app/mac/latest）。
const LATEST_MANIFEST_URL = `${AI_BACKEND_URL}${API_PREFIX}/app/mac/latest`;

// 清单请求超时（毫秒）。启动静默检查不应久等。
const MANIFEST_TIMEOUT_MS = 10_000;

// 简单日志（无 logger 注入时回退 console，避免额外依赖）。
function log(logger, level, msg, extra) {
  try {
    if (logger && typeof logger[level] === "function") {
      logger[level](msg, extra);
    } else {
      // eslint-disable-next-line no-console
      console[level === "error" ? "error" : "log"](`[updater] ${msg}`, extra ?? "");
    }
  } catch (_) {
    /* 忽略日志失败 */
  }
}

// 选择 http/https 模块。
function pickTransport(urlStr) {
  return urlStr.startsWith("http://") ? http : https;
}

/**
 * 解析 "1.12.0" → [1,12,0]。非法段按 0 处理。
 * @param {string} v
 * @returns {number[]}
 */
function parseSemver(v) {
  const core = String(v || "").trim().replace(/^v/i, "").split(/[-+]/)[0];
  const parts = core.split(".").map((n) => {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? x : 0;
  });
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

/**
 * a > b ? 1 : a < b ? -1 : 0（仅比较 MAJOR.MINOR.PATCH）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/**
 * GET JSON（跟随一次跳转，带超时），失败 reject。
 * @param {string} urlStr
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
function fetchJson(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const transport = pickTransport(urlStr);
    const req = transport.get(urlStr, { timeout: timeoutMs }, (res) => {
      // 跟随一次重定向。
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume();
        fetchJson(res.headers.location, timeoutMs).then(resolve, reject);
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`版本清单请求失败：HTTP ${res.statusCode}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        // 防御：清单极小，超过 64KB 视为异常。
        if (body.length > 65536) {
          req.destroy(new Error("版本清单响应过大"));
        }
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error("版本清单 JSON 解析失败"));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("版本清单请求超时")));
    req.on("error", reject);
  });
}

/**
 * 校验清单字段，返回规范化对象或 null（非法）。
 * @param {any} raw
 */
function normalizeManifest(raw) {
  if (!raw || typeof raw !== "object") return null;
  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const notes = typeof raw.notes === "string" ? raw.notes : "";
  const mandatory = raw.mandatory === true;
  if (!version) return null;
  return { version, url, notes, mandatory };
}

/**
 * 检查是否有新版本。网络/解析失败一律静默返回 hasUpdate:false（不抛，不崩）。
 * @param {{ logger?: any }} [deps]
 * @returns {Promise<{hasUpdate:boolean, current:string, latest?:string, notes?:string, url?:string, mandatory?:boolean, error?:string}>}
 */
async function checkForUpdate(deps = {}) {
  const logger = deps.logger;
  const current = app.getVersion();
  try {
    const raw = await fetchJson(LATEST_MANIFEST_URL, MANIFEST_TIMEOUT_MS);
    const manifest = normalizeManifest(raw);
    if (!manifest) {
      log(logger, "warn", "版本清单格式非法，跳过更新检查");
      return { hasUpdate: false, current };
    }
    const hasUpdate = compareSemver(manifest.version, current) > 0;
    log(logger, "info", "更新检查完成", {
      current,
      latest: manifest.version,
      hasUpdate,
    });
    return {
      hasUpdate,
      current,
      latest: manifest.version,
      notes: manifest.notes,
      url: manifest.url,
      mandatory: manifest.mandatory,
    };
  } catch (error) {
    log(logger, "warn", "更新检查失败（已忽略）", error?.message || error);
    return { hasUpdate: false, current, error: error?.message || "更新检查失败" };
  }
}

// 校验下载直链：仅允许 http(s)、后缀 .dmg，防止被清单诱导打开任意本地路径/协议。
function isSafeDmgUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return /\.dmg(\?.*)?$/i.test(u.pathname) || /\.dmg(\?.*)?$/i.test(urlStr);
  } catch (_) {
    return false;
  }
}

// 从 URL 提取安全文件名（仅保留 basename，兜底带版本时间戳）。
function safeFileNameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const base = path.basename(u.pathname);
    if (base && /\.dmg$/i.test(base)) return base;
  } catch (_) {
    /* 忽略 */
  }
  return `KittyEcho-update-${Date.now()}.dmg`;
}

/**
 * 下载 dmg 到「下载」目录并用 Finder 打开（引导拖拽安装）。
 * 带进度回调；下载完 shell.openPath。任何失败返回结构化错误，不抛。
 *
 * @param {string} url dmg 下载直链
 * @param {(p:{percent:number, transferred:number, total:number})=>void} [onProgress]
 * @param {{ logger?: any }} [deps]
 * @returns {Promise<{success:boolean, path?:string, error?:string}>}
 */
async function downloadAndOpen(url, onProgress, deps = {}) {
  const logger = deps.logger;
  if (!isSafeDmgUrl(url)) {
    log(logger, "warn", "拒绝下载：非法或非 .dmg 直链", url);
    return { success: false, error: "更新下载地址非法" };
  }

  const downloadsDir = app.getPath("downloads");
  const fileName = safeFileNameFromUrl(url);
  const savePath = path.join(downloadsDir, fileName);

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let fileStream;
    const cleanupPartial = () => {
      try {
        if (fileStream) fileStream.close();
      } catch (_) {}
      try {
        if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
      } catch (_) {}
    };

    const doGet = (targetUrl, redirectsLeft) => {
      const transport = pickTransport(targetUrl);
      const req = transport.get(targetUrl, (res) => {
        // 跟随重定向（最多 5 次）。
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          if (redirectsLeft <= 0) {
            done({ success: false, error: "下载重定向次数过多" });
            return;
          }
          doGet(res.headers.location, redirectsLeft - 1);
          return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          done({ success: false, error: `下载失败：HTTP ${res.statusCode}` });
          return;
        }

        const total = parseInt(res.headers["content-length"] || "0", 10) || 0;
        let transferred = 0;
        fileStream = fs.createWriteStream(savePath);

        res.on("data", (chunk) => {
          transferred += chunk.length;
          if (typeof onProgress === "function") {
            const percent = total > 0 ? Math.round((transferred / total) * 100) : 0;
            try {
              onProgress({ percent, transferred, total });
            } catch (_) {}
          }
        });

        res.pipe(fileStream);

        fileStream.on("finish", () => {
          fileStream.close(async () => {
            try {
              log(logger, "info", "更新包下载完成，打开 dmg", { savePath });
              const openErr = await shell.openPath(savePath);
              if (openErr) {
                // openPath 返回非空字符串表示失败；文件已下好，仍算成功但提示。
                log(logger, "warn", "打开 dmg 失败", openErr);
              }
              done({ success: true, path: savePath });
            } catch (e) {
              log(logger, "warn", "打开 dmg 异常", e?.message || e);
              done({ success: true, path: savePath });
            }
          });
        });

        fileStream.on("error", (e) => {
          cleanupPartial();
          log(logger, "error", "写入更新包失败", e?.message || e);
          done({ success: false, error: "写入更新包失败" });
        });
      });

      req.on("error", (e) => {
        cleanupPartial();
        log(logger, "error", "下载更新包出错", e?.message || e);
        done({ success: false, error: e?.message || "下载更新包出错" });
      });
    };

    try {
      doGet(url, 5);
    } catch (e) {
      cleanupPartial();
      done({ success: false, error: e?.message || "下载更新包异常" });
    }
  });
}

module.exports = {
  checkForUpdate,
  downloadAndOpen,
  compareSemver,
  LATEST_MANIFEST_URL,
};
