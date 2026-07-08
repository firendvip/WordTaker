# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## [1.20.1] - 2026-07-08

### Fixed
- Windows 转写结果不粘贴到焦点输入框（企业策略机型 PowerShell 约束语言模式导致按键注入全灭）——新增原生 sendkeys.exe 注入器（CI 编译随包分发，不依赖任何脚本引擎），粘贴链路改为 原生exe→常驻PS worker→一次性PS 三级；粘贴失败不再弹通知窗，仅记日志且文本留在剪贴板

### Changed
- Windows 粘贴通道改常驻隐藏进程+真实回执（预热/重试/退出清理）
- 安装器界面定制——标题栏图标补 20px 共 8 档更清晰；安装中提示改「弦外小猫 正在安装，语音模型较大，请耐心等待...」；完成页新增使用提示（单击左alt录音、再次单击结束并AI润色）；界面配色改小猫画风（奶白底+侧栏/页眉小猫图）

## [1.20.0] - 2026-07-08

### Added
- 微信扫码登录上线；登录方式调整为 微信+邮箱验证码（短信入口暂下线，代码保留）
- 自动粘贴失败时通知「内容已复制，请手动 Ctrl+V」

### Changed
- 支付渠道暂只展示支付宝（微信支付代码保留，待商户 AppID 后恢复）

### Fixed
- Windows 转写结果不自动粘贴到焦点输入框——粘贴用的 PowerShell 每次弹出可见控制台抢走焦点导致按键发错窗口；改为隐藏窗口执行，粘贴恢复正常
- Windows 系统通知全部不显示（缺 AppUserModelId）——「润色失败」「额度用尽」等提示现在可见
- 云端额度用尽时原文直出却被标记为「已润色」——现在如实标记并提示
- 日志里错误信息序列化成空对象，无法排查——现在完整记录错误原因

## [1.19.0] - 2026-07-08

### Added
- 唤醒快捷键可自定义（设置→快捷键）：3 个平台预设 + 自定义组合键录入；冲突/被系统占用会提示并拒绝，保持原键继续生效

### Changed
- Windows 禁用硬件加速（根治胶囊白条/隐形问题），渲染进程崩溃自动重载（上限 2 次）

### Fixed
- Windows 按快捷键完全无反应：键盘钩子被系统静默摘除后不可恢复——新增看门狗自动检测 + 重启钩子 + 兜底键降级（托盘/通知可见），唤醒键不再静默失效
- Windows 纯 ONNX 模式下语音服务被错误跳过（仍按 funasr 判定安装状态）——两架构（x64/arm64）语音识别自此真正可用
- Windows 模型检查每 3 秒递归全盘搜索刷屏：ONNX 模式感知 + 指数退避 + 错误日志补全；CI 增加模型进包断言
- 快捷键配置合法值被误判非法的警告

## [1.18.0] - 2026-07-07

### Added
- Windows：快捷键注册失败时自动降级到兜底快捷键并弹系统通知，绝不静默失效
- Windows：高清多尺寸图标（16–256 ico + SVG 矢量源），应用于窗口标题栏与托盘；托盘右键菜单含「退出」

### Changed
- Windows x64 切换纯 SenseVoice ONNX 识别引擎（移除 torch/funasr 依赖），安装包约 611M→350M，安装显著提速
- Windows：所有窗口去除菜单栏

### Fixed
- 修复 Windows 按快捷键唤醒时录音胶囊显示为白色横条的问题（透明失效回退白底）——窗口显式设置全透明底色；并新增渲染进程崩溃/加载失败日志与早期错误上报

## [1.17.0] - 2026-07-07

### Added
- 设置→系统 新增「开机启动」开关，默认开启；登录电脑后自动打开弦外小猫

## [1.16.2] - 2026-07-07

### Changed
- 录音胶囊改为「带投影的瞬间出现」——出现不再淡入、瞬间到位并带一点阴影，与消失时的观感对称

