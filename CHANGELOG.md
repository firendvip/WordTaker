# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

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
