# macOS 构建与 SenseVoice 模型

macOS 安装包必须内置 SenseVoice Small INT8 ONNX 模型，应用启动和首次听写都不会下载模型。

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

该 `afterPack` 断言仅作用于 macOS。Windows 继续使用 `.github/workflows/build-windows.yml` 中既有的下载与安装包断言；Linux 尚未声明内置 SenseVoice，因此不会被本检查阻断。

## 运行时降级契约

转写结果包含以下字段：

- `requested_engine`：设置请求的引擎；
- `actual_engine`：本次真正执行的 `sensevoice` 或 `paraformer`；
- `fallback_reason`：未降级时为 `null`，降级时为明确原因；
- `model_type`：具体运行时类型，例如 `sensevoice-onnx-numpy` 或 `paraformer-pytorch`。

macOS 上 SenseVoice 文件缺失或加载失败时，应用仍使用已加载的 Paraformer 完成本地听写，并在 Python 与 Electron 结构化日志中记录请求引擎、实际引擎和降级原因。纯 ONNX 平台没有 Paraformer 时，SenseVoice 加载失败仍按初始化错误处理。

macOS 与 Windows 均使用项目自带的 `SenseVoiceOnnxEngine`（`numpy + onnxruntime + soundfile`）。不要改回 `funasr_onnx.SenseVoiceSmall`：它还会隐式读取 `chn_jpn_yue_eng_ko_spectok.bpe.model`，而固定的官方 ONNX 仓库不包含该文件。