## [1.16.1] - 2026-07-07

### Changed
- 小猫「出现」改为瞬间到位：去掉 `CatSkin.jsx`/`CatSkinFx.jsx` enter 模式的「由小变大 + 侧边跑入」动画（原 1.4s 内 scale 0.32→1.0），现录音一起小猫即以满尺寸出现，仅保留一次约 150ms 的轻微淡入（新增 `@keyframes cs-appear-fade`）。「消失/结束」动画保持不变。默认（非猫皮肤）胶囊也补一次纯 opacity 淡入。
- 登录改为弹窗：未登录时「云端剩余字数」卡内新增「未登录 · 点此登录」引导（仍展示匿名可用字数）；点击后弹出居中登录弹窗（手机/邮箱验证码，与原表单一致），不再在页面下方常显内联表单；兑换码/套餐的「请先登录」也改为打开该弹窗。弹窗支持点遮罩 / ESC / 右上角 ✕ 关闭，登录成功自动关闭。（`AccountPanel.jsx` + `QuotaCard.jsx`）

## [1.16.0] - 2026-07-06

### Changed
- 云端 AI 润色改为「强制全量润色」：移除短句直接上屏的跳过逻辑，现在每条转写都会走 AI 润色；润色失败时自动重试一次，不再静默出现未润色文本。

### Fixed
- 修复「云端AI」润色未生效自定义替换词的问题（如 Cloud.md→Claude.md）：自定义「词转词」替换规则（`word_map`）现在会随云端润色请求一并上送，云端润色也会应用替换规则。
- 修复流式上屏且开启「保留结果到剪贴板」时，剪贴板未保留完整润色全文的问题：现只保留最后一段完整润色全文到剪贴板。

## [1.15.2] - 2026-07-06

### Changed
- 暂时隐藏「微信登录」按钮（`AccountPanel.jsx` 加 `WECHAT_LOGIN_ENABLED=false` 开关）：当前微信 appid 是小程序、无 `snsapi_login`（网站扫码登录）权限，需在微信开放平台创建并审核通过「网站应用」后再启用。仅保留手机/邮箱验证码登录，避免用户点了报错。后端真实微信登录代码已就绪，拿到网站应用 AppID/Secret 即可开启。

## [1.15.1] - 2026-07-06

### Changed
- 微信登录弹窗体验优化：登录窗口加标题「微信登录」、固定尺寸(400×600)居中、隐藏菜单栏、`ready-to-show` 再显示防白屏；网络失败与微信报错（如「Scope 参数错误/无 Scope 权限」等，保守白名单匹配）时不再显示裸报错页，改为内联友好提示 +「关闭」按钮。原有回调 `code` 拦截、`state` 校验、超时与清理逻辑不变。

## [1.15.0] - 2026-07-06

### Added
- 云端额度不足自动降级本地（仅无订阅用户）：选云端引擎时，逐句比对「云端剩余字数」与本句字数，不足则该句自动改用本地大模型润色；余额恢复（充值）后自动切回云端。本地模型未安装时，该句原文直接上屏（不丢字）并提示去下载或充值。全程 macOS 托盘图标闪烁提醒、点击弹系统通知告知。（`aiService.js` 新增额度快照 `ensureQuotaFresh`/逐句降级 `_resolveCloudDegrade`/passthrough；`tray.js` 新增 `startAttention`/`stopAttention`；`main.js` 注入 notifier。订阅用户不受影响。）
- 云端剩余字数阶梯提醒（仅无订阅用户、云端引擎）：剩余降到 ≤1000 / ≤500 / ≤100 各提醒一次（每档一次、共最多三次），充值回升后重新武装；同样托盘闪烁 + 点击系统通知。基于持久化键 `quota_alert_prev_remaining` 的跨档检测，并发下 `prev` 仅随消耗单调下移、回升由权威 `getQuota` 重新武装，避免乱序漏报/误报。
- 真实微信登录（替换原 mock）：点「微信登录」在应用内弹窗加载微信官方 qrconnect 页——手机扫码，或**电脑端已登录微信时免扫码、在电脑微信点确认即可登录**（微信官方快速登录，自动生效）；回调 `code` 在窗口内拦截（`will-redirect`/`will-navigate`，`state` 校验防 CSRF，`preventDefault` 防单次性 code 被消耗）后换取登录。（`ipcHandlers.js` 重写 `auth-wechat-login` 编排；`backendClient.js` 新增 `getWechatAuthUrl`、`authWechatLogin` 带 code；配合后端 0.5.0。需后端配微信网站应用凭据 + 回调域 look3.cn 方生效。）

