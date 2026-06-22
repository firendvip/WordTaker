# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

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
