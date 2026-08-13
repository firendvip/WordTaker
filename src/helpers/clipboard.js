const { clipboard, systemPreferences } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// 模拟 Cmd+V 前，等待剪贴板写入稳定的时间。
// 剪贴板写入已在 _pasteTextImpl 里做过同步回读校验，这里只需给系统粘贴板很短的传播余量，
// 故从 120ms 收紧到 60ms 以加快"出字"，仍保留约 2 倍于常见传播耗时的安全边际。
const PASTE_SETTLE_MS = 60;
// 流式增量粘贴时，Cmd+V 之后必须等待目标 App 真正“吃进”这次粘贴，再让串行链放行下一个分片去写剪贴板。
// _pressPaste 只在 osascript 进程退出（按键已派发，而非已被消费）时 resolve，
// 若不等待，下一个分片的 clipboard.writeText 会在目标 App 还在消费上一次粘贴时覆盖粘贴板，
// 造成重复 + 丢字。该常量即“按下粘贴后到下一次写剪贴板前”的消费等待窗口。
const PASTE_CONSUME_MS = 90;
// 模拟 Cmd+V 后，等待目标 App 真正消费完粘贴、再恢复原始剪贴板的时间。
// 必须足够长：太短会导致目标 App 读到“被恢复的旧内容”，从而粘贴上一次的结果。
const CLIPBOARD_RESTORE_MS = 700;
// 粘贴子进程的兜底超时：超过该时间仍未结束则 SIGKILL，避免挂死的粘贴进程堆积（ROB-4）。
const PASTE_KILL_TIMEOUT_MS = 3000;
const COPY_SETTLE_MS = 320; // 等待目标应用把选区写入剪贴板（大段选区/慢机器需要更久）
// Windows 常驻 SendKeys worker：单条命令的回执超时（有真实回执，判定不再靠 exit code 猜）
// 放宽到 2800ms：慢机 / 首帧 SendWait 偏慢时 1500ms 会误判超时，导致粘贴全链失败。
const WIN_WORKER_ACK_TIMEOUT_MS = 2800;
// worker 回执 err 后的重试间隔
const WIN_WORKER_RETRY_DELAY_MS = 200;
// 原生按键注入器 sendkeys.exe 的单次执行超时（纯 Win32 SendInput，正常几十 ms 内退出）
// 放宽到 1500ms：慢机首次注入偏慢，1000ms 会误杀导致误判失败后无谓降级。
const SENDKEYS_EXE_TIMEOUT_MS = 1500;
// —— Windows 原生按键注入器 sendkeys.exe（三级链最优先路径①）——
// 企业策略机上 PowerShell 处于 Constrained Language Mode：Add-Type（.NET SendKeys）
// 与 New-Object -ComObject（WScript.Shell）全被禁 → PS 常驻 worker 与一次性 PS 全灭。
// sendkeys.exe 是纯 Win32 SendInput 小工具（build/win/sendkeys.c，CI 用 MSVC 编译，
// 经 extraResources 打进包），不依赖任何脚本引擎，在 CLM 机器上也可用。
// 仅打包后存在（resources/bin/sendkeys.exe）；dev 环境或文件缺失返回 null，
// 静默落到②PS worker，不报错。
function resolveSendkeysExePath() {
  if (process.platform !== "win32") return null;
  try {
    const { app } = require("electron");
    if (!app || !app.isPackaged) return null; // dev 环境跳过
    const exe = path.join(process.resourcesPath, "bin", "sendkeys.exe");
    return fs.existsSync(exe) ? exe : null;
  } catch (e) {
    return null;
  }
}

// 简单的等待工具：用于粘贴前的稳定窗口与粘贴后的消费窗口。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— Windows 按键注入统一入口（根因修复）——
// 旧实现 spawn("powershell", ["-Command", ...]) 未设 windowsHide，Node 默认 windowsHide:false，
// 会为 powershell 新建一个「可见控制台窗口」并抢走前台焦点 → SendKeys 的 ^v 发进了这个控制台
// 而不是用户的输入框，且退出码为 0，上层误判粘贴成功。
// 修复：CREATE_NO_WINDOW（windowsHide:true）+ -NoProfile/-NonInteractive 加速冷启动，
// 焦点始终留在用户的目标窗口，SendKeys 才能命中。
function spawnWindowsSendKeys(psCommand) {
  return spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psCommand],
    { windowsHide: true }
  );
}

