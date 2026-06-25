# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## [1.5.3] - 2026-06-25

### Added
- 设置「皮肤」下方新增「托盘图标」选择：中笑(透明镂空模板,默认)/彩色猫头，切换后菜单栏托盘实时刷新
- 左侧新增「词转词」功能(置于「实验」上方)：可配置「原词→目标词」规则，识别到该词(含读音/拼写相近)时在 AI 处理时自动替换；每词≤50 字、最多 30 条；规则随请求以 word_map 字段提交 API(relay 模式需待中转更新后完整生效)，直连模式即时注入提示词生效

### Changed
- macOS 托盘默认图标改为「中笑」镂空单色模板(setTemplateImage(true),深浅菜单栏自适配)

## [1.5.2] - 2026-06-25

### Changed
- macOS 托盘图标改为 App 彩色猫头(去星)+满白底圆角板(C1)，setTemplateImage(false)，深浅菜单栏均清晰

## [1.5.1] - 2026-06-25

### Fixed
- 启动后唤醒键延迟/无效——提前注册全局热键监听并即时响应，引擎未就绪改为缓冲/排队不再丢按键。把 uIOhook 全局热键注册提到 startApp 顶部（先于开发模式等待、FunASR 启动、窗口/托盘创建），原生钩子尽早接管；渲染端唤醒键不再因"模型加载中/未就绪"而拦截，立即开始麦克风录音并给出"引擎加载中"提示，音频在停止时由主进程等引擎就绪后自动转写（funasrManager.transcribeAudio 排队等待 initializationPromise，必要时按需拉起）。

## [1.4.11] - 2026-06-25

### Fixed
- 托盘仍显示旧黑团——核对并修正 tray.js 图标路径指向 cat-trayTemplate.png，删除残留旧 cat-tray.png，并从打包 asar 抠图验证实际载入的是新猫头剪影。

## [1.4.10] - 2026-06-25

### Fixed
- macOS 托盘猫头在小尺寸糊成黑团——重绘为大耳朵+大眼睛挖空+留白的剪影，18px 下清晰可辨为猫。

## [1.4.9] - 2026-06-25

### Fixed
- macOS 托盘图标在深色菜单栏不可见——改用单色 template 猫头剪影(挖空眼睛)，自动反色，深浅菜单栏均可见。新增 assets/cat-trayTemplate.svg / cat-trayTemplate.png / cat-trayTemplate@2x.png。

## [1.4.8] - 2026-06-25

### Changed
- macOS 托盘图标改为小猫头(彩色, 非 template); 新增 assets/cat-tray.png / cat-tray@2x.png。

## [1.4.7] - 2026-06-25

### Changed
- App 图标更换为小猫头像(白底,留白94%) — 替换 build/icon.icns 与 build/icon.ico。

## [1.4.6] - 2026-06-24

### Fixed
- CI 矩阵竞态——每个作业只构建并发布对应架构，arm64 不再被 x64 覆盖。根因：`package.json` 的 `build.win.target` 显式写了 `arch:["x64","arm64"]`，此时 `electron-builder --win --<arch>` 标志只作「无 arch 目标」的默认值、不过滤显式 arch 列表，导致每个矩阵作业都构建 x64+arm64 两套；x64 作业产出的 arm64 命名包内含 x64 python，发布时按完成顺序覆盖 arm64 作业产出的真 aarch64 包。改用 `electron-builder --win nsis:<arch> portable:<arch>` 短路 config 的 target 列表，每作业只构建本架构这一套。
- 按架构分别发布 SHA256：SHA256 与发布步骤仅处理含本架构 token（`-x64-` / `-arm64-`）的 `.exe`，各作业写各自的 `SHA256SUMS-<arch>.txt`，互不覆盖；不再发布架构无关命名的 `latest*.yml`/`blockmap`（两作业会互相覆盖且语义错误）。portable 产物 `artifactName` 加入 `${arch}` 避免同名冲突。
- 对已发布产物校验 PE 机器类型：保留并强化 PE machine-type 断言，arm64 作业对其上传的原生二进制断言 `0xAA64`、x64 断言 `0x8664`；每作业只构建本架构后解包目录唯一，断言不再误读对方架构。

