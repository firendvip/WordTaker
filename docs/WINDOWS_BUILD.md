# Windows 打包指南（经验固化）

> 打包 Windows 版本前必读。本文档由 1.16.2 → 1.25.1 多轮 Windows 真机踩坑 + 发版核验实操沉淀而成。

## 一、铁律

1. **绝不在 Mac 本机构建 Windows 包**（无 Wine 产不出、内嵌 Python 平台不符必出坏包）。唯一通道：GitHub Actions `.github/workflows/build-windows.yml`（windows-latest 真机，matrix x64 + arm64）。
2. 触发方式：推 tag `v*`（正常发版路径）或 workflow_dispatch 手动触发。
3. 产物发布在 **GitHub Release 资产**（不是 workflow artifacts）：`KittyEcho-<ver>-<arch>-setup.exe`、`-portable.exe`、`SHA256SUMS-<arch>.txt`。

## 二、标准发版流程

```bash
# 1. 版本 bump（SemVer）+ CHANGELOG.md 条目
# 2. 密钥核查：git status --porcelain 全列，确保无 secrets/.env/pem/.bak/杂散构建产物入库
# 3. commit（无 attribution 尾注）+ push origin main
#    （pre-push hook 因本机 pnpm 环境失败属已知问题，与代码无关，可 --no-verify）
git tag v<X.Y.Z> && git push origin v<X.Y.Z>   # 触发 Windows CI
gh run list --workflow=build-windows.yml --limit 2   # 拿 run ID
# 轮询等完（约 20-40 分钟）：
gh run view <RUN_ID> --json status,conclusion
# 下载 + 校验：
gh release download v<X.Y.Z> -R firendvip/WordTaker -p "*setup.exe" -p "SHA256SUMS*"
shasum -a 256 <exe>  # 与 SHA256SUMS 比对
```

## 三、产物核验清单（每次发版必做，7z 解包抽查 x64）

```bash
7z x -y -o_p KittyEcho-<ver>-x64-setup.exe && 7z x -y -o_p/app '_p/$PLUGINSDIR/app-64.7z'
```
- [ ] **无 torch**：`find _p/app -iname "*torch*" | wc -l` == 0（两架构均纯 ONNX）
- [ ] **onnxruntime 在**：`app.asar.unpacked/python/Lib/site-packages/onnxruntime`
- [ ] **模型进包**：`app.asar.unpacked/models/sensevoice/{model_quant.onnx(≈241M), tokens.json}`（CI 有断言步骤兜底）
- [ ] **sendkeys.exe 在**：`resources/bin/sendkeys.exe`（≈100KB，CI 用 MSVC 编译 `build/win/sendkeys.c`）
- [ ] **图标**：`resources/assets/icon.ico` 8 尺寸条目（16/20/24/32/48/64/128/256）
- [ ] asar 内 package.json version 与 tag 一致

## 四、Windows 专属架构事实（改代码前必须知道）

| 主题 | 事实 |
|---|---|
| ASR 引擎 | Windows 双架构均 **纯 SenseVoice ONNX**（`WORDTAKER_ONNX_ONLY=1`，funasrManager.js 设置；安装判定按 onnxruntime import，**绝不按 funasr**）。x64 切 ONNX 后安装包 611M→337M |
| 粘贴 | 三级链：**① 原生 `bin/sendkeys.exe`**（SendInput，免疫企业 PowerShell 约束语言模式）→ ② 常驻隐藏 PS worker（回执制）→ ③ 一次性 PS。企业机 CLM 会禁 Add-Type/COM，PS 方案不可靠，exe 是根治 |
| 透明窗口 | 胶囊窗必须 `backgroundColor:"#00000000"`；win32 已 `app.disableHardwareAcceleration()`（否则 DWM 合成失败→白条/隐形窗） |
| 快捷键 | 默认唤醒=**单击左 Alt**（uiohook 低级钩子）。钩子会被系统**静默摘除**（高负载/登录期高发）→ powerMonitor 看门狗 60s 检出自动重启，仍死降级 globalShortcut 兜底键。改触发代码勿破坏看门狗 |
| 系统通知 | 必须 `app.setAppUserModelId("com.kittyecho.app")`（main.js，与 appId 一致），否则打包版通知全部不显示 |
| 菜单栏 | win32 全窗口 `Menu.setApplicationMenu(null)` + autoHideMenuBar（mac 绝不能动 application menu） |
| 图标 | `scripts/make-ico.js` 生成 8 档 ico（20px 是 Win11 125% 缩放标题栏实际用的，缺了就糊）；托盘/窗口图标经 `build.win.extraResources` 带 `assets/icon.ico` |
| 安装器 | NSIS 定制在 `build/installer.nsh`（安装中文案/完成页左alt提示/奶白配色）+ `build/installerSidebar.bmp`(164×314) + `installerHeader.bmp`(150×57)，由 `scripts/make-installer-art.js` 生成；本地 lint 用 electron-builder 缓存的 makensis（Homebrew 版会崩） |
| uiohook | `patch:uiohook` 补丁只属于 mac prebuild；Windows CI 用 `@electron/rebuild` 重建，勿在 win 流程加 bash 补丁 |
| 日志 | 真机排障：`C:\Users\<user>\AppData\Roaming\kittyecho\logs\app.log`（+ funasr_server.log）。Error 序列化已修复（logManager），别再引入 `JSON.stringify(Error)`→`{}` |