### Changed
- 去除订阅用户的云端每日字数硬上限：额度卡不再显示「今日已用 X / 200,000」，改为只显示「今日已用 X 字」。后端 `SUBSCRIPTION_DAILY_CHAR_CAP` 由 20 万抬到 500 万（仅作防失控/防盗刷兜底，正常使用无感）；本地模型不计费、云端非订阅用户仍靠余额限制。（配合后端 0.4.1）
- 设置左侧导航由 10 项精简为 5 项（10→5）：账户 / 转写与润色（合并 模型·角色·词转词）/ 快捷键 / 个性化（合并 提示音·皮肤）/ 系统（合并 权限·其他·关于）。合并后的面板内以子标题分区，功能与交互不变；旧 URL `?tab=`（如首启 `?tab=permissions`）自动映射到对应新分组，默认分组改为「系统」（权限置顶，首启仍先见权限卡）。
- 账户页登录后改为「一体化会员卡」：账号头、云端剩余字数、邀请码、兑换码合并进同一张渐变卡，邀请/兑换为卡内毛玻璃分区；套餐购买仍在下方；未登录态维持匿名额度卡 + 登录表单。新增 `MembershipHero.jsx`，`QuotaCard/InviteCard/RedeemCard` 加 `bare`/`variant="onGradient"` 复用原有复制/兑换/刷新逻辑，未复制代码。

## [1.14.1] - 2026-07-06

### Fixed
- 流式上屏且开启「保留结果到剪贴板」时，剪贴板现在保留完整润色全文，而非仅最后一段。

## [1.14.0] - 2026-07-05

### Changed
- 支付宝支付改为手机端付款流程：后端下单响应新增 `wapPayUrl`（手机收银台链接，收款主体切至新商户应用 2021006170674288，后端 0.3.1 配合），客户端用 `qrcode` 库本地把 wapPayUrl 生成二维码（220px dataURL `<img>`）在弹窗内展示，手机支付宝「扫一扫」后付款页直接在手机上打开完成付款，不再依赖 iframe 嵌入电脑收银台页面。弹窗布局（标题/档位副标题/金额大字/扫码提示/5s 轮询到账/成功态）不变。兜底：无 `wapPayUrl`（老后端）时回退 1.13.1 的 iframe 电脑收银台；「无法扫码？在浏览器中打开」仍打开电脑收银台 `payUrl`。

## [1.13.1] - 2026-07-05

### Changed
- 支付宝支付改为应用内扫码弹窗：利用后端 payUrl 的 `qr_pay_mode=4`（iframe 内只渲染二维码的嵌入模式），点「支付宝支付」后不再跳系统浏览器，而是在应用内弹出居中收银台弹窗——二维码居中（220px iframe + 加载占位）、下方大字金额（分转元）、副标题写明所购档位（充值包/订阅 · 名称 · 字数/时长，由 Plan 数据拼装），沿用 5s 轮询到账逻辑，到账后弹窗内显示「支付成功，已到账」并自动关闭。保留「无法扫码？在浏览器中打开」降级链接；iframe 加载失败时自动回退 1.13.0 的浏览器收银台 + 等待支付态。微信 mock 流程不变。（新增 `PayQrModal.jsx`）

