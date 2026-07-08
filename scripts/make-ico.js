#!/usr/bin/env node
/**
 * make-ico.js — 从最高清图标源生成多尺寸 Windows .ico（REQ-3 高清图标）。
 *
 * 源：build/icon-1024.png（1024×1024 小猫头像；从 build/icon.icns 最大条目提取，
 *     矢量包装源见 assets/icon.svg）。
 * 产物：build/icon.ico（electron-builder win.icon / nsis 安装图标）
 *       assets/icon.ico（窗口标题栏图标 + Windows 托盘；经 build.win.extraResources 进安装包）
 * 尺寸：16/20/24/32/48/64/128/256 共 8 档。
 *   - 20px 是 Win11 125% 缩放下标题栏/任务栏小图标的实际取用尺寸，缺了会拿 16/24
 *     插值导致发糊，故必须内置真 20px 条目（ico 不支持矢量，多尺寸位图即 Windows
 *     图标的"矢量等效"标准做法）。
 *   - 小尺寸（≤32px）用面积平均高质量重采样后再轻微 unsharp 锐化，保证小图标清晰。
 *
 * 依赖：scripts/lib/pixels.js（零依赖像素处理，跨平台）+ png-to-ico（devDependency）。
 * 用法：node scripts/make-ico.js
 * 覆盖前会把已存在的目标备份为 <目标>.bak（仅首次，已有 .bak 不再覆盖备份）。
 */
const fs = require("fs");
const path = require("path");
const { decodePng, encodePng, resizeBox, unsharp } = require("./lib/pixels");

const ROOT = path.join(__dirname, "..");
const SOURCE_PNG = path.join(ROOT, "build", "icon-1024.png");
const TARGETS = [path.join(ROOT, "build", "icon.ico"), path.join(ROOT, "assets", "icon.ico")];
const SIZES = [16, 20, 24, 32, 48, 64, 128, 256];
const SHARPEN_MAX_SIZE = 32; // ≤32px 的档位做轻微锐化
const SHARPEN_AMOUNT = 0.35;

async function main() {
  if (!fs.existsSync(SOURCE_PNG)) {
    console.error("找不到图标源: " + SOURCE_PNG);
    process.exit(1);
  }

  // png-to-ico v3 为 ESM 转译包：CommonJS 下真正的函数挂在 .default 上
  const pngToIcoModule = require("png-to-ico");
  const pngToIco = pngToIcoModule.default || pngToIcoModule;

  const source = decodePng(fs.readFileSync(SOURCE_PNG));
  const pngBuffers = SIZES.map((size) => {
    let image = resizeBox(source, size, size);
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
