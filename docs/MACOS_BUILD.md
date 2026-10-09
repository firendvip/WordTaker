# macOS 构建与 SenseVoice 模型

macOS 安装包必须内置 SenseVoice Small INT8 ONNX 模型。Mac 当前仍使用全量 FunASR 启动路径：首次使用需通过界面准备既有 ASR/VAD/PUNC 模型（约 1.1 GB），下载完成后重启语音服务；内置 SenseVoice 不代表首次安装即可离线听写。模型齐备后本地识别无需重复下载。

## 构建环境与安全检查

- Node.js 22.12.0 或更高版本；使用 `package.json` 固定的 pnpm 11.5.3。
- Electron 43 自身平台下限为 macOS 12；本产品经用户确认，最低支持 **macOS 14.0**，`mac.minimumSystemVersion` 与运行时字节门禁均为 14.0。Windows 支持范围不变。
- 使用 `pnpm install --frozen-lockfile`，构建前运行 `pnpm audit:security`。
- 升级 Electron 后必须重建原生模块，并重新执行 `pnpm patch:uiohook`。macOS 事件钩子必须保持 listen-only。
- 嵌入式 Python 缓存复用、依赖准备结束、构建前及实际 `afterPack` 均检查目标架构的 Mach-O 最低系统。宿主新系统能 import、wheel 标签都不能替代实际字节检查；`14.0.1`、`14.1` 或更高下限也不满足本项目声明的 `14.0`。
- `pnpm test:desktop-runtime` 使用隔离的临时目录检查数据库、原生模块、preload、WebAudio 和取消录音 IPC；不会启动全局快捷键或读取真实麦克风，不能替代人工听写验收。

