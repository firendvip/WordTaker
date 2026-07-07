# 本地大模型润色 — 集成进度

状态：端到端已实现，真实冒烟通过。以下为受阻/待确认项。

## 已完成
- `llm_server.py`（GGUF 常驻推理，流式 JSON 协议，非思考模式，stdout 纯净）
- `src/helpers/llmManager.js`（spawn/生命周期、引擎切换重载、下载带进度+断点续传+ModelScope 兜底）
- `aiService.js` 按 `polish_engine` 路由，四引擎互不兜底
- `ipcHandlers.js` 新增引擎/模型状态/下载 IPC；`process-text-stream` 支持本地引擎
- `database.js` 新增 `polish_engine`（默认 `local-0.8b`）
- `preload.js` 暴露新 API
- `useRecording.js` 失败→贴原文 + 系统通知「润色失败，已贴出原文」
- `settings.jsx` 新增「模型」选项卡（4 单选 + 2B/4B 下载进度）
- `package.json` 打包内置 0.8B、排除 2B/4B；`scripts/prepare-embedded-python.js` 装 llama-cpp-python(metal)
- 真实下载 0.8B GGUF（models/），真实冒烟推理通过

## 受阻/注意项
1. **llama-cpp-python metal 轮子上游损坏**：`abetlen` metal 索引上最新几个版本
   （0.3.31 / 0.3.32 的 py3-none-macosx_11_0_arm64 轮子）zip 校验 `Bad CRC-32`（文件
   `lib/cmake/ggml/ggml-config.cmake`），无法安装。已固定到**已验证可用的 0.3.30**。
   `prepare-embedded-python.js` 已写死该版本。若日后升级需先 `zipfile.testzip()` 验证轮子完整。
2. **numpy 冲突已处理**：llama-cpp-python 默认依赖会把 numpy 升到 2.x，破坏 funasr_onnx(<=1.26.4)。
   安装脚本用 `--no-deps` 装本体 + 单独补纯 Python 依赖 + 兜底钉回 `numpy==1.26.4`。
   三者（numpy 1.26.4 / llama_cpp 0.3.30 / funasr_onnx）已验证共存。
3. **待真机确认**：2B/4B 按需下载的完整链路（进度事件→就绪→自动选中）仅逻辑验证，
   未真实下载 GB 级模型跑通（0.8B 已真实下载+推理）。运行中的 Electron 内 UI/通知需真机点验。

## 版本 / 打包约束（遵守用户要求）
- 未改 version / CHANGELOG，未打 dmg，未动 git。
