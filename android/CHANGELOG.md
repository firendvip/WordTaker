# Changelog

All notable changes to the WordTaker Android voice IME are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/). Versioning: SemVer.

## [1.0.0] - 2026-06-24

### Added
- 安卓语音输入法 IME（`com.wordtaker.ime`）— 端侧 SenseVoice 离线识别 + 上屏。
- `InputMethodService`（WordTaker 语音键盘）：大麦克风按钮 + 状态文本，点按录音 / 再点结束。
- 16kHz 单声道 PCM 采集（`AudioRecorder`），sherpa-onnx `OfflineRecognizer` + SenseVoice int8（`SpeechRecognizer`）。
- 识别结果通过 `currentInputConnection.commitText(...)` 写入焦点输入框。
- 首启下载模型策略（`ModelManager`，约 226MB，带进度 UI），结构预留后续打包进 assets。
- 引导/启用页（`SetupActivity`）：启用输入法、切换键盘、授予麦克风权限。
- 可选 DeepSeek 润色（`PolishClient`，复用桌面端 relay；默认关闭，core 不依赖网络）。
- sherpa-onnx v1.13.3 预编译 AAR（全 ABI），versionName 1.0.0 / versionCode 1。
