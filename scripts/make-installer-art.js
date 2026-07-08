#!/usr/bin/env node
/**
 * make-installer-art.js — 从 build/icon-1024.png 合成 NSIS 安装器美术图（小猫画风）。
 *
 * 产物（均为 NSIS 要求的 24-bit BI_RGB Windows 3.x BMP）：
 *   build/installerSidebar.bmp  164×314  welcome/finish 页左侧栏（assisted 安装器）
 *   build/installerHeader.bmp   150×57   其余页右上角页眉图（MUI_HEADERIMAGE_RIGHT）
 *
 * 画风取自小猫头像：黑色卡通猫 + 奶黄/亮黄点缀。
 *   - 侧栏：奶黄渐变底 + 亮黄光圈 + 小猫头居中
 *   - 页眉：与 installer.nsh 的 MUI_BGCOLOR（FFF8E8 奶白）同色打底 + 小猫头靠右，
 *     确保与页眉背景无缝衔接
 *
 * 零新依赖（scripts/lib/pixels.js 纯 node 实现）。用法：node scripts/make-installer-art.js
 */
const fs = require("fs");
const path = require("path");
const { decodePng, resizeBox, unsharp, compositeOver, encodeBmp24, createCanvas, fillCircle } = require("./lib/pixels");

const ROOT = path.join(__dirname, "..");
const SOURCE_PNG = path.join(ROOT, "build", "icon-1024.png");

// 与 build/installer.nsh 的 MUI_BGCOLOR 保持一致（奶白）
const HEADER_BG = [0xff, 0xf8, 0xe8];
// 侧栏奶黄渐变（上浅下深）与亮黄光圈
const SIDEBAR_TOP = [0xff, 0xf7, 0xe0];
const SIDEBAR_BOTTOM = [0xff, 0xe2, 0x96];
const HALO_YELLOW = [0xff, 0xd4, 0x4d];

function makeSidebar(source) {
  const W = 164;
  const H = 314;
  const canvas = createCanvas(W, H, SIDEBAR_TOP, SIDEBAR_BOTTOM);
  // 亮黄光圈托底，呼应图标的黄色点缀
  fillCircle(canvas, W / 2, 128, 66, HALO_YELLOW, 90);
  fillCircle(canvas, W / 2, 128, 58, [0xff, 0xef, 0xc2], 200);
  // 小猫头居中偏上
  const cat = unsharp(resizeBox(source, 104, 104), 0.2);
  compositeOver(canvas, cat, Math.round((W - 104) / 2), 76);
  // 底部三个小圆点收尾（黄-黑-黄）
  fillCircle(canvas, W / 2 - 18, 262, 4, HALO_YELLOW);
  fillCircle(canvas, W / 2, 262, 4, [0x2a, 0x24, 0x28]);
  fillCircle(canvas, W / 2 + 18, 262, 4, HALO_YELLOW);
  return canvas;
}

function makeHeader(source) {
  const W = 150;
  const H = 57;
  const canvas = createCanvas(W, H, HEADER_BG);
  // 小猫头靠右垂直居中，左侧留白给页眉标题文字
  const catSize = 44;
  const cat = unsharp(resizeBox(source, catSize, catSize), 0.3);
  compositeOver(canvas, cat, W - catSize - 8, Math.round((H - catSize) / 2));
  return canvas;
}

function main() {
  if (!fs.existsSync(SOURCE_PNG)) {
    console.error("找不到图标源: " + SOURCE_PNG);
    process.exit(1);
  }
  const source = decodePng(fs.readFileSync(SOURCE_PNG));
  const outputs = [
    { file: path.join(ROOT, "build", "installerSidebar.bmp"), image: makeSidebar(source) },
    { file: path.join(ROOT, "build", "installerHeader.bmp"), image: makeHeader(source) },
  ];
  for (const { file, image } of outputs) {
    fs.writeFileSync(file, encodeBmp24(image));
    console.log(`已生成 ${path.relative(ROOT, file)}（${image.width}×${image.height} 24-bit BMP）`);
  }
}

main();