electron-builder 26 使用 `mac.notarize: true`。正式公证使用 Apple ID 凭据时，需要由安全环境提供 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID`；也可使用既有的 App Store Connect API key 或 Keychain profile 流程。不要将凭据写入仓库。此前配置对象中的 Team ID 不再自动传入新版本，正式发布前须核对环境。

本地禁用签名/公证生成的目录仅用于兼容性检查，不是可公开发布的安装包；发布仍须分别验证签名、公证与 stapling。

2026-10-09 最新用户明确允许 1.29.5 沿用无正式证书发行路线：可为 Apple Silicon 必需的可执行结构使用 ad-hoc 签名，但它不是 Developer ID，不证明可信发布者，也不是公证/stapling。不得自行购买证书、降依赖、关闭 Gatekeeper、删 quarantine/TCC 或提供绕过警告脚本；正常系统“仍要打开/允许”由用户自己决定。必须对最终 arm64 DMG 中实际 app 的签名结构、嵌套原生/Python、最低 macOS14、来源字节及安装/启动健康核对；目录包的隔离 UI green 不替代下载来源 Gatekeeper/正常入口测试。没有 macOS14实机时如实保留未验项。当前旧 QA 不改；最终 DMG 及完整路径/大小/hash/来源SHA/实际签名和提示交接经主干核定后，才执行已授权公开发行，不自动上传。

旧 access-only 登录升级：缺少 refresh 本身不会退出；仅 `/auth/me` 明确返回 401 时显示“重新手机验证”，保留旧凭据直到新验证码登录安全写入 access/refresh。网络、超时、5xx、暂时存储失败保留原状态，不用本地 JWT 解码判断过期；迟到响应不能覆盖新登录或退出。

## 可复现模型来源

`scripts/sensevoice-model.js` 固定使用 ModelScope 官方模型：

- 模型：`iic/SenseVoiceSmall-onnx`
- revision：`v2.0.5`
- 文件：`model_quant.onnx`、`tokens.json`、`config.yaml`、`am.mvn`
- 每个文件都固定精确字节数与 SHA-256；任何缺失、截断或哈希变化都会使准备或打包失败。

模型下载到被 Git 忽略的 `models/sensevoice/`，不会提交约 230 MB 的 ONNX 权重。下载先写入 `.part`，流量超过清单大小会立即中止，大小及 SHA-256 验证成功后才原子替换目标文件。已有文件全部验证通过时不会联网。

## 本地命令

```bash
pnpm prepare:sensevoice
pnpm verify:sensevoice
pnpm prepare:python:embedded
pnpm test:python
pnpm build:mac
```

使用一段本地中文 WAV 做冷加载与连续推理 smoke（音频不会上传）：

```bash
python/bin/python3.11 scripts/smoke-sensevoice.py /path/to/chinese-sample.wav --iterations 3
```

验收要求：退出码为 0、`actual_engine` 为 `sensevoice`、三次结果文本非空且一致；记录 `load_seconds` 与 `inference_seconds` 作为本机性能证据。

`prebuild:mac` 会自动准备嵌入式 Python、准备 SenseVoice 模型并构建渲染端。electron-builder 完成 macOS app 目录后，`afterPack` 会再次校验：

```text
resources/app.asar.unpacked/models/sensevoice/
```

四文件固定大小/SHA 断言同时作用于 macOS 与 Windows；macOS 另对包内 Python 的 arm64/x64 对应 thin/fat Mach-O slice 检查最低系统和架构，缺失、损坏、没有系统版本元数据或检查失败均阻断。Windows 的现有 Python/PE/模型门不变；Linux 尚未声明内置 SenseVoice，因此不会被本检查阻断。

兼容运行时必须使用官方、可验 SHA 的目标 wheel，并满足现有依赖与安全要求；不得编辑 wheel 标签或 Mach-O load command、擅自提高已核准的 14.0 下限来豁免检查，也不得无审查地降级 ONNX Runtime。

### Apple Silicon 官方目标 wheel

`scripts/macOS-python-wheels.js` 固定 ONNX Runtime 1.31.0（cp311 / macosx_14_0_arm64）与 SciPy 1.17.1（cp311 / macosx_12_0_arm64，实际最高 minos 12.3，满足 14.0）。前者从旧缓存 1.27.0 升级，后者版本不变，仅选择已验真的官方兼容 wheel。

安装使用官方完整 URL、SHA-256、显式 macOS 14 arm64 / Python 3.11 目标，仅二进制、无依赖解析、无编译、无 pyc，失败不回退无锁来源。安装在既有依赖及 Metal wheel 之后执行；缓存、构建前、Python 测试及包内 `afterPack` 比对两包所有文件的确定性 SHA、文件数和原始 METADATA/WHEEL，拒绝旧残留、不同 wheel、字节变更与符号链接。Mach-O 全运行时检查仍独立执行。

这只冻结两项已审依赖，不是整个 Python 栈的锁定。Torch 2.0.1 / torchaudio 2.0.2 / torchvision 0.15.2 与 Paraformer 保持原状；PyTorch 安全修复仍待专项评估和批准，不得将通过本轮兼容验证描述为安全发布资格。macOS x64 沿用其现有依赖，不套用 arm64 wheel；Windows 与 Linux 依赖流程未变。

`docs/qa/RELEASE_CANDIDATE_20261009.md` 与此前 `dist/qa/mac-arm64-unsigned-internal-59390b12/`、`dist/qa/mac12-compat-r1/` 是旧 macOS 12 产品约束下的历史快照，保留原始结果；不能将其旧提交、包或 Windows CI 冒充本次新候选的验收。

## 运行时降级契约

转写结果包含以下字段：

- `requested_engine`：设置请求的引擎；
- `actual_engine`：本次真正执行的 `sensevoice` 或 `paraformer`；
- `fallback_reason`：未降级时为 `null`，降级时为明确原因；
- `model_type`：具体运行时类型，例如 `sensevoice-onnx-numpy` 或 `paraformer-pytorch`。

macOS 上 SenseVoice 文件缺失或加载失败时，应用仍使用已加载的 Paraformer 完成本地听写，并在 Python 与 Electron 结构化日志中记录请求引擎、实际引擎和降级原因。纯 ONNX 平台没有 Paraformer 时，SenseVoice 加载失败仍按初始化错误处理。

macOS 与 Windows 均使用项目自带的 `SenseVoiceOnnxEngine`（`numpy + onnxruntime + soundfile`）。不要改回 `funasr_onnx.SenseVoiceSmall`：它还会隐式读取 `chn_jpn_yue_eng_ko_spectok.bpe.model`，而固定的官方 ONNX 仓库不包含该文件。