## [1.13.0] - 2026-07-05

### Added
- 套餐购买接入真实支付宝支付（电脑网站支付 `alipay.trade.page.pay`，appId 2021006170631255）：选支付宝下单后，后端返回收银台 `payUrl`，客户端经 `open-external` IPC（http/https + 域名白名单校验）用系统浏览器打开支付宝收银台扫码付款；界面进入「等待支付」态，提供【我已完成支付 · 刷新额度】手动确认 + 每 5s 自动轮询到账（最多 2 分钟），检测到字数/订阅变化即提示成功并刷新。微信渠道暂保持 mock 模拟支付（保留体验版提示，仅对微信显示）。preload 新增 `openExternal` 白名单 API。

## [1.12.4] - 2026-07-05

### Fixed
- 修复 1.12.3 即时提示音的音色回归：触发键偶发双触发时，事件入口版会把同一声喵在几十毫秒内叠播两次（相位叠加听感"破音/怪音"）。新增与旧实现等价的"每次开始/结束各只播一次"转换守卫，并补回内存保护自动停止、录音出错等路径的结束喵；启动失败时复位守卫保证下次唤起出声。喵声恢复与原版完全一致，仅保留时机提前。

## [1.12.3] - 2026-07-05

### Fixed
- 提示音改为按键瞬时反馈：开始/结束喵在收到唤醒键事件的入口即刻播放（音频启动时已预解码+常驻 AudioContext），不再等 getUserMedia/MediaRecorder 启动完、也不再在播放前 await IPC 读设置——消除约 0.5 秒的开始音延迟。音色/音量逻辑不变；设置改动改为后台刷新缓存（最多晚一次触发生效）。

## [1.12.2] - 2026-07-05

### Changed
- 设置左侧导航按常规惯例重排：账户置顶 → 模型/角色/快捷键/词转词（核心功能）→ 提示音/皮肤（个性化）→ 权限（一次性系统设置）→ 其他 → 关于垫底。

## [1.12.1] - 2026-07-05

### Fixed
- 胶囊「跟随焦点」兜底顺序：AX 读不到焦点输入框时，改为先落到**前台窗口所在屏**底部居中（branch=front-screen，那才是正在打字的屏），鼠标光标位置降为最后兜底——多屏场景下鼠标在副屏时胶囊不再跟去副屏。field 成功路径不变；Windows 路径不变。
- 设置窗口乱码（诊断结论，无代码改动）：根因是**运行中的旧进程读到被新构建覆盖的 `app.asar`**——Electron 启动时缓存 asar 索引，asar 被 1.12.0 构建原地覆盖后按旧偏移读文件得到二进制垃圾并当 HTML 渲染。打包产物与后端 notes 均为合法 UTF-8（已逐一验证），非编码问题；退出并重新打开应用即恢复。

## [1.12.0] - 2026-07-04

### Added
- 应用内更新（免签名）：新增主进程更新器 `src/helpers/updater.js`——查后端版本清单 `GET /aiapi/app/mac/latest` → semver 比对当前版本 → 有新版下载 dmg 到「下载」目录（带进度）→ `shell.openPath` 打开 dmg，引导用户拖入「应用程序」完成更新。
- 启动静默检查：应用就绪后延迟数秒非阻塞检查更新，有新版则发系统通知提示（不强制、不打扰）；失败静默不崩主进程。
- 「设置 → 关于」新增「检查更新」：显示当前版本，点击查看新版本号/更新说明，「立即更新」触发下载并显示进度，完成后提示拖入「应用程序」。
- 新增 IPC：`check-for-update` / `download-update`（进度事件 `update-download-progress`），preload 暴露 `checkForUpdate()` / `downloadUpdate(url)` / `onUpdateDownloadProgress(cb)`。