## 五、已踩过的坑（勿重蹈）

1. x64 曾带 torch（611M、装得慢）；arm64 torch 无 win-arm64 轮子会 0xc0000017 崩——**保持双架构纯 ONNX**。
2. 「FunASR未安装跳过服务启动」：安装判定 import funasr 在 ONNX 包必失败——判定必须按模式分叉。
3. 粘贴用可见 PowerShell 窗口会抢焦点、按键发错窗口；`windowsHide:true` 只是必要条件，企业 CLM 机型必须走 sendkeys.exe。
4. NSIS 高压缩+torch 时代安装极慢；瘦身后仍要在安装中文案提示「语音模型较大请耐心等待」。
5. 发版后模型检查如报「递归搜索 modelscope」死循环=模型路径判定退化成 torch 模式，检查 funasrManager 的 ONNX 分支。

## 六、发版核验实操经验（主干侧发版，v1.21→1.25.1 固化）

> v1.25.1 的 Windows x64 安装包已真机验证正常可用。以下为多轮发版沉淀的可复用实操，与上面的架构/踩坑互补。

### 6.1 Mac + Win 并行发版编排（一次性出双平台）
```bash
# 1) bump 版本 + CHANGELOG + commit(--no-verify) + tag + push（推 tag 触发 Win CI）
git push --no-verify origin main && git push --no-verify origin v<X.Y.Z>
# 2) 后台盯 Win CI（省去反复 poll；约 20-40 分钟）
gh run watch <RUN_ID> --exit-status --interval 60   # 用 run_in_background 挂后台
# 3) 同时本机打 Mac（后台并行）
npm run prebuild:mac && CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac
# 两路都完成 → 分别核验（Mac 见项目 CLAUDE.md，Win 见 §三 + 下方）
```

### 6.2 SHA256 校验的 CRLF 坑（必看）
`SHA256SUMS-<arch>.txt` 是 **CRLF 行尾**，`shasum -a 256 -c SHA256SUMS...` 直接跑会全 `FAILED open or read`。正解——取期望值时 `tr -d '\r'` 或手动比对：
```bash
expect=$(grep setup.exe SHA256SUMS-x64.txt | awk '{print $1}' | tr -d '\r')
actual=$(shasum -a 256 KittyEcho-<ver>-x64-setup.exe | awk '{print $1}')
[ "$expect" = "$actual" ] && echo "x64 OK" || echo "MISMATCH"
```

### 6.3 asar 版本核验勿覆盖仓库 package.json（踩过的坑）
`npx asar extract-file app.asar package.json` 会把提取出的 package.json **写到当前工作目录、覆盖仓库真文件**（scripts 全没了）。必须**提取到临时目录**再读，或提取后立即还原：
```bash
(cd /tmp && npx asar extract-file "<绝对路径>/app.asar" package.json && node -p "require('/tmp/package.json').version")
# 若不慎在仓库目录跑过：git checkout -- package.json 还原
```

### 6.4 大文件完整性用 Content-Length 快验（下载站/服务器产物）
SHA 慢，先用字节数快筛本机 vs 服务器是否一致，再抽 SHA 确认：
```bash
本机:   stat -f%z dist/KittyEcho-<ver>-arm64.dmg
服务器: curl -s -r 0-0 -D - https://c.look3.cn/KittyEcho-<ver>-arm64.dmg -o /dev/null | grep -i content-range  # "/"后是总字节
```

### 6.5 本轮新增核验项（安全加固 + 多平台后必查）
在 §三 清单基础上追加（从 asar 提对应文件 grep）：
- [ ] `src/helpers/backendConfig.js` 的 `CLIENT_PLATFORM` 按 `process.platform` **派生**，非写死 `"mac"`（曾出现 Win 包上报 `x-platform:mac` 的 bug）。
- [ ] `llm_server.py` **完整明文提示词 = 0**：`grep -c '【示例1】' <unpacked>/llm_server.py` == 0，且 `grep -c set_prompt` > 0（提示词已加密/服务端下发）。
- [ ] `getLocalPrompt` / `/prompt` 拉取逻辑就位（提 `backendClient.js` grep）。
- [ ] 下载站接链：**Windows 仅 x64**（下载页 `arm64-setup` 链接数 = 0，arm64 只留 GitHub Release）。

### 6.6 其它
- **secrets 扫描**：`git diff | grep -iE "(sk-|api[_-]?key|secret|token)"`，排除误报（`polish_engine`/`accessToken`/`HOOK_TOKEN`/`X-App-Token` 等业务词）。
- **pre-push/commit hook** 本机 pnpm 环境失败属已知，`--no-verify` 跳过（与代码无关）。
- **zsh 核验脚本注意**：中文安装路径的 glob、`node -p "..."` 引号转义在 zsh 易报错；拆小步、显式路径、必要时双引号包裹。
- **订正**：模型 `model_quant.onnx` 实测 ≈230M（早期文档记 241M）。
