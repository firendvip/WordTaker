#!/usr/bin/env node
/**
 * make-ico.js — 从矢量真源生成多尺寸 Windows .ico（REQ-3 高清图标）。
 *
 * 源：assets/icon.svg（真矢量小猫头像，唯一真源）。
 * 产物：build/icon.ico（electron-builder win.icon / nsis 安装图标）
 *       assets/icon.ico（窗口标题栏图标 + Windows 托盘；经 build.win.extraResources 进安装包）
 * 尺寸：16/20/24/32/48/64/128/256 共 8 档。
 *   - 20px 是 Win11 125% 缩放下标题栏/任务栏小图标的实际取用尺寸，缺了会拿 16/24
 *     插值导致发糊，故必须内置真 20px 条目（ico 不支持矢量，多尺寸位图即 Windows
 *     图标的"矢量等效"标准做法）。
 *   - 每档都由 SVG 按目标尺寸直接渲染（矢量下采样最锐利），≤32px 再轻微 unsharp。
 *
 * 依赖：rsvg-convert（brew install librsvg）+ scripts/lib/pixels.js + png-to-ico（devDependency）。
 * 用法：node scripts/make-ico.js
 * 覆盖前会把已存在的目标备份为 <目标>.bak（仅首次，已有 .bak 不再覆盖备份；.bak 不入库）。
 */
const fs = require("fs");
const path = require("path");
const { decodePng, encodePng, unsharp } = require("./lib/pixels");
const { renderSvgToPng } = require("./lib/svg-render");

const ROOT = path.join(__dirname, "..");
const SOURCE_SVG = path.join(ROOT, "assets", "icon.svg");
const TARGETS = [path.join(ROOT, "build", "icon.ico"), path.join(ROOT, "assets", "icon.ico")];
const SIZES = [16, 20, 24, 32, 48, 64, 128, 256];
const SHARPEN_MAX_SIZE = 32; // ≤32px 的档位做轻微锐化
const SHARPEN_AMOUNT = 0.25;

async function main() {
  if (!fs.existsSync(SOURCE_SVG)) {
    console.error("找不到图标矢量源: " + SOURCE_SVG);
    process.exit(1);
  }

  // png-to-ico v3 为 ESM 转译包：CommonJS 下真正的函数挂在 .default 上
  const pngToIcoModule = require("png-to-ico");
  const pngToIco = pngToIcoModule.default || pngToIcoModule;

  const pngBuffers = SIZES.map((size) => {
    let image = decodePng(renderSvgToPng(SOURCE_SVG, size));
    if (size <= SHARPEN_MAX_SIZE) {
      image = unsharp(image, SHARPEN_AMOUNT);
    }
    return encodePng(image);
  });

  const buf = await pngToIco(pngBuffers);

  for (const target of TARGETS) {
    const bak = target + ".bak";
    if (fs.existsSync(target) && !fs.existsSync(bak)) {
      fs.copyFileSync(target, bak); // 仅首次备份旧图标
    }
    fs.writeFileSync(target, buf);
    console.log(`已生成 ${path.relative(ROOT, target)}（${SIZES.join("/")}px，${buf.length} 字节）`);
  }
}

main().catch((error) => {
  console.error("生成 .ico 失败:", error);
  process.exit(1);
});