### Fixed
- 修复账户页「复制码 / 复制邀请文案」点击无效：改用主进程剪贴板（`electronAPI.copyText`），不再依赖渲染层受限的 `navigator.clipboard`。

## [1.11.0] - 2026-07-04

### Added
- 客户端接入收费后端（`ai-input-method-server`）：新增「账户」设置页——三种登录（手机验证码 / 邮箱验证码 / 微信 mock）、云端剩余字数与订阅状态展示、我的邀请码（复制/分享）、兑换码兑换、套餐购买（体验版模拟支付）。
- 传输层：`backendConfig`（单一来源 `AI_BACKEND_URL`，默认本地联调，云端部署后改一处即可）、稳定 `deviceId`（匿名设备天然享免费额度）、主进程 `backendClient` 统一注入 `x-device-id`/`x-platform`/`Authorization`、JWT 存 userData。
- 云端AI 润色改走后端计费：按可见字数扣费，返回剩余字数/订阅/日用量；额度不足或超每日上限时贴原文并提示（购买/兑换/改用本地模型）；后端不可达时降级回退旧 relay。
- 收费后端已上线：`backendConfig` 改为环境感知（`app.isPackaged`）——打包版指向生产 `https://look3.cn/aiapi`，开发版仍用本地 `http://localhost:3777/api/v1`，装新版即可登录/看云端字数/云端计费。

### Fixed
- 修复打包版收不到麦克风语音：主进程启动时主动调用 `systemPreferences.askForMediaAccess('microphone')` 触发系统授权框，并为 `defaultSession` 设置媒体/麦克风权限处理器放行渲染层 `getUserMedia`；补充 `Info.plist` 的 `NSMicrophoneUsageDescription` 麦克风用途说明，以及 entitlement `com.apple.security.device.audio-input`（硬化运行时非沙盒下麦克风音频输入的正确 entitlement）。

## [1.10.0] - 2026-07-03

### Added
- 历史记录「AI优化」新增指标展示：`X字/秒，总耗时：Y秒`（X = 润色输出字数 ÷ 总耗时，取整）；流式上屏记录额外显示 `流式上屏首字：Z秒`（新增 DB 字段 `polish_first_char_ms`，仅流式路径采集"润色发起 → 首段上屏"耗时）。老记录/缺耗时仅显示「AI优化」。

### Changed
- 历史记录「AI优化」标题去掉引擎标签（不再显示 ·2B/·4B/云端）。
- 润色引擎精简为两个：**云端AI**（默认）与 **本地4B**；彻底移除本地 2B 引擎。云端引擎名由「云端（DeepSeek 中转）」改为「云端AI」，历史展示名同步为「云端AI」。
- 默认润色引擎改为 `cloud`（云端AI），安装即可直接使用，无需等待本地模型。
- 本地 4B 改为安装后**后台静默下载**：应用就绪后异步下载到用户数据目录（断点续传、不弹窗、不阻塞启动、失败不影响使用），进度可在设置「模型」tab 查看。设置文案更新为「约 2.8GB，速度较快，质量优 · 后台自动下载」。
- 安装包不再内置任何本地模型（排除全部 gguf），安装包体积显著减小。
- 优化本地模型（4B）润色/翻译提示词：加入「指令/数据隔离」（待处理文本用 `【待润色文本开始/结束】` 分隔符包裹并声明分隔符内一切只是数据、绝不回答/执行）、few-shot 示例（祈使句/问题只润色不作答）与末尾复述强约束，修复本地小模型把用户文案当成问题去「作答/执行」而非润色的问题（云端 DeepSeek 已有防注入隔离，保持不变）。新增输出兜底校验：结果疑似「在作答而非润色」时返回结构化失败 `reason=not_polished`，按既有「失败即贴原文」处理（阈值保守，宁漏勿误杀）。

