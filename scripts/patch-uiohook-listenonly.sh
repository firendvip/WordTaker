#!/bin/bash
# WordTaker 关键安全补丁：把 uiohook-napi(libuiohook) 的 macOS 事件钩子从
# "active tap"(kCGEventTapOptionDefault) 改为 "listen-only"(kCGEventTapOptionListenOnly)。
#
# 为什么必须打这个补丁：
#   active tap 会让"所有"系统输入都先经过本应用的钩子回调；而 libuiohook 在处理
#   字符键时会【同步阻塞】主线程做 keychar 查询。当主线程在启动/繁忙时，回调无法
#   返回，macOS 会冻结整机输入（只有鼠标能动、点击无效），曾导致严重的整屏卡死事故。
#   本应用只“监听”按键、从不消费，listen-only 行为完全等价且绝不会阻塞系统输入。
#
# 重要：每次 `npm install` / electron-builder 重建原生模块后，prebuilt 二进制会被
# 还原为未打补丁版本，必须重新运行本脚本。打包 mac 版前务必在构建流程里执行它。
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG=$(find "$ROOT/node_modules" -type d -path "*uiohook-napi@*/node_modules/uiohook-napi" 2>/dev/null | head -1)
[ -z "$PKG" ] && PKG="$ROOT/node_modules/uiohook-napi"
SRC="$PKG/libuiohook/src/darwin/input_hook.c"

if grep -q "kCGEventTapOptionDefault" "$SRC"; then
  echo "[patch] 将 active tap 改为 listen-only ..."
  /usr/bin/sed -i '' 's/kCGEventTapOptionDefault,/kCGEventTapOptionListenOnly,/' "$SRC"
else
  echo "[patch] 源码已是 listen-only，跳过编辑。"
fi

echo "[patch] 重建原生模块 ..."
( cd "$PKG" && "$ROOT/node_modules/.bin/node-gyp" rebuild )

echo "[patch] 用补丁后的二进制覆盖被加载的 prebuild ..."
ARCH_DIR="$PKG/prebuilds/darwin-arm64"
[ "$(uname -m)" = "x86_64" ] && ARCH_DIR="$PKG/prebuilds/darwin-x64"
cp "$PKG/build/Release/uiohook_napi.node" "$ARCH_DIR/uiohook-napi.node"

echo "[patch] 完成：$ARCH_DIR/uiohook-napi.node 已为 listen-only。"
