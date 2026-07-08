/**
 * svg-render.js — 用本机 rsvg-convert 把 SVG 按目标尺寸直接渲染为 PNG Buffer。
 *
 * 矢量按目标尺寸直出（而非先出大图再缩），小尺寸最锐利、无重采样损失。
 * 仅供本地资产生成脚本使用（make-ico.js / make-installer-art.js / make-icons.sh 流程），
 * 产物入库，CI 不运行本脚本，故不要求跨平台。
 *
 * 依赖：brew install librsvg（rsvg-convert）。
 */
const { spawnSync } = require("child_process");

/**
 * @param {string} svgPath SVG 文件绝对路径
 * @param {number} width 目标宽（px）
 * @param {number} [height] 目标高（px），默认与宽相同
 * @returns {Buffer} PNG 数据
 */
function renderSvgToPng(svgPath, width, height = width) {
  const result = spawnSync(
    "rsvg-convert",
    ["-w", String(width), "-h", String(height), svgPath],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.error && result.error.code === "ENOENT") {
    throw new Error("缺少 rsvg-convert，请先 brew install librsvg");
  }
  if (result.status !== 0) {
    throw new Error(`rsvg-convert 渲染失败 (${svgPath} @${width}x${height}): ${result.stderr}`);
  }
  return result.stdout;
}

module.exports = { renderSvgToPng };