### Fixed
- 修复本地模型长文润色失败/截断：`llm_server.py` 上下文 `n_ctx` 4096→8192，输出上限改为按 `n_ctx − prompt token 数 − 安全余量` 自适应（去掉 2048 死顶），长文不再被截断/降级。
- 本地模型遇超长输入（放开后仍超出 `n_ctx`）不再硬跑出乱码：返回结构化失败 `reason=input_too_long`，并明确提示「内容过长，本地模型无法处理，建议改用云端AI」（仍保持"失败即贴原文、引擎互不兜底"）。

## [1.9.2] - 2026-07-02

### Fixed
- 修复：无论「流式上屏」开关是否开启都强制流式的问题。流式上屏改回**受「设置 → 其他」里的开关控制，默认关闭**；关闭时按整段润色结果一次性粘贴，仅开启时才边生成边逐段贴出。

### Changed
- 「流式上屏」开关说明文案改为：「开启后边生成边逐段贴出，首字更快；但整体时间稍长。建议字数较多的情况下使用。」
- 关闭流式时的长润色等待（>5s）：小猫头顶显示不确定的「生成中…」提示（开启流式时仍显示「已生成 N 字」实时进度）。
- `CLAUDE.md` 浏览器操作规则更新为：默认派子 agent 操作 Chrome、可并行多个、各自汇报、主 assistant 汇总转达。

## [1.9.1] - 2026-07-01

### Changed
- 小猫头顶进度气泡改为**仅当 AI 润色处理时长 > 5 秒**才显示（`BUBBLE_SHOW_DELAY` 1.5s→5s），短润色不再闪现。
- 合成喵声调优为高亮「可爱撒娇」音色：整体升调去低沉，唤起为上扬「喵~↗」、结束在高音区以亮度/时长区分（不再靠降调），两者音量一致。
- 「转英文」快捷键新增「无」选项，且**新装默认为「无」= 关闭**（关闭态不注册触发器、按键不触发；已安装用户设置不变）。

### Docs
- `CLAUDE.md` 增补项目规则：需操作浏览器时派子 agent 直接操作 Chrome；只生成 Mac 端安装包、不再出 Windows；每次生成安装包后自动打开产物文件夹。

## [1.9.0] - 2026-07-01

### Added
- 超长口述支持：长录音转写改为 VAD 自动分段（`funasr_server.py` 启用原已加载但闲置的 FSMN-VAD，>60s 音频按语音段切片逐段识别再拼接，内存峰值约 854MB→350MB，失败回退整段）。
- 小猫头顶「吐字进度气泡」：长润色等待时实时显示「已生成 N 字」+ 进度条（真实反映流式吐字进度，进入后延迟 ~1.5s 显示避免短句闪烁）；非小猫皮肤在胶囊内复用进度条样式显示同样字数。
- 新增 IPC：`polish-progress`（主→渲染，流式 start/delta/done 进度）、`get-memory-info`、`show-notification`（系统通知）。

### Changed
- AI 润色默认走流式（不再依赖 `llm_streaming_enabled` 开关），边生成边贴到光标，并驱动头顶进度气泡。
- 录音时长改为「内存感知」动态保护：不设固定上限、尽量给久，仅当预测内存峰值超过 `min(60%可用内存, 1.2GB)` 时自动停止录音并发系统通知（本段照常转写不丢）。
- 中转输出上限 `DEFAULT_MAX_TOKENS` 8000→32768（三套 relay + wrangler.toml），容纳超长单次直出润色；可被环境变量 `MAX_TOKENS` 覆盖。

### Removed
- 去除全链路时间超时：渲染层 `PIPELINE_HARD_TIMEOUT_MS`(45s)、FunASR 转写命令 30s 超时（转写传 0=不限时）、中转 `UPSTREAM_TIMEOUT_MS`(30s，非流式+流式)；心跳预热超时独立保留。

### Fixed
- `database.js` 入库加 ~10MB 文本软上限保护（超限截断 + 告警），防异常超大文本卡死写入。