## [1.4.5] - 2026-06-24

### Fixed
- CI arm64 PE 断言读错架构目录：electron-builder 把 x64 解包到 `win-unpacked`、arm64 解包到 `win-arm64-unpacked`；arm64 作业里多 arch nsis 目标会顺带产出 x64 的 `win-unpacked`，旧断言按候选顺序先命中它、读到 x64 的 `better_sqlite3.node`(0x8664) 而误判。改为严格按本作业架构只看对应解包目录（arm64→win-arm64-unpacked，x64→win-unpacked）。注：arm64 安装包(`WordTaker-1.4.5-arm64-setup.exe`)与 electron-builder 已成功产出，仅断言步骤读错目录。

## [1.4.4] - 2026-06-24

### Fixed
- CI arm64 模型导出钉死 torch 2.0.1：v1.4.3 host 装了最新 torch，其 onnx 导出器需 `onnxscript` 报 `ModuleNotFoundError`。改为 host 导出依赖集与 x64 嵌入式构建完全一致（torch==2.0.1 + torchaudio==2.0.2 CPU 轮子 + funasr + funasr_onnx），torch 2.0.1 导出路径自洽、已在 x64 作业验证可用。

## [1.4.3] - 2026-06-24

### Fixed
- CI arm64 模型导出仍缺 `funasr`：funasr_onnx 导出 onnx 时显式要求安装 `funasr`（错误信息原文 "please install funasr"）。host(x64) tooling 补齐 `funasr`，与 x64 嵌入式构建一致的导出依赖集（funasr + funasr_onnx + torch）。仅装 x64 host，不进 arm64 包。

## [1.4.2] - 2026-06-24

### Fixed
- CI arm64 模型下载失败：modelscope 快照不含 `model_quant.onnx`，回退用 `funasr_onnx` 导出时，host(x64) tooling 缺 `jieba`（funasr_onnx 导入期依赖）报 `ModuleNotFoundError`。在 arm64 的 host tooling 安装中补齐 `jieba` / `kaldi-native-fbank` / `torch` / `torchaudio`（均仅装在 x64 host 用于导出模型，不进 arm64 包；arm64 包用自带 numpy 引擎）。x64 作业不受影响（v1.4.0 已成功发布 x64 安装包）。

## [1.4.1] - 2026-06-24

### Fixed
- CI arm64 静态校验误判：`soundfile` 以单文件模块 `soundfile.py` 安装（而非 `soundfile/` 目录），导致 `Test-Path .../soundfile` 为假、arm64 作业在「Verify embedded Python (arm64 static)」步骤失败（实际 win_arm64 轮子已全部安装成功）。改为同时接受 `<name>/` 目录、`<name>.py` 单文件、`<name>*.dist-info` 三种形态。x64 作业不受影响。

## [1.4.0] - 2026-06-24

### Added
- Windows-ARM64（aarch64）实验构建：新增 `arm64` 为 Windows nsis/portable 目标架构，与既有 x64 并行产出 `WordTaker-1.4.0-arm64-setup.exe`。
- 纯 SenseVoice ONNX 引擎（无 torch）：`funasr_server.py` 新增由环境变量 `WORDTAKER_ONNX_ONLY` 开启的纯 ONNX 模式，只加载 SenseVoice（onnxruntime + funasr_onnx + numpy），完全跳过 torch/funasr 的 Paraformer/VAD/punc 加载。修复 ARM 机上因 `import torch`（无 win-arm64 轮子）导致的启动崩溃 0xc0000017。
- 嵌入式 Python 按架构选择：`scripts/prepare-embedded-python.js` 支持 `--arch=arm64`，为 win-arm64 下载 astral-sh/python-build-standalone 的 `aarch64-pc-windows-msvc` CPython（3.11.15，tag 20260623），并只安装纯 ONNX 依赖集。
- CI 增加 arm64 矩阵作业：交叉准备 arm64 嵌入式 Python、`@electron/rebuild --arch arm64` 重建 better-sqlite3、断言 `.node`/`python.exe` 的 PE 机器类型为 ARM64(0xAA64)，并发布 arm64 安装包与 SHA256SUMS。

