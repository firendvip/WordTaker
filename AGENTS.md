# WordTaker Project Instructions

本文件只记录 WordTaker 特有的事实与约束；通用的交付、测试、安全和 Git 规则遵循全局 `AGENTS.md`。

## 项目概况

- WordTaker（产品名「弦外小猫」）是 Electron + React/Vite 桌面应用，使用本地 FunASR/Python 进行中文语音识别，并可调用 AI 处理文本。
- GitHub Project：<https://github.com/users/yan5xu/projects/2>。

## 常用命令

- `pnpm dev`：同时启动 Vite 渲染进程和 Electron 主进程；Vite 的工作目录固定为 `src/`。
- `pnpm test`、`pnpm lint`：运行 JavaScript 测试和 lint。
- `pnpm build:renderer`：只构建渲染端。
- `pnpm prepare:python:embedded`：准备生产构建使用的嵌入式 Python。
- `pnpm prepare:python:info`：查看嵌入式 Python 信息。
- `pnpm test:python`、`pnpm test:python:info`：验证嵌入式 Python。
- `pnpm build:mac`、`pnpm build:win`、`pnpm build:linux`：对应平台构建；相关 `prebuild:*` 生命周期会自动准备 Python 并构建渲染端。
- `pnpm clean`：删除构建缓存及生成的 `python/` 运行时，仅在明确需要重新生成环境时使用。
- Windows 安装包必须遵循 `docs/WINDOWS_BUILD.md`，不要在 macOS 本机直接执行 Windows 正式打包。

## Electron 与进程边界

- Electron IPC 处理器集中在 `src/helpers/ipcHandlers.js`；新增 IPC 时沿用现有注册和错误处理方式。
- 渲染进程只能通过 `preload.js` 暴露的安全 API 访问主进程能力，不直接启用 Node 能力。
- 窗口由现有窗口管理逻辑维护；历史页入口为 `src/history.html`。
- 录音和热键状态需要在主进程与渲染进程间同步；修改 F2 双击或录音状态时保留发送者跟踪与清理逻辑，避免监听器泄漏。

## FunASR、模型与 Python

- `funasr_server.py` 通过 stdin/stdout 传输 JSON；进程生命周期由 `src/helpers/funasrManager.js` 管理。
- 音频临时文件写入系统临时目录；日志、已下载模型和持久数据写入 Electron `userData`，不要写入源码目录。
- 模型检查、下载与进度通知沿用现有 IPC：`check-model-files`、`download-models`、`get-download-progress`、`model-download-progress`。
- 根目录 Python 脚本属于运行时资源；构建脚本位于 `scripts/`，生成的 `python/` 目录不提交。
- 生产环境从 `app.asar.unpacked` 解析 Python 和模型资源。启动子进程时保留 `windowsHide: true` 及现有隔离环境变量，避免污染或依赖系统 Python。
- 涉及 Python 运行时、模型或打包资源的修改，至少运行 `pnpm test:python` 和对应平台的相关构建检查。

## 数据、状态与日志

- SQLite 访问集中在 `src/helpers/database.js`；转录记录同时保留 `raw_text` 与 `processed_text`，不得用其中一个覆盖另一个。
- 设置继续使用现有键值表和 JSON 序列化格式，避免破坏已有用户数据。
- 前端状态使用 React hooks 与 Electron IPC；跨窗口录音状态必须显式同步。
- 使用 `src/helpers/logManager.js` 记录结构化日志，不新增裸 `console.log`；不得记录 API 密钥、令牌或完整敏感文本。

## 文件与界面约定

- `src/helpers/` 放管理器和系统集成逻辑，`src/hooks/` 放 React/Electron 集成 hooks，Python 入口脚本保留在项目根目录。
- 资源相对 `src/` 解析时使用现有路径约定；不要把开发路径直接用于生产包。
- Tailwind 4 和现有中文字体、对比度变量及 `.draggable` / `.non-draggable` 约定保持一致。
- 用户可见版本号必须来自运行时 `app.getVersion()`，不要在界面中硬编码。