> 注：中转去上游超时 + max_tokens=32768 需**重新部署中转**才在服务端生效；线上当前可先设环境变量 `MAX_TOKENS=32768` 立即放开输出长度。分段转写需在装有嵌入式 python+funasr 的真实环境实跑验证。

## [1.8.0] - 2026-07-01

### Added
- 首次安装后首启自动打开「设置 → 权限」页：新增一次性标志 `onboarding_completed`（默认 `false`，已加入 IPC 设置白名单），首启弹出权限页并置位，之后不再自动弹出；设置窗口支持 `?tab=permissions` 定位初始分类。

### Changed
- 提示音「喵」方案：结尾喵叫改为下行/低沉变体（样本 `playbackRate 0.82` + `1/√rate` 增益补偿，合成回退用下行轮廓），与开头上扬喵声听感可区分、音量一致；开头喵声及其它提示音方案保持不变。
- 中继 `max_tokens` 默认提至 8000（worker / tencent-scf / tencent-scf-web 及 `wrangler.toml`），避免长文本润色输出被截断；心跳保活 `max_tokens:1` 不变。

### Fixed
- 长语音转写（如 628 字）未被 AI 润色而直贴原文的问题：根因为中继输入长度上限 `Text too long (413)` 拦截后客户端回退贴原文。现移除客户端（`process-text` / `process-text-stream` 的 10000 字上限）与三套中继的输入长度拦截，任意长度文本均可送润色。
- 去除润色链路的时间超时兜底（按需求）：移除 `ipcHandlers` 的 `IPC_PROCESS_TIMEOUT_MS`、`aiService` 的请求 AbortController 超时与流式空闲/硬上限看门狗；保留 429/5xx 退避重试与正常成功/失败解析。
- 修复「录音胶囊/小猫在转写或 AI 润色阶段突然消失」：根因为录音状态与处理状态耦合——`onstop` 一停录音即上报空闲，主进程过早重挂「转英文」触发器并放开隐藏路径，处理阶段误触转英文键即抢占/隐藏胶囊。改为主进程新增 `isBusy` 贯穿整段会话（录音→处理→润色→胶囊隐藏），期间 `handleTranslateHotkey` 被 `isRecording || isBusy` 拦截，会话级清理统一由幂等 `endSession()` 在胶囊真正隐藏（`hide-recorder`）或取消（`fireCancel`）时执行。

> 注：中继为独立部署服务（腾讯云 SCF / Cloudflare Worker），上述「去长度限制 + max_tokens=8000」需**重新部署中继**后方在服务端生效。

## [1.7.1] - 2026-06-30

### Changed
- 中继提示词改为读取同目录 gitignored 文件 `prompts.local.json`，替代超 4KB 限制的 SCF 环境变量方案（`PROMPTS_B64`）；该文件随函数代码部署，不进公开仓库与安装包。`server.js` 启动时 `fs` 读取同目录 JSON（失败保留 `PROMPTS_B64` 兜底），`worker.js` 改为构建期 `require('./prompts.local.json')`；均回退到非机密通用指令。

## [1.7.0] - 2026-06-30

### Security
- 提示词移出仓库与安装包：中继改为从 SCF 私有环境变量 `PROMPTS_B64`（base64(JSON)）读取四类提示词（copywriting/gaoeq/normal/translate-en），仓库源码与客户端安装包均不再含提示词明文。解析失败时回退到一段非机密的通用润色指令。

### Changed
- 客户端严格只走云端中继（relay）：移除本地直连模式下的提示词构建与 `prompts.js`；`aiService` 在中继未配置/不可达时直接返回失败，由既有「回退粘贴识别原文」逻辑兜底。`database` 中 `llm_prompt_template` 默认值改为空字符串。

## [1.6.1] - 2026-06-30

