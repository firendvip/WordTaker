## 浏览器操作规则（本项目）
- 凡是需要操作浏览器完成的事（如部署/配置腾讯云中转、改函数环境变量、控制台验证、网页联调等），**默认派子 agent（sub-agent）去操作本机 Google Chrome**（用浏览器控制工具），操作完由子 agent 把信息汇报给主 assistant；**主 assistant 不亲自逐步点，也不让用户复制粘贴给「浏览器里的 Claude 插件」**。
- **可同时派多个子 agent 并行操作**（各自负责不同任务/页面），主 assistant 同时接收多个子 agent 的汇报，最终**汇总或逐个转达给用户**。
- 此规则**覆盖**全局「便利优先／浏览器 Claude 插件」中「把内容交给用户粘贴到浏览器 Claude 插件」的做法——本项目一律派子 agent 操作 Chrome。
- 例外：登录/输入凭据、以及最终不可逆的支付/确认步骤，仍由用户本人做（安全所限不代做）。

## 打包/发布规则（本项目）
- Mac 端：本机构建 `.dmg`（`--mac`，不签名 `CSC_IDENTITY_AUTO_DISCOVERY=false`）。
- **Windows 端：需要打包 Windows 版本时，必须先完整读取 [WordTaker/docs/WINDOWS_BUILD.md](WordTaker/docs/WINDOWS_BUILD.md) 并按其中流程执行**（铁律：绝不本机 `--win`，只走 GitHub CI；发版流程、产物核验清单、Windows 专属架构事实与踩坑记录都在该文档中）。此规则强制，任何新会话/新上下文均适用。
- **每次生成安装包文件后（dmg / Windows setup.exe 产物），必须自动打开该安装包所在的文件夹**，方便用户立即取用。
  - macOS：`open <安装包所在目录>`（如 `open dist/`），或用 `open -R <安装包文件>` 在 Finder 中高亮该文件。

## 版本号显示规则
- 应用版本号必须显示在「设置 → 关于」处（如 1.5.7）。
- 必须使用运行时 `app.getVersion()`（经 IPC/preload 暴露），不得硬编码版本号，确保每次发版自动同步。
- 每次发版（bump package.json 版本）后，无需改 UI，关于页会自动反映新版本。
