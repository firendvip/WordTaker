# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## [1.3.5] - 2026-06-23

### Fixed
- Windows CI 出包可用：补 `funasr_onnx`/`onnxruntime` 嵌入式 Python 依赖（修复 `funasr_server.py` 运行时 `from funasr_onnx import SenseVoiceSmallONNX` 缺包导致识别失败）；torch 系改 CPU-only 轮子缩体积。
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