### Removed
- 移除「原文 / raw 结束键（双击右 Option 直贴原文不走 AI）」功能，任何情况下录音结束均走 AI 润色；清理 `raw_stop_key`/`raw_stop_taps`/`rawOnly` 相关设置项、UI 行、主进程触发器与渲染层逻辑（preload `onRawStop`、IPC `raw-stop`）。短句跳过润色（`skip_polish_max_chars`）不受影响。

## [1.6.0] - 2026-06-30

### Added
- 新增润色「角色」「常规」（mode `normal`，设为新用户默认）：风格介于「高情商」与「VibeCoding专用」之间，像正常人自然表达，重点理顺逻辑、去重复啰嗦；保留原意与关键信息，不无中生有、不回答问句。本地直连与中继（SCF/worker）双轨同步提示词。

### Changed
- 词转词规则上限 30 → 200（客户端 UI 与中继 `sanitizeWordMap` 双端同步；每条仍 ≤50 字并转义）。
- 设置导航「实验」更名为「其他」（id 不变）。
- 「托盘图标」选择整块从「皮肤」面板移至「其他」面板（行为不变：`tray_icon_style` + `reloadTrayIcon` 实时重建）。
- 托盘选项文案：「中笑（透明）」→「透明小猫」、「彩色猫头」→「彩色小猫」。

### Note
- 「常规」角色在中继重新部署前会回退到 VibeCoding 提示词（中继生效需重新部署 SCF Web 函数）。

## [1.5.9] - 2026-06-29

### Added
- 中继「提示词缓存心跳」——`__heartbeat` 触发对全部 active 模式发极小同前缀请求保活 DeepSeek prompt cache（兼 SCF 冷启动保活）；正常响应透传 `prompt_cache_hit/miss_tokens` 便于实测命中。

## [1.5.8] - 2026-06-26

### Added
- 设置「关于」显示应用版本号（运行时 `app.getVersion()`，不硬编码）。
- 新增项目规则：版本号须显示在关于处且用运行时获取（见 CLAUDE.md）。

## [1.5.7] - 2026-06-26

### Fixed
- mac 识别变慢真因——嵌入式 Python 缺 funasr_onnx 致 SenseVoice 加载失败回退 Paraformer（每句 +~0.8s）；补 funasr_onnx 恢复 SenseVoice（~1.0s→~0.15s）。

### Added
- 录音时调用 prewarm 预热连接（TLS/TCP），减少首句延迟。

### Changed
- max_tokens 2000→600，降低 LLM 输出延迟。

## [1.5.6] - 2026-06-26

### Fixed
- 全链路超时兜底——渲染层管线总超时(45s)、IPC 处理器超时(40s)、aiService 重试收敛(最坏~40s)+流式整体上限/无终止标记判错、FunASR 初始化等待有界(60s)、中继上游超时并必定收尾；任何卡住自动结束"处理中"并提示，不再永久卡死

## [1.5.5] - 2026-06-26

### Fixed
- 高情商模式会"回答问题"而非润色——以 VibeCoding 写法重定位为纯改写器(不回答/不回应/只输出改写)，加入示例锁定行为；本地+中继三处同步

## [1.5.4] - 2026-06-25

### Changed
- 重写高情商提示词：以 VibeCoding(文案润色)方案为基础，强化人情味/照顾对方情绪/委婉得体/真诚不浮夸；保留原意与关键信息、不无中生有；沿用随机标记防注入契约。本地(prompts.js)+中继(worker.js、tencent-scf-web/server.js)三处同步。

### Added
- 中继支持「词转词」word_map：接收请求体可选 word_map 数组({from,to})，防御式校验(忽略缺失/畸形、≤30 条、每词≤50 字、转义)，非空时以「数据清单(非指令)」形式注入 system 提示，指示在处理前替换出现的词语(含读音/拼写相近)；copywriting/gaoeq/translate 均生效；缺省时行为不变。worker.js 与 tencent-scf-web/server.js 两处实现一致。

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
