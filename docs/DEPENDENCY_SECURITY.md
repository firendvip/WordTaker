# 依赖安全维护

## 2026-10-09 Torch 安全候选（内部验证，未发布）

macOS arm64 候选采用已核定官方 Torch 2.10.0 build2 / TorchAudio 2.10.0 / torchvision 0.25.0；模型原始下载、完整固定清单、weights-only 和禁止未知 TorchScript 为强制边界。Windows 继续纯 ONNX。实际回归、模型/音频/IPC、来源与性能证据及 JIT/历史 Python 残余见 [本轮验收说明](qa/TORCH_SECURITY_CANDIDATE_20261009.md)。以下均为此前历史快照，不代表本轮完整安全清零或公开发布验收。

## 2026-10-09 隔离候选集成复验（未正式发布）

候选保留 remote main 的 Vite 8.3.0 / Rolldown、builder 26.15.7、SQLite 13.0.3，与已验证 Electron 43.7.8 合并。主树 package/lock 未改；下方2026-10-08记录是当日历史验证，不是此候选的打包验收。

新锁图复扫发现构建依赖 shell-quote 严重公告 [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv)，已用先失败的安全下限回归确认，再仅候选升级到官方修复版1.11.0。未忽略告警；`pnpm audit:security` 现为0严重/高危、1中危（下述sprintf-js），生产依赖0告警。

实际本地验证：30文件301项JS测试、17项Windows原生发现/入口/候选上传禁用契约、rollback覆盖100%、Vite8 renderer和lint0错误/367既有警告。安全测试强制现代Vite/Rolldown链；仅当Rollup存在时检查其修复下限，不为通过测试额外引入Rollup。Windows实际CI、正式两平台包与可信签名尚未完成，不用这些本地检查宣称可发布。

## 2026-10-08 本地修复记录

范围：本仓库的 pnpm 依赖、桌面内核及构建链；不包含对线上服务、已安装客户端或 Python 全部依赖的漏洞扫描。

| 扫描 | 修复前 | 修复后 |
| --- | --- | --- |
| 全部 pnpm 依赖 | 严重 2 / 高危 82 / 中危 53 / 低危 8 | 严重 0 / 高危 0 / 中危 1 / 低危 0 |
| 生产依赖 | 高危 7 / 中危 5 | 0 告警 |

以上为当日 `pnpm audit --json` 的统计，不代表独立漏洞或可利用攻击路径数量。Electron 在 devDependencies 中声明但属于交付内核，因此不能只检查 `--prod`。

关键升级：Electron 36.5.0 → 43.7.8、electron-builder 24 → 26.15.3、better-sqlite3 11.10.0 → 12.11.1、Axios → 1.20.0、Vite → 6.4.4、Vitest/coverage → 4.1.11。其余间接依赖用有版本范围的同主版本 overrides 修复，未关闭漏洞检查或设置公告忽略项。pnpm 保留发布冷却期检查。

兼容性例外：Rollup 固定为已修复漏洞的 4.59.0。同一项目使用 4.64.1 时连续构建约 179–202 秒，仅替换为 4.59.0 后为 2.04 秒，复验 1.66 秒，复扫仍为 0 高危/严重。后续升级 Rollup 时须同时复验构建耗时。

## 剩余中危告警

- `sprintf-js@1.1.3`：[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)，不受限的格式精度可造成拒绝服务。
- 来源是 electron-builder 的可选代理日志依赖：`app-builder-lib → @electron/get → global-agent → roarr → sprintf-js`。
- 当日注册表最高版本仍为 1.1.3，公告显示尚无修复版；audit 元数据中的 `>=1.1.4` 暂不可安装。不得用忽略项或虚假版本宣称修复。
- 已检查本地 macOS 验证产物：`app.asar` 不含 sprintf-js、electron-builder、Vitest 或 ESLint。该告警未进入此次验证的客户端包；开发/打包环境仍有残余风险。
- 后续升级上游修复版并复扫；不向该构建日志链传入不可信格式字符串。

## 防回归与验证

`pnpm audit:security` 检查全部 pnpm 依赖，在高危/严重告警时失败。CI 与 Windows 构建工作流使用固定 pnpm、冻结锁文件和同一安全门禁；中危残余仍会展示，并未被忽略。

本次已验证：

- 全部 JavaScript 测试 149/149；新增依赖安全基线测试。
- ESLint 0 errors（375 个既有 warnings）；渲染端构建通过。
- Python/FunASR/ONNX 导入与隔离、SenseVoice 固定模型哈希检查通过。
- Electron 43 / ABI 148 的源码及 macOS 包内隔离检查通过：内存 SQLite、uiohook 模块加载、preload、安全隔离、WebAudio、取消录音 IPC。
- macOS uiohook 源码及实际预编译二进制均确认 listen-only；未启动全局键盘监听。
- 本地 macOS 目录包构建及包内模型校验通过；未签名、未公证、未发布、未替换已安装软件。

未验证：真实麦克风听写、系统级 Esc/快捷键、真实短信、Windows 运行和正式签名发布。安全扫描结果会随公告更新而变化，发布前应重新执行。
