/**
 * 收费后端（ai-input-method-server）接入配置 —— 单一来源。
 *
 * 云端 AI 一律走此后端计费：engine=cloud 时润色请求打到 {AI_BACKEND_URL}{API_PREFIX}/polish。
 * 环境感知（app.isPackaged）：
 *   - 打包版(生产)：https://look3.cn + /aiapi（nginx 映射到后端 /api/v1）。
 *   - 开发版(联调)：http://localhost:3777 + /api/v1（NestJS 全局前缀，dev 不受影响）。
 * 可用环境变量 AI_BACKEND_URL / AI_API_PREFIX 覆盖（便于将来切换）。
 *
 * 决策真源见 docs/CLIENT_INTEGRATION_SPEC.md。
 */

// 判断是否为打包版（生产）。app 不可用时（如单测直接 require）按开发处理。
let IS_PACKAGED = false;
try {
  IS_PACKAGED = require("electron").app?.isPackaged === true;
} catch {
  IS_PACKAGED = false;
}

// 生产 vs 开发默认基址/前缀。
const PROD_BACKEND_URL = "https://look3.cn";
const PROD_API_PREFIX = "/aiapi";
const DEV_BACKEND_URL = "http://localhost:3777";
const DEV_API_PREFIX = "/api/v1";

// 后端根地址。环境变量优先，其次按打包状态选默认值。
const AI_BACKEND_URL =
  (process.env.AI_BACKEND_URL && process.env.AI_BACKEND_URL.trim()) ||
  (IS_PACKAGED ? PROD_BACKEND_URL : DEV_BACKEND_URL);

// 统一 API 前缀。环境变量优先，其次按打包状态选默认值。
const API_PREFIX =
  (process.env.AI_API_PREFIX && process.env.AI_API_PREFIX.trim()) ||
  (IS_PACKAGED ? PROD_API_PREFIX : DEV_API_PREFIX);

// 请求平台标识（请求头 x-platform）。按运行平台派生，避免 Windows 包误报 mac。
// 后端 polish.controller 接收该值入库，Windows 统一用 "windows"（与后端约定对齐）。
const CLIENT_PLATFORM =
  process.platform === "darwin"
    ? "mac"
    : process.platform === "win32"
    ? "windows"
    : process.platform;

// 后端不可达时是否回退旧 relay（保证云端仍可用）。默认开启。
const BACKEND_CLOUD_FALLBACK_RELAY = true;

// 网络请求超时（毫秒）。仅用于后端计费接口，避免后端挂死时无限等待。
// 注意：润色可能较慢，给足余量。
const BACKEND_REQUEST_TIMEOUT_MS = 60_000;

module.exports = {
  AI_BACKEND_URL,
  API_PREFIX,
  CLIENT_PLATFORM,
  BACKEND_CLOUD_FALLBACK_RELAY,
  BACKEND_REQUEST_TIMEOUT_MS,
};
