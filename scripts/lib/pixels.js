"use strict";
/**
 * pixels.js — 零依赖像素工具（供 make-ico.js / make-installer-art.js 复用）。
 *
 * 能力：
 *  - decodePng / encodePng：8-bit 非隔行 PNG（colorType 2/6），基于 node 内置 zlib
 *  - resizeBox：面积平均（box filter）高质量缩小，预乘 alpha 防黑边
 *  - unsharp：3×3 高斯 unsharp mask 轻微锐化（小尺寸图标防发糊）
 *  - compositeOver：RGBA 源 alpha 合成到目标
 *  - encodeBmp24：24-bit BI_RGB Windows 3.x BMP（NSIS 安装器图要求 BMP3/24bit）
 */
const zlib = require("zlib");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------- CRC32（PNG chunk 校验） ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- PNG 解码（8-bit、非隔行、colorType 2=RGB / 6=RGBA） ----------
function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("不是 PNG 文件");
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idatParts = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error(`仅支持 8-bit 非隔行 RGB/RGBA PNG（bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}）`);
      }
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = width * channels;
  const rgba = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let rawPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++];
    raw.copy(cur, 0, rawPos, rawPos + stride);
    rawPos += stride;
    unfilterLine(filter, cur, prev, channels);
    for (let x = 0; x < width; x++) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      rgba[dst] = cur[src];
      rgba[dst + 1] = cur[src + 1];
      rgba[dst + 2] = cur[src + 2];
      rgba[dst + 3] = channels === 4 ? cur[src + 3] : 255;
    }
    cur.copy(prev);
  }
  return { width, height, data: rgba };
}

function unfilterLine(filter, cur, prev, bpp) {
  const len = cur.length;
  if (filter === 0) return;
  if (filter === 1) {
    for (let i = bpp; i < len; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff;
  } else if (filter === 2) {
    for (let i = 0; i < len; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
  } else if (filter === 3) {
    for (let i = 0; i < len; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      cur[i] = (cur[i] + ((left + prev[i]) >> 1)) & 0xff;
    }
  } else if (filter === 4) {
    for (let i = 0; i < len; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      cur[i] = (cur[i] + pred) & 0xff;
    }
  } else {
    throw new Error(`未知 PNG filter: ${filter}`);
  }
}

// ---------- PNG 编码（RGBA、filter 0） ----------
function encodePng(image) {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// ---------- 高质量缩小：面积平均（box filter），预乘 alpha ----------
function resizeBox(src, dstWidth, dstHeight) {
  const { width: sw, height: sh, data } = src;
  const out = Buffer.alloc(dstWidth * dstHeight * 4);
  const xRatio = sw / dstWidth;
  const yRatio = sh / dstHeight;
  for (let dy = 0; dy < dstHeight; dy++) {
    const y0 = dy * yRatio;
    const y1 = (dy + 1) * yRatio;
    for (let dx = 0; dx < dstWidth; dx++) {
      const x0 = dx * xRatio;
      const x1 = (dx + 1) * xRatio;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let total = 0;
      for (let sy = Math.floor(y0); sy < y1 && sy < sh; sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < x1 && sx < sw; sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const idx = (sy * sw + sx) * 4;
          const alpha = data[idx + 3] / 255;
          // 预乘 alpha 平均，避免透明边缘发黑
          r += data[idx] * alpha * w;
          g += data[idx + 1] * alpha * w;
          b += data[idx + 2] * alpha * w;
          a += alpha * w;
          total += w;
        }
      }
      const dst = (dy * dstWidth + dx) * 4;
      if (a > 0) {
        out[dst] = Math.round(Math.min(255, r / a));
        out[dst + 1] = Math.round(Math.min(255, g / a));
        out[dst + 2] = Math.round(Math.min(255, b / a));
      }
      out[dst + 3] = Math.round(Math.min(255, (a / total) * 255));
    }
  }
  return { width: dstWidth, height: dstHeight, data: out };
}

// ---------- 轻微锐化：3×3 高斯 unsharp mask（预乘域，防透明边 halo） ----------
function unsharp(image, amount = 0.3) {
  const { width, height, data } = image;
  // 预乘
  const pre = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3] / 255;
    pre[i * 4] = data[i * 4] * a;
    pre[i * 4 + 1] = data[i * 4 + 1] * a;
    pre[i * 4 + 2] = data[i * 4 + 2] * a;
    pre[i * 4 + 3] = data[i * 4 + 3];
  }
  const KERNEL = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let ch = 0; ch < 4; ch++) {
        let blur = 0;
        let wSum = 0;
        let k = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++, k++) {
            const sy = Math.min(height - 1, Math.max(0, y + ky));
            const sx = Math.min(width - 1, Math.max(0, x + kx));
            blur += pre[(sy * width + sx) * 4 + ch] * KERNEL[k];
            wSum += KERNEL[k];
          }
        }
        blur /= wSum;
        const idx = (y * width + x) * 4 + ch;
        pre[idx] = pre[idx] + amount * (pre[idx] - blur);
      }
    }
  }
  // 反预乘并写回
  for (let i = 0; i < width * height; i++) {
    const a255 = Math.round(Math.min(255, Math.max(0, pre[i * 4 + 3])));
    const a = a255 / 255;
    out[i * 4 + 3] = a255;
    for (let ch = 0; ch < 3; ch++) {
      const v = a > 0 ? pre[i * 4 + ch] / a : 0;
      out[i * 4 + ch] = Math.round(Math.min(255, Math.max(0, v)));
    }
  }
  return { width, height, data: out };
}