### Changed
- `src/helpers/funasrManager.js`：打包应用在 `win32 + arm64` 时自动注入 `WORDTAKER_ONNX_ONLY=1`，x64 行为不变。

## [1.3.9] - 2026-06-24

### Fixed
- CI PE 断言路径匹配改用 `.Contains` 而非正则：`build\Release` 里的 `\R` 在 .NET 正则中是未定义转义、`-match` 可能抛异常。改用字符串 `.Contains` 判断 `win32-x64` / `build\Release` / `darwin` / `linux`，消除该风险（承接 1.3.8 的“只校验 Windows x64 uiohook 二进制”修正）。

## [1.3.8] - 2026-06-24

### Fixed
- CI PE 断言再修正并暴露打包冗余：v1.3.7 的 uiohook 校验用 `-Recurse` 宽匹配 `uiohook-napi.node`，连 `prebuilds/darwin-arm64`、`prebuilds/darwin-x64`、`prebuilds/linux-*` 里随包分发的 **mac/linux 预编译 .node**（Mach-O/ELF，非 PE）也匹配上了，被正确判为“非 PE”而使断言失败。三个 Windows x64 二进制（`better_sqlite3.node`、`bin/win32-x64-*/uiohook-napi.node`、`build/Release/uiohook_napi.node`）均已确认机器类型为 x64(0x8664)，并无 mac/arm64 混入。改为只对“Windows 实际加载”的 x64 路径（`win32-x64` / `build\Release`）做 PE 断言；检测到 darwin/linux 预编译二进制改发非致命 warning（属打包冗余，可后续从 electron-builder `files` 排除）。

## [1.3.7] - 2026-06-24

### Fixed
- CI PE 机器类型断言修正：uiohook 原生模块文件名实为 `uiohook_napi.node`（`@electron/rebuild` 产物）/`uiohook-napi.node`（预编译），而非 `uiohook.node`；v1.3.6 的断言因按 `uiohook.node` 查找漏匹配、`-lt 2` 守卫触发而使 CI 失败（构建本身成功、`better_sqlite3.node` 已确认为 x64 0x8664）。改为同时匹配两种命名并分别强制校验，修复后正常发布。此前 MZ-only 旧检查也一直“静默漏检”uiohook，本次一并堵上。

## [1.3.6] - 2026-06-24

### Added
- 本地运行日志：在加载任何原生模块前于 `userData/logs/app.log` 落盘启动诊断（版本、`process.versions`、平台/架构、`os.release()`、内存、`resourcesPath`、日志路径），带 ~2MB 上限轮转；托盘菜单新增「打开日志文件夹」。
- `crashReporter`（仅本地 minidump，不上传）尽早启动，路径写入日志；`uncaughtException`/`unhandledRejection` 全栈写入 `app.log`。
- 原生模块加载守卫：`better-sqlite3`/`uiohook-napi` 的 require 与数据库初始化包 try/catch，先把“具体模块+错误”落盘再 rethrow，避免静默原生崩溃。
- CI 校验原生模块（`better_sqlite3.node`/`uiohook.node`）与嵌入式 `python.exe` 的 PE 机器类型为 x64(0x8664)，防 mac/arm64 二进制误入 Windows 包；并生成 `SHA256SUMS.txt` 随 Release 发布，供校验下载完整性（排查 Windows 0xc0000017 启动崩溃）。

## [1.3.5] - 2026-06-23

