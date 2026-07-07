#!/usr/bin/env node
/**
 * make-ico.js — 从最高清图标源生成多尺寸 Windows .ico（REQ-3 高清图标）。
 *
 * 源：build/icon-1024.png（1024×1024 小猫头像，白底；从 build/icon.icns 最大条目提取，
 *     矢量包装源见 assets/icon.svg）。
 * 产物：build/icon.ico（electron-builder win.icon / nsis 安装图标）
 *       assets/icon.ico（窗口标题栏图标 + Windows 托盘；经 build.win.extraResources 进安装包）
 * 尺寸：16/24/32/48/64/128/256 共 7 档，小尺寸(16px)清晰是关键。
 *
 * 依赖：macOS 自带 sips 做各档缩放（仅限 macOS 运行本脚本），png-to-ico（devDependency）合成 .ico。
 * 用法：node scripts/make-ico.js
 * 覆盖前会把已存在的目标备份为 <目标>.bak（仅首次，已有 .bak 不再覆盖备份）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SOURCE_PNG = path.join(ROOT, "build", "icon-1024.png");
const TARGETS = [path.join(ROOT, "build", "icon.ico"), path.join(ROOT, "assets", "icon.ico")];
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  if (process.platform !== "darwin") {
    console.error("本脚本用 sips 缩放，仅支持在 macOS 上运行。");
    process.exit(1);
  }
  if (!fs.existsSync(SOURCE_PNG)) {
    console.error("找不到图标源: " + SOURCE_PNG);
    process.exit(1);
  }

  // png-to-ico v3 为 ESM 转译包：CommonJS 下真正的函数挂在 .default 上
  const pngToIcoModule = require("png-to-ico");
  const pngToIco = pngToIcoModule.default || pngToIcoModule;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "make-ico-"));
  try {
    // 逐档用 sips 缩放出正方形 PNG
    const sized = SIZES.map((size) => {
      const out = path.join(tmpDir, `icon-${size}.png`);
      execFileSync("sips", ["-z", String(size), String(size), SOURCE_PNG, "--out", out], {
        stdio: "pipe",
      });
      return out;
    });

    const buf = await pngToIco(sized);

    for (const target of TARGETS) {
      const bak = target + ".bak";
      if (fs.existsSync(target) && !fs.existsSync(bak)) {
        fs.copyFileSync(target, bak); // 仅首次备份旧图标
      }
      fs.writeFileSync(target, buf);
      console.log(`已生成 ${path.relative(ROOT, target)}（${SIZES.join("/")}px，${buf.length} 字节）`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("生成 .ico 失败:", error);
  process.exit(1);
});