// ---------- alpha 合成：src over dst，(dx, dy) 为左上角 ----------
function compositeOver(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const si = (y * src.width + x) * 4;
      const di = (ty * dst.width + tx) * 4;
      const sa = src.data[si + 3] / 255;
      if (sa === 0) continue;
      const da = dst.data[di + 3] / 255;
      const outA = sa + da * (1 - sa);
      for (let ch = 0; ch < 3; ch++) {
        dst.data[di + ch] = Math.round(
          (src.data[si + ch] * sa + dst.data[di + ch] * da * (1 - sa)) / (outA || 1)
        );
      }
      dst.data[di + 3] = Math.round(outA * 255);
    }
  }
  return dst;
}

// ---------- 24-bit BI_RGB BMP（Windows 3.x / "BMP3"，NSIS 安装器图要求） ----------
function encodeBmp24(image) {
  const { width, height, data } = image;
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const fileSize = 54 + pixelBytes;
  const out = Buffer.alloc(fileSize);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(fileSize, 2);
  out.writeUInt32LE(54, 10); // 像素数据偏移
  out.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22); // 正值 = 自底向上
  out.writeUInt16LE(1, 26); // planes
  out.writeUInt16LE(24, 28); // 24-bit
  out.writeUInt32LE(0, 30); // BI_RGB 无压缩
  out.writeUInt32LE(pixelBytes, 34);
  out.writeInt32LE(2835, 38); // 72 DPI
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const srcRow = height - 1 - y; // 自底向上
    let off = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      const idx = (srcRow * width + x) * 4;
      out[off++] = data[idx + 2]; // B
      out[off++] = data[idx + 1]; // G
      out[off++] = data[idx]; // R
    }
  }
  return out;
}

// ---------- 纯色/垂直渐变画布 ----------
function createCanvas(width, height, topColor, bottomColor) {
  const bottom = bottomColor || topColor;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const t = height > 1 ? y / (height - 1) : 0;
    const r = Math.round(topColor[0] + (bottom[0] - topColor[0]) * t);
    const g = Math.round(topColor[1] + (bottom[1] - topColor[1]) * t);
    const b = Math.round(topColor[2] + (bottom[2] - topColor[2]) * t);
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  return { width, height, data };
}

// ---------- 实心圆（柔和装饰用，带 1px 抗锯齿） ----------
function fillCircle(image, cx, cy, radius, color, alpha = 255) {
  const { width, height, data } = image;
  for (let y = Math.max(0, Math.floor(cy - radius - 1)); y <= Math.min(height - 1, Math.ceil(cy + radius + 1)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius - 1)); x <= Math.min(width - 1, Math.ceil(cx + radius + 1)); x++) {
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cov = Math.min(1, Math.max(0, radius - dist + 0.5));
      if (cov <= 0) continue;
      const a = (alpha / 255) * cov;
      const idx = (y * width + x) * 4;
      data[idx] = Math.round(color[0] * a + data[idx] * (1 - a));
      data[idx + 1] = Math.round(color[1] * a + data[idx + 1] * (1 - a));
      data[idx + 2] = Math.round(color[2] * a + data[idx + 2] * (1 - a));
    }
  }
  return image;
}

module.exports = { decodePng, encodePng, resizeBox, unsharp, compositeOver, encodeBmp24, createCanvas, fillCircle };