// —— Windows 常驻隐藏 SendKeys worker 脚本 ——
// 常驻循环读 stdin：'paste'/'copy'/'selectall' → SendKeys，成功回 'ok'，失败回 'err:<原因>'；
// 'ping' → 'pong'（预热用）。首选 .NET Windows.Forms SendWait（兼容性好），
// 抛错时同一 worker 内换 WScript.Shell COM 备路再试一次。
// 相比每次冷启动 PowerShell：无冷启动延迟、无被安全策略反复拦截的概率、有真实回执。
const WIN_WORKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$wsh = $null
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'ping') { [Console]::Out.WriteLine('pong'); continue }
  $keys = $null
  if ($line -eq 'paste') { $keys = '^v' }
  elseif ($line -eq 'copy') { $keys = '^c' }
  elseif ($line -eq 'selectall') { $keys = '^a' }
  if ($null -eq $keys) { [Console]::Out.WriteLine('err:unknown-cmd'); continue }
  try {
    [System.Windows.Forms.SendKeys]::SendWait($keys)
    [Console]::Out.WriteLine('ok')
  } catch {
    try {
      if ($null -eq $wsh) { $wsh = New-Object -ComObject WScript.Shell }
      $wsh.SendKeys($keys)
      [Console]::Out.WriteLine('ok')
    } catch {
      $msg = ($_.Exception.Message -replace '[\\r\\n]+', ' ')
      [Console]::Out.WriteLine('err:' + $msg)
    }
  }
}
`;

class ClipboardManager {
  constructor(logger, databaseManager = null) {
    // 初始化剪贴板管理器
    this.logger = logger;
    // 可选注入数据库管理器：用于读取「保留最近一次生成结果到剪贴板」设置。
    // 未注入（undefined/null）时一律按今日默认行为处理（粘贴后恢复原剪贴板）。
    this.databaseManager = databaseManager || null;
    // 串行锁：保证任意时刻只有一个粘贴在执行，杜绝多次粘贴交叠互相污染剪贴板
    this._pasteChain = Promise.resolve();
    // 待执行的剪贴板恢复定时器：新一次粘贴开始时取消旧的，只让最新一次粘贴负责恢复（ROB-3）
    this._restoreTimer = null;
    // 辅助功能权限缓存：流式增量粘贴时绝不能每个分片都 spawn 一次 osascript 检查，
    // 否则一句长文会瞬间派生几十上百个进程把输入法/前台 App 卡死。缓存一段时间即可。
    this._accessOk = null;
    this._accessCheckedAt = 0;
    // Windows 常驻 SendKeys worker：进程句柄 / 待回执队列(FIFO) / stdout 行缓冲
    this._winWorker = null;
    this._winWorkerQueue = [];
    this._winWorkerBuf = "";
    // 原生按键注入器 sendkeys.exe 路径缓存：undefined=未解析，null=不可用，string=可用路径
    this._sendkeysExe = undefined;
    
    // 尝试加载 osascript 模块（仅在 macOS 上）
    this.osascript = null;
    if (process.platform === "darwin") {
      try {
        this.osascript = require("osascript");
        this.safeLog("✅ osascript 模块加载成功");
      } catch (error) {
        this.safeLog("⚠️ osascript 模块加载失败，将使用备用方法", error.message);
      }
    }
  }

  // 安全日志方法 - 使用logManager记录
  safeLog(message, data = null) {
    if (this.logger) {
      try {
        this.logger.info(message, data);
      } catch (error) {
        // 静默忽略 EPIPE 错误
        if (error.code !== "EPIPE") {
          process.stderr.write(`日志错误: ${error.message}\n`);
        }
      }
    }
  }

  // 兼容旧 IPC 名称：只查询当前应用身份，不触发权限弹窗。
  async enableMacOSAccessibility() {
    if (process.platform !== "darwin") return true;
    this.safeLog("🔧 查询当前应用的 macOS 辅助功能权限");
    return this.checkAccessibilityPermissions();
  }

  // 简化的文本插入方法 - 直接使用标准粘贴方式
  async insertTextDirectly(text) {
    // 简化实现，直接使用标准的粘贴方法
    this.safeLog("🎯 使用标准粘贴方式插入文本");
    return await this.pasteText(text);
  }

  // 对外入口：串行化每一次粘贴，避免并发粘贴互相覆盖剪贴板
  async pasteText(text) {
    const run = () => this._pasteTextImpl(text);
    const resultPromise = this._pasteChain.then(run, run);
    // 无论本次成功失败，都让链继续，下一次粘贴排在其后
    this._pasteChain = resultPromise.then(
      () => undefined,
      () => undefined
    );
    return resultPromise;
  }

  async _pasteTextImpl(text) {
    try {
      // 新一次粘贴开始：取消上一次仍在等待的剪贴板恢复，避免旧定时器把过期内容写回（ROB-3）
      if (this._restoreTimer) {
        clearTimeout(this._restoreTimer);
        this._restoreTimer = null;
      }
      // 首先保存原始剪贴板内容
      const originalClipboard = clipboard.readText();
      this.safeLog(
        "💾 已保存原始剪贴板内容",
        originalClipboard.substring(0, 50) + "..."
      );

      // 将文本复制到剪贴板，并回读校验（移植自 zuiti 的剪贴板写入校验，保证粘贴内容正确）
      clipboard.writeText(text);
      const written = clipboard.readText();
      if (written !== text) {
        // 校验不一致时重写一次
        clipboard.writeText(text);
        this.safeLog("⚠️ 剪贴板写入校验失败，已重写");
      } else {
        this.safeLog("✅ 剪贴板写入校验通过", text.substring(0, 50) + "...");
      }

      if (process.platform === "darwin") {
        // 权限检查走缓存：避免每次粘贴都多 spawn 一个 osascript 进程拖慢出字。
        this.safeLog("🔍 检查粘贴操作的辅助功能权限(缓存)");
        const hasPermissions = await this.ensureAccessibilityCached();

        if (!hasPermissions) {
          this.safeLog("⚠️ 没有辅助功能权限 - 文本仅复制到剪贴板");
          const errorMsg =
            "需要辅助功能权限才能自动粘贴。文本已复制到剪贴板 - 请手动使用 Cmd+V 粘贴。";
          throw new Error(errorMsg);
        }

        this.safeLog("✅ 权限已授予，尝试粘贴");
        return await this.pasteMacOS(originalClipboard, text);
      } else if (process.platform === "win32") {
        return await this.pasteWindows(originalClipboard, text);
      } else {
        return await this.pasteLinux(originalClipboard, text);
      }
    } catch (error) {
      throw error;
    }
  }

  // 读取「保留最近一次生成结果到剪贴板」设置：
  // 开启时返回 true（调用方应跳过恢复）。无数据库或读取异常一律返回 false → 回退到今日默认行为（恢复）。
  async shouldKeepResultInClipboard() {
    if (!this.databaseManager || typeof this.databaseManager.getSetting !== "function") {
      return false;
    }
    try {
      return !!(await this.databaseManager.getSetting("keep_result_in_clipboard", false));
    } catch (e) {
      this.safeLog("⚠️ 读取 keep_result_in_clipboard 失败，回退为恢复剪贴板:", e?.message || e);
      return false;
    }
  }

  // 仅当剪贴板仍是“本次粘贴写入的文本”时才恢复原始内容，
  // 避免把过期内容写回、或覆盖掉更晚一次粘贴写入的内容。
  // 「保留最近一次生成结果到剪贴板」开启时直接 return，不安排恢复，把生成文本留在剪贴板。
  async restoreClipboardLater(originalClipboard, pastedText) {
    // 取消上一次仍在等待的恢复，只保留最新一次粘贴的恢复定时器（ROB-3）
    if (this._restoreTimer) {
      clearTimeout(this._restoreTimer);
      this._restoreTimer = null;
    }
    // 在安排恢复前读取设置：开启「保留结果」时跳过恢复。读取失败回退为恢复（默认行为）。
    if (await this.shouldKeepResultInClipboard()) {
      this.safeLog("📌 已开启“保留结果到剪贴板”，跳过恢复，生成文本保留在剪贴板");
      return;
    }
    this._restoreTimer = setTimeout(() => {
      this._restoreTimer = null;
      try {
        if (clipboard.readText() === pastedText) {
          clipboard.writeText(originalClipboard);
          this.safeLog("🔄 原始剪贴板内容已恢复");
        } else {
          this.safeLog("↩️ 剪贴板已被更新内容占用，跳过恢复");
        }
      } catch (e) {
        // 忽略恢复失败
      }
    }, CLIPBOARD_RESTORE_MS);
  }

  async pasteMacOS(originalClipboard, pastedText) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const pasteProcess = spawn("osascript", [
          "-e",
          'tell application "System Events" to keystroke "v" using command down',
        ]);

        let errorOutput = "";
        let hasTimedOut = false;

        pasteProcess.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (hasTimedOut) return;

          // 首先清除超时
          clearTimeout(timeoutId);

          // 清理进程引用
          pasteProcess.removeAllListeners();

          if (code === 0) {
            this.safeLog("✅ 通过 Cmd+V 模拟成功粘贴文本");
            this.restoreClipboardLater(originalClipboard, pastedText);
            resolve();
          } else {
            const errorMsg = `粘贴失败 (代码 ${code})。文本已复制到剪贴板 - 请手动使用 Cmd+V 粘贴。`;
            reject(new Error(errorMsg));
          }
        });

        pasteProcess.on("error", (error) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          pasteProcess.removeAllListeners();
          const errorMsg = `粘贴命令失败: ${error.message}。文本已复制到剪贴板 - 请手动使用 Cmd+V 粘贴。`;
          reject(new Error(errorMsg));
        });

        const timeoutId = setTimeout(() => {
          hasTimedOut = true;
          pasteProcess.kill("SIGKILL");
          pasteProcess.removeAllListeners();
          const errorMsg =
            "粘贴操作超时。文本已复制到剪贴板 - 请手动使用 Cmd+V 粘贴。";
          reject(new Error(errorMsg));
        }, 3000);
      }, PASTE_SETTLE_MS);
    });
  }

  // —— Windows 常驻隐藏 SendKeys worker（回执制，取代每次冷启动 PowerShell）——

  // 实际拉起 worker 进程（独立方法：便于单测替换为 node mock worker）
  _spawnWinWorkerProcess() {
    return spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WIN_WORKER_SCRIPT,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
  }

  // 懒启动/复用常驻 worker；worker 挂掉时清空句柄并拒绝所有待回执命令（下次调用自动重启）
  _ensureWinWorker() {
    if (this._winWorker && !this._winWorker.killed) return this._winWorker;
    const proc = this._spawnWinWorkerProcess();
    this._winWorker = proc;
    this._winWorkerBuf = "";
    proc.stdout.on("data", (d) => {
      this._winWorkerBuf += d.toString();
      let idx;
      while ((idx = this._winWorkerBuf.indexOf("\n")) >= 0) {
        const line = this._winWorkerBuf.slice(0, idx).replace(/\r$/, "").trim();
        this._winWorkerBuf = this._winWorkerBuf.slice(idx + 1);
        if (!line) continue;
        const pending = this._winWorkerQueue.shift();
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(line);
        }
      }
    });
    if (proc.stderr) proc.stderr.on("data", () => { /* 丢弃，避免管道堵塞 */ });
    const onGone = (why) => {
      if (this._winWorker !== proc) return; // 已被更新/主动清理过
      this._winWorker = null;
      const q = this._winWorkerQueue;
      this._winWorkerQueue = [];
      q.forEach((p) => {
        clearTimeout(p.timer);
        p.reject(new Error("SendKeys worker 已退出: " + why));
      });
      this.safeLog("⚠️ SendKeys worker 退出，下次按键将自动重启", String(why));
    };
    proc.on("exit", (code, signal) => onGone(`exit ${code} ${signal || ""}`));
    proc.on("error", (e) => onGone(e.message));
    this.safeLog("🚀 SendKeys worker 已拉起（常驻隐藏，回执制）");
    return proc;
  }

  // 发送一条命令并等待回执行；超时视为 worker 异常 → 杀掉置空（下次懒启动全新 worker）
  _winWorkerSend(cmd, timeoutMs = WIN_WORKER_ACK_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = this._ensureWinWorker();
      } catch (e) {
        return reject(e);
      }
      const pending = { resolve, reject, timer: null };
      pending.timer = setTimeout(() => {
        const i = this._winWorkerQueue.indexOf(pending);
        if (i >= 0) this._winWorkerQueue.splice(i, 1);
        if (this._winWorker === proc) this._winWorker = null;
        try { proc.kill(); } catch (e) { /* 可能已退出 */ }
        reject(new Error(`SendKeys worker 回执超时(${timeoutMs}ms): ${cmd}`));
      }, timeoutMs);
      this._winWorkerQueue.push(pending);
      try {
        proc.stdin.write(cmd + "\n");
      } catch (e) {
        clearTimeout(pending.timer);
        const i = this._winWorkerQueue.indexOf(pending);
        if (i >= 0) this._winWorkerQueue.splice(i, 1);
        reject(e);
      }
    });
  }

  // 解析并缓存 sendkeys.exe 路径（懒解析一次；dev/缺文件为 null → 直接走②）
  _getSendkeysExe() {
    if (this._sendkeysExe === undefined) this._sendkeysExe = resolveSendkeysExePath();
    return this._sendkeysExe;
  }

  // 运行一次 sendkeys.exe <cmd>：exit code 0 = 成功；超时/非 0/spawn 失败均 reject
  _runSendkeysExe(exe, cmd) {
    return new Promise((resolve, reject) => {
      const p = spawn(exe, [cmd], { windowsHide: true });
      let hasTimedOut = false;
      const to = setTimeout(() => {
        hasTimedOut = true;
        try { p.kill("SIGKILL"); } catch (e) { /* 进程可能已退出 */ }
        reject(new Error(`sendkeys.exe 超时(${SENDKEYS_EXE_TIMEOUT_MS}ms)`));
      }, SENDKEYS_EXE_TIMEOUT_MS);
      p.on("close", (code) => {
        if (hasTimedOut) return;
        clearTimeout(to);
        code === 0 ? resolve() : reject(new Error(`sendkeys.exe 退出码 ${code}`));
      });
      p.on("error", (e) => {
        if (hasTimedOut) return;
        clearTimeout(to);
        // spawn 失败（如 ENOENT：exe 缺失/路径错）明确标注原因，便于定位为何直接降级
        const reason = e && e.code === "ENOENT"
          ? `sendkeys.exe 未找到(ENOENT)：${exe}`
          : `sendkeys.exe spawn 失败: ${e?.message || e}`;
        reject(new Error(reason));
      });
    });
  }

  // 高层按键入口（三级链）：① 原生 sendkeys.exe（纯 Win32 SendInput，CLM 企业策略机唯一可用路径）
  // → ② PS 常驻 worker（回执制，err 回执 200ms 后重试一次）→ ③ 一次性隐藏 PowerShell
  async _pressKeyWin(cmd) {
    const exe = this._getSendkeysExe();
    if (exe) {
      try {
        await this._runSendkeysExe(exe, cmd);
        this.safeLog(`✅ sendkeys.exe ${cmd} 成功（原生 SendInput）`);
        return;
      } catch (e) {
        this.safeLog(`⚠️ sendkeys.exe ${cmd} 失败，回退 PS worker: ${e.message}`);
      }
    }
    try {
      let reply = await this._winWorkerSend(cmd);
      if (reply === "ok") return;
      this.safeLog("⚠️ SendKeys worker 回执异常，稍后重试一次", reply.slice(0, 200));
      await sleep(WIN_WORKER_RETRY_DELAY_MS);
      reply = await this._winWorkerSend(cmd);
      if (reply === "ok") return;
      throw new Error("worker 回执: " + reply.slice(0, 200));
    } catch (workerErr) {
      // 最后备路：worker 拉不起来/超时/连续 err 时，退回旧的一次性隐藏 PowerShell
      this.safeLog("⚠️ SendKeys worker 失败，回退一次性 PowerShell", workerErr.message);
      await this._pressKeyWinOneShot(cmd);
    }
  }

  // 旧路径保留为最后备路：一次性隐藏 PowerShell SendKeys（exit code 判定）
  _pressKeyWinOneShot(cmd) {
    const keys = { paste: "^v", copy: "^c", selectall: "^a" }[cmd];
    if (!keys) return Promise.reject(new Error("unknown key cmd: " + cmd));
    return new Promise((resolve, reject) => {
      const p = spawnWindowsSendKeys(
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${keys}")`
      );
      let hasTimedOut = false;
      const to = setTimeout(() => {
        hasTimedOut = true;
        try { p.kill("SIGKILL"); } catch (e) { /* 进程可能已退出 */ }
        reject(new Error(`Windows ${cmd} 操作超时。文本已复制到剪贴板。`));
      }, PASTE_KILL_TIMEOUT_MS);
      p.on("close", (code) => {
        if (hasTimedOut) return;
        clearTimeout(to);
        code === 0 ? resolve() : reject(new Error(`Windows ${cmd} 失败，代码 ${code}。文本已复制到剪贴板。`));
      });
      p.on("error", (e) => {
        if (hasTimedOut) return;
        clearTimeout(to);
        reject(new Error(`Windows ${cmd} 失败: ${e.message}。文本已复制到剪贴板。`));
      });
    });
  }

  // App 启动后空闲预热：提前拉起 worker + ping，让首次粘贴不吃 PowerShell 冷启动延迟
  async prewarmWindowsWorker() {
    if (process.platform !== "win32") return;
    try {
      const reply = await this._winWorkerSend("ping");
      this.safeLog(reply === "pong" ? "✅ SendKeys worker 预热完成" : "⚠️ SendKeys worker 预热回执异常: " + reply);
    } catch (e) {
      this.safeLog("⚠️ SendKeys worker 预热失败（首次粘贴时自动重试）:", e?.message || e);
    }
  }

  // App 退出时清理常驻 worker，绝不留孤儿进程
  killWinWorker() {
    const proc = this._winWorker;
    this._winWorker = null; // 先置空，让 onGone 的守卫跳过重复清理
    const q = this._winWorkerQueue;
    this._winWorkerQueue = [];
    q.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(new Error("App 退出，SendKeys worker 已关闭"));
    });
    if (proc) {
      try { proc.stdin.end(); } catch (e) { /* 忽略 */ }
      try { proc.kill(); } catch (e) { /* 忽略 */ }
    }
  }

  // Windows 三级粘贴链全失败时的兜底提示：文本已在剪贴板，弹系统通知引导手动粘贴。
  // 复用项目统一的 electron Notification 用法，绝不抛出（通知失败不影响主流程）。
  _notifyPasteFallback() {
    try {
      const { Notification } = require("electron");
      if (Notification && Notification.isSupported && Notification.isSupported()) {
        new Notification({
          title: "弦外小猫",
          body: "文本已复制，请按 Ctrl+V 粘贴",
          silent: false,
        }).show();
      }
    } catch (e) {
      this.safeLog("⚠️ 粘贴兜底通知失败", e?.message || e);
    }
  }

  async pasteWindows(originalClipboard, pastedText) {
    // 剪贴板写入已在 _pasteTextImpl 回读校验，这里给系统粘贴板短暂传播余量后再发 'paste'
    await sleep(PASTE_SETTLE_MS);
    try {
      await this._pressKeyWin("paste");
    } catch (e) {
      this.safeLog("❌ Windows 粘贴失败（worker 与备路均失败）", e.message);
      // 三级链全灭：文本已在剪贴板（此路径不触发 restoreClipboardLater，内容保留），
      // 主动弹系统通知引导用户手动 Ctrl+V，避免“转写完却没出字”的静默失败。
      this._notifyPasteFallback();
      throw new Error(`Windows 粘贴失败: ${e.message}。文本已复制到剪贴板。`);
    }
    this.safeLog("✅ Windows 粘贴回执 ok（常驻 worker / 备路）");
    // 收到 ok 回执后再安排延迟恢复原剪贴板，避免竞态截断
    this.restoreClipboardLater(originalClipboard, pastedText);
  }

  async pasteLinux(originalClipboard, pastedText) {
    return new Promise((resolve, reject) => {
      const pasteProcess = spawn("xdotool", ["key", "ctrl+v"]);

      let hasTimedOut = false;
      const timeoutId = setTimeout(() => {
        hasTimedOut = true;
        try { pasteProcess.kill("SIGKILL"); } catch (e) { /* 进程可能已退出 */ }
        reject(new Error("Linux 粘贴操作超时。文本已复制到剪贴板。"));
      }, PASTE_KILL_TIMEOUT_MS);

      pasteProcess.on("close", (code) => {
        if (hasTimedOut) return;
        clearTimeout(timeoutId);
        if (code === 0) {
          // 文本粘贴成功，延迟并校验后恢复
          this.restoreClipboardLater(originalClipboard, pastedText);
          resolve();
        } else {
          reject(
            new Error(
              `Linux 粘贴失败，代码 ${code}。文本已复制到剪贴板。`
            )
          );
        }
      });

      pasteProcess.on("error", (error) => {
        if (hasTimedOut) return;
        clearTimeout(timeoutId);
        reject(
          new Error(
            `Linux 粘贴失败: ${error.message}。文本已复制到剪贴板。`
          )
        );
      });
    });
  }

  async checkAccessibilityPermissions() {
    if (process.platform !== "darwin") return true;

    // 必须检查“当前应用身份”的 TCC 状态。旧实现只让 osascript 读取进程列表，
    // 该操作无需发送键盘事件，即使真实 Cmd+V 会被系统拒绝也可能返回 0，造成
    // “权限已授予”的误报。false 表示仅查询、绝不触发系统授权弹窗。
    try {
      const trusted = systemPreferences.isTrustedAccessibilityClient(false);
      if (!trusted) {
        this.safeLog("⚠️ 当前应用身份未获辅助功能权限，自动粘贴已静默停用");
      }
      return trusted;
    } catch (error) {
      this.safeLog("⚠️ 辅助功能权限检测失败，自动粘贴已静默停用", error?.message || error);
      return false;
    }
  }

  showAccessibilityDialog(testError) {
    const isStuckPermission =
      testError.includes("not allowed assistive access") ||
      testError.includes("(-1719)") ||
      testError.includes("(-25006)");

    let dialogMessage;
    if (isStuckPermission) {
      dialogMessage = `🔒 弦外小猫需要辅助功能权限，但看起来您可能有来自先前版本的旧权限。

❗ 常见问题：如果您重新构建/重新安装了弦外小猫，旧权限可能"卡住"并阻止新权限。

🔧 解决方法：
1. 打开系统设置 → 隐私与安全性 → 辅助功能
2. 查找任何旧的"弦外小猫"条目并删除它们（点击 - 按钮）
3. 同时删除任何显示"Electron"或名称不明确的条目
4. 点击 + 按钮并手动添加新的弦外小猫应用
5. 确保复选框已启用
6. 重启弦外小猫

⚠️ 这在开发期间重新构建应用时特别常见。

📝 没有此权限，文本将只复制到剪贴板（无自动粘贴）。

您想现在打开系统设置吗？`;
    } else {
      dialogMessage = `🔒 弦外小猫需要辅助功能权限才能将文本粘贴到其他应用程序中。

📋 当前状态：剪贴板复制有效，但粘贴（Cmd+V 模拟）失败。

🔧 解决方法：
1. 打开系统设置（或较旧 macOS 上的系统偏好设置）
2. 转到隐私与安全性 → 辅助功能
3. 点击锁图标并输入您的密码
4. 将弦外小猫添加到列表中并勾选复选框
5. 重启弦外小猫

⚠️ 没有此权限，听写文本将只复制到剪贴板但不会自动粘贴。

💡 在生产版本中，此权限是完整功能所必需的。

您想现在打开系统设置吗？`;
    }

    const permissionDialog = spawn("osascript", [
      "-e",
      `display dialog "${dialogMessage}" buttons {"取消", "打开系统设置"} default button "打开系统设置"`,
    ]);

    permissionDialog.on("close", (dialogCode) => {
      if (dialogCode === 0) {
        this.openSystemSettings();
      }
    });

    permissionDialog.on("error", (error) => {
      // 权限对话框错误 - 用户需要手动授予权限
    });
  }

  openSystemSettings() {
    const settingsCommands = [
      [
        "open",
        [
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        ],
      ],
      ["open", ["-b", "com.apple.systempreferences"]],
      ["open", ["/System/Library/PreferencePanes/Security.prefPane"]],
    ];

    let commandIndex = 0;
    const tryNextCommand = () => {
      if (commandIndex < settingsCommands.length) {
        const [cmd, args] = settingsCommands[commandIndex];
        const settingsProcess = spawn(cmd, args);

        settingsProcess.on("error", (error) => {
          commandIndex++;
          tryNextCommand();
        });

        settingsProcess.on("close", (settingsCode) => {
          if (settingsCode !== 0) {
            commandIndex++;
            tryNextCommand();
          }
        });
      } else {
        // 所有设置命令都失败，尝试后备方案
        spawn("open", ["-a", "System Preferences"]).on("error", () => {
          spawn("open", ["-a", "System Settings"]).on("error", () => {
            // 无法打开设置应用
          });
        });
      }
    };

    tryNextCommand();
  }

  // —— 流式增量上屏(供路线 I：边生成边追加到光标处) ——
  // 读取失败返回 null（而非 ""）：让 restoreClipboard 跳过恢复，绝不用空串覆盖用户剪贴板（SF-6）。
  captureClipboard() {
    try {
      return clipboard.readText();
    } catch (e) {
      this.safeLog("⚠️ 读取剪贴板失败，将跳过本次恢复:", e?.message || e);
      return null;
    }
  }
  // 仅当捕获到了有效原始内容（非 null）时才恢复；捕获失败时跳过，避免清空用户剪贴板（SF-6）。
  async restoreClipboard(text) {
    if (text === null || text === undefined) {
      this.safeLog("↩️ 未捕获到原始剪贴板内容，跳过恢复");
      return;
    }
    try { clipboard.writeText(text); } catch (e) { /* 忽略 */ }
  }

  // 按一次粘贴键（不恢复剪贴板），平台通用；Windows 走常驻 worker（回执制，失败自动回退一次性 spawn）
  _pressPaste() {
    if (process.platform === "win32") return this._pressKeyWin("paste");
    return new Promise((resolve, reject) => {
      let p;
      if (process.platform === "darwin") {
        p = spawn("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down']);
      } else {
        p = spawn("xdotool", ["key", "ctrl+v"]);
      }
      const to = setTimeout(() => { try { p.kill("SIGKILL"); } catch (e) {} reject(new Error("paste timeout")); }, 3000);
      p.on("close", (code) => { clearTimeout(to); code === 0 ? resolve() : reject(new Error("paste " + code)); });
      p.on("error", (e) => { clearTimeout(to); reject(e); });
    });
  }

  // 按一次复制键（Cmd/Ctrl+C），不动剪贴板恢复，平台通用。结构与 _pressPaste 一致。
  _pressCopy() {
    if (process.platform === "win32") return this._pressKeyWin("copy");
    return new Promise((resolve, reject) => {
      let p;
      if (process.platform === "darwin") {
        p = spawn("osascript", ["-e", 'tell application "System Events" to keystroke "c" using command down']);
      } else {
        p = spawn("xdotool", ["key", "ctrl+c"]);
      }
      let hasTimedOut = false;
      const to = setTimeout(() => { hasTimedOut = true; try { p.kill("SIGKILL"); } catch (e) {} reject(new Error("copy timeout")); }, PASTE_KILL_TIMEOUT_MS);
      p.on("close", (code) => { if (hasTimedOut) return; clearTimeout(to); code === 0 ? resolve() : reject(new Error("copy " + code)); });
      p.on("error", (e) => { if (hasTimedOut) return; clearTimeout(to); reject(e); });
    });
  }

  // 按一次全选键（Cmd/Ctrl+A），平台通用。结构与 _pressPaste 一致。
  _pressSelectAll() {
    if (process.platform === "win32") return this._pressKeyWin("selectall");
    return new Promise((resolve, reject) => {
      let p;
      if (process.platform === "darwin") {
        p = spawn("osascript", ["-e", 'tell application "System Events" to keystroke "a" using command down']);
      } else {
        p = spawn("xdotool", ["key", "ctrl+a"]);
      }
      let hasTimedOut = false;
      const to = setTimeout(() => { hasTimedOut = true; try { p.kill("SIGKILL"); } catch (e) {} reject(new Error("selectall timeout")); }, PASTE_KILL_TIMEOUT_MS);
      p.on("close", (code) => { if (hasTimedOut) return; clearTimeout(to); code === 0 ? resolve() : reject(new Error("selectall " + code)); });
      p.on("error", (e) => { if (hasTimedOut) return; clearTimeout(to); reject(e); });
    });
  }

  // 捕获当前聚焦应用里「已选中」的文本：复制走串行链，与粘贴互不交叠（杜绝键盘风暴卡死）。
  // 没有选中时回退「全选→复制」。用哨兵串判断本次复制是否真正写入剪贴板。
  // 始终在 finally 恢复用户原始剪贴板，即便中途出错。返回 { text, usedSelectAll }。
  async captureSelectionText(options = {}) {
    // 全选回退现在是可选项：仅当调用方显式传入 allowSelectAll === true 时才允许“无选区→全选→复制”。
    // 默认（无参数或未显式开启）为安全模式：不全选，避免误翻译整段输入框内容。
    const allowSelectAll = options && options.allowSelectAll === true;
    const run = async () => {
      // 用户原始剪贴板：流程结束（含出错）后必须恢复，避免污染用户剪贴板。
      const original = clipboard.readText();
      const SENTINEL = "__WT_CAP_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      let usedSelectAll = false;
      try {
        clipboard.writeText(SENTINEL);

        // macOS 下走缓存的辅助功能权限检查；未授权则恢复原剪贴板并抛出与 _pasteText 相同的错误。
        if (process.platform === "darwin") {
          const ok = await this.ensureAccessibilityCached();
          if (!ok) {
            throw new Error(
              "需要辅助功能权限才能自动粘贴。文本已复制到剪贴板 - 请手动使用 Cmd+V 粘贴。"
            );
          }
        }

        // 复制后轮询剪贴板：慢机器/大段选区可能 >150ms 才写入，单次读取易误判“无选区”。
        // 最多读 3 次，一旦剪贴板不再是哨兵串且非空即返回；全程仍是哨兵串才算“无选区”。
        const readAfterCopy = async () => {
          for (let i = 0; i < 3; i++) {
            await sleep(i === 0 ? COPY_SETTLE_MS : 110);
            const c = clipboard.readText();
            if (c !== SENTINEL && c.trim()) return c;
          }
          return clipboard.readText();
        };

        await sleep(PASTE_SETTLE_MS);
        await this._pressCopy();
        let captured = await readAfterCopy();

        if (captured === SENTINEL || !captured.trim()) {
          if (allowSelectAll) {
            // 经过多次轮询仍是哨兵串 → 确实没有选中文本 → 全选后再复制（至多一次，无递归）
            clipboard.writeText(SENTINEL);
            await this._pressSelectAll();
            await sleep(PASTE_CONSUME_MS);
            await this._pressCopy();
            captured = await readAfterCopy();
            usedSelectAll = true;
          } else {
            // 未开启全选回退：视为“无选区”，跳过全选，不翻译整段输入。
            // finally 仍会恢复用户原始剪贴板。
            return { text: "", usedSelectAll: false };
          }
        }

        if (captured === SENTINEL || !captured.trim()) {
          return { text: "", usedSelectAll };
        }
        return { text: captured, usedSelectAll };
      } finally {
        // 无论成功失败，恢复用户原始剪贴板，使后续 pasteText 能正确保存/恢复它。
        try { clipboard.writeText(original); } catch (e) { /* 忽略恢复失败 */ }
      }
    };
    // 投入与粘贴共用的串行链，确保捕获过程永不与任何粘贴交叠。
    const resultPromise = this._pasteChain.then(run, run);
    this._pasteChain = resultPromise.then(() => undefined, () => undefined);
    return resultPromise;
  }

  // 带缓存的辅助功能权限检查：默认 30s 内复用上次结果，避免高频流式粘贴时进程风暴。
  async ensureAccessibilityCached(ttlMs = 30000) {
    if (process.platform !== "darwin") return true;
    const now = Date.now();
    if (this._accessOk === true && now - this._accessCheckedAt < ttlMs) {
      return true;
    }
    const ok = await this.checkAccessibilityPermissions();
    this._accessOk = ok;
    this._accessCheckedAt = now;
    return ok;
  }

  // 追加一段文本到光标处：写剪贴板→稳定→Cmd+V→消费等待，不恢复。与 pasteText 共用串行链，保证顺序。
  // 空文本（appendChunk("")）仅用作排空/等待屏障：排在链尾被 await，绝不写剪贴板、绝不粘贴。
  async appendChunk(text) {
    const run = async () => {
      // 空文本只作为串行链上的等待屏障：不写剪贴板、不粘贴，直接放行。
      if (!text) return;
      // a. 写剪贴板并回读校验，不一致则重写一次。
      clipboard.writeText(text);
      if (clipboard.readText() !== text) clipboard.writeText(text);
      // b. 走缓存的辅助功能权限检查，避免高频流式粘贴时进程风暴。
      if (process.platform === "darwin") {
        const ok = await this.ensureAccessibilityCached();
        if (!ok) throw new Error("需要辅助功能权限");
      }
      // c. 粘贴前稳定：确保系统粘贴板已持有新文本，再触发 Cmd+V。
      await sleep(PASTE_SETTLE_MS);
      // d. 触发一次 Cmd+V。
      await this._pressPaste();
      // e. 粘贴后消费等待：在 resolve 前确保目标 App 已吃进本次粘贴，
      //    这样串行链上的下一个分片才不会过早 writeText 覆盖粘贴板，杜绝重复 + 丢字。
      await sleep(PASTE_CONSUME_MS);
    };
    const resultPromise = this._pasteChain.then(run, run);
    this._pasteChain = resultPromise.then(() => undefined, () => undefined);
    return resultPromise;
  }

  /**
   * 复制文本到剪贴板
   * @param {string} text - 要复制的文本
   * @returns {Promise<{success: boolean}>}
   */
  async copyText(text) {
    try {
      clipboard.writeText(text);
      return { success: true };
    } catch (error) {
      throw error;
    }
  }

  /**
   * 从剪贴板读取文本
   * @returns {Promise<string>}
   */
  async readClipboard() {
    try {
      const text = clipboard.readText();
      return text;
    } catch (error) {
      throw error;
    }
  }

  /**
   * 将文本写入剪贴板
   * @param {string} text - 要写入的文本
   * @returns {Promise<{success: boolean}>}
   */
  async writeClipboard(text) {
    try {
      clipboard.writeText(text);
      return { success: true };
    } catch (error) {
      throw error;
    }
  }
}

module.exports = ClipboardManager;