### Fixed
- 修正 `funasr_onnx` 类名：`funasr_onnx>=0.4.1` 导出的类是 `SenseVoiceSmall`（非 `SenseVoiceSmallONNX`），更正 `funasr_server.py` 运行时导入与 CI 模型导出脚本（`.github/workflows/build-windows.yml`），否则 Windows 端 SenseVoice 加载与 CI 模型导出均会 `ImportError` 失败。
- Windows CI 出包可用：补 `funasr_onnx`/`onnxruntime` 嵌入式 Python 依赖；torch 系改 CPU-only 轮子缩体积。
- CI 在打包前下载并打包 SenseVoice ONNX 模型到 `models/sensevoice/`（仓库 `.gitignore` 了 `models/`，此前安装包缺 `model_quant.onnx`）。
- 改用 GitHub Release 发布安装包（`softprops/action-gh-release`），绕开 Actions 工件存储配额（此前 CI 因配额满而失败的根因）。
- CI 构建后断言原生模块（`better_sqlite3.node`/`uiohook.node`）为 Windows PE（`MZ` 头），防止 Mach-O 误打进 Windows 包。

## [1.3.4] - 2026-06-22

### Fixed
- 小猫 睡眠 Zzz 真正贴到趴睡猫头：根因是 Zzz 用 `top:4px`（从窗口顶部算），而趴睡猫在 `.cs-sleeper{bottom:6px}`（窗口底部），二者隔了大半个窗口高。改为按窗口底部锚定（bottom ≈22px 起、逐个 +3px），紧贴趴睡猫头上方。

## [1.3.3] - 2026-06-22

### Changed
- 小猫 睡眠 Zzz 贴近头部：降低锚点（top -2→4）并缩短上升距离（-12px→-5px），Z 从头顶起升、贴头部悬停后淡出。

## [1.3.2] - 2026-06-22

### Fixed
- 修复唤醒后胶囊自动消失的回归：结束/取消那一拍不再重新定位并重显胶囊（避免与隐藏竞态把胶囊推到别的显示器/屏幕外）。
- 焦点定位回退/异常时不再隐藏窗口：定位失败逐级降级（焦点框→光标→屏幕底部居中），胶囊始终保持显示直到结束键。
- 焦点框尺寸异常时回退：AXFocusedUIElement 高度 < 8px 或接近整屏（拿到整窗/整屏元素）一律按“无焦点框”处理，避免据伪矩形把胶囊推离视野。

## [1.3.1] - 2026-06-22

### Fixed
- 胶囊跟随焦点定位修复（修正 AppleScript 输出解析，焦点框边界正确解析；落在焦点框下方更靠下，间距 14px）。

### Changed
- 小猫 各效果（音符/灯泡/星光/Zzz）按运动方向落在头部同侧前方，含睡眠 Zzz 按朝向。

## [1.3.0] - 2026-06-22

### Added
- 胶囊跟随输入焦点开关（默认开）：出现在焦点输入框下方；无焦点时在鼠标下方；关=固定屏幕底部居中。多级回退（焦点框→鼠标→底部），超时不阻塞。

### Changed
- 小猫 皮肤定稿：头部更明显的 Zzz（三个升序 slate 色 Z）；状态效果移到头部斜上方并随朝向左右；多色随机散布音符。

## [1.2.2] - 2026-06-22

### Changed
- 小猫 效果移到运动方向脸前方；音符随机散开 + 多色随机。

## [1.2.1] - 2026-06-22

### Changed
- 小猫 取消感叹号，大声改为更密集音符；头顶效果上移到头顶上方，不再压脸。

## [1.2.0] - 2026-06-22

### Added
- 小猫 皮肤（头顶效果：散落音符/感叹号/灯泡/闪光/汗滴，按音量与处理阶段切换）。

### Changed
- 旧 cat 皮肤更名为 小猫·简（行为不变）。

## [1.1.35] - 2026-06-22

### Fixed
- 小黑猫皮肤改为预建两种姿态、用 `display` 显隐切换（不再每次状态变化重建 SVG），消除走路抖动。
- 采用强滞回（hysteresis）：静音后可靠地走回中央趴下睡觉并显示 Zzz；语音抖动不再让状态反复闪烁。

### Changed
- 「喵」提示音改用真实免版权猫叫样本（OpenGameArt "Meow" by IgnasD，CC0 公共领域，可商用、无需署名）；解码/播放失败时回退到原合成喵。
