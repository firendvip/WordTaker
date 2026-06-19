const { clipboard } = require("electron");
const { spawn } = require("child_process");

// 模拟 Cmd+V 前，等待剪贴板写入稳定的时间。
// 剪贴板写入已在 _pasteTextImpl 里做过同步回读校验，这里只需给系统粘贴板很短的传播余量，
// 故从 120ms 收紧到 60ms 以加快"出字"，仍保留约 2 倍于常见传播耗时的安全边际。
const PASTE_SETTLE_MS = 60;
// 模拟 Cmd+V 后，等待目标 App 真正消费完粘贴、再恢复原始剪贴板的时间。
// 必须足够长：太短会导致目标 App 读到“被恢复的旧内容”，从而粘贴上一次的结果。
const CLIPBOARD_RESTORE_MS = 700;
// 粘贴子进程的兜底超时：超过该时间仍未结束则 SIGKILL，避免挂死的粘贴进程堆积（ROB-4）。
const PASTE_KILL_TIMEOUT_MS = 3000;

class ClipboardManager {
  constructor(logger) {
    // 初始化剪贴板管理器
    this.logger = logger;
    // 串行锁：保证任意时刻只有一个粘贴在执行，杜绝多次粘贴交叠互相污染剪贴板
    this._pasteChain = Promise.resolve();
    // 待执行的剪贴板恢复定时器：新一次粘贴开始时取消旧的，只让最新一次粘贴负责恢复（ROB-3）
    this._restoreTimer = null;
    // 辅助功能权限缓存：流式增量粘贴时绝不能每个分片都 spawn 一次 osascript 检查，
    // 否则一句长文会瞬间派生几十上百个进程把输入法/前台 App 卡死。缓存一段时间即可。
    this._accessOk = null;
    this._accessCheckedAt = 0;
    
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

  // 简化的 macOS accessibility 检查
  async enableMacOSAccessibility() {
    if (process.platform !== "darwin") return true;
    
    try {
      this.safeLog("🔧 检查 macOS accessibility 权限");
      
      // 简化为基本的权限检查，不设置复杂的AXManualAccessibility
      const script = `
        tell application "System Events"
          set frontApp to name of first application process whose frontmost is true
          return frontApp
        end tell
      `;
      
      const testProcess = spawn("osascript", ["-e", script]);
      
      return new Promise((resolve) => {
        testProcess.on("close", (code) => {
          if (code === 0) {
            this.safeLog("✅ macOS accessibility 权限正常");
            resolve(true);
          } else {
            this.safeLog("⚠️ macOS accessibility 权限不足");
            resolve(false);
          }
        });
        
        testProcess.on("error", () => {
          this.safeLog("❌ accessibility 权限检查失败");
          resolve(false);
        });
      });
    } catch (error) {
      this.safeLog("❌ 检查 macOS accessibility 时出错:", error.message);
      return false;
    }
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

  // 仅当剪贴板仍是“本次粘贴写入的文本”时才恢复原始内容，
  // 避免把过期内容写回、或覆盖掉更晚一次粘贴写入的内容。
  restoreClipboardLater(originalClipboard, pastedText) {
    // 取消上一次仍在等待的恢复，只保留最新一次粘贴的恢复定时器（ROB-3）
    if (this._restoreTimer) {
      clearTimeout(this._restoreTimer);
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

  async pasteWindows(originalClipboard, pastedText) {
    return new Promise((resolve, reject) => {
      const pasteProcess = spawn("powershell", [
        "-Command",
        'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^v")',
      ]);

      let hasTimedOut = false;
      const timeoutId = setTimeout(() => {
        hasTimedOut = true;
        try { pasteProcess.kill("SIGKILL"); } catch (e) { /* 进程可能已退出 */ }
        reject(new Error("Windows 粘贴操作超时。文本已复制到剪贴板。"));
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
              `Windows 粘贴失败，代码 ${code}。文本已复制到剪贴板。`
            )
          );
        }
      });

      pasteProcess.on("error", (error) => {
        if (hasTimedOut) return;
        clearTimeout(timeoutId);
        reject(
          new Error(
            `Windows 粘贴失败: ${error.message}。文本已复制到剪贴板。`
          )
        );
      });
    });
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

    return new Promise((resolve) => {
      // 检查辅助功能权限
      const testProcess = spawn("osascript", [
        "-e",
        'tell application "System Events" to get name of first process',
      ]);

      let testOutput = "";
      let testError = "";

      testProcess.stdout.on("data", (data) => {
        testOutput += data.toString();
      });

      testProcess.stderr.on("data", (data) => {
        testError += data.toString();
      });

      testProcess.on("close", (code) => {
        if (code === 0) {
          resolve(true);
        } else {
          // 不弹系统对话框（按需在设置里引导授权），仅记录日志
          this.safeLog("⚠️ 辅助功能权限不足，请在设置 → 权限中授权");
          resolve(false);
        }
      });

      testProcess.on("error", (error) => {
        resolve(false);
      });
    });
  }

  showAccessibilityDialog(testError) {
    const isStuckPermission =
      testError.includes("not allowed assistive access") ||
      testError.includes("(-1719)") ||
      testError.includes("(-25006)");

    let dialogMessage;
    if (isStuckPermission) {
      dialogMessage = `🔒 WordTaker需要辅助功能权限，但看起来您可能有来自先前版本的旧权限。

❗ 常见问题：如果您重新构建/重新安装了WordTaker，旧权限可能"卡住"并阻止新权限。

🔧 解决方法：
1. 打开系统设置 → 隐私与安全性 → 辅助功能
2. 查找任何旧的"WordTaker"条目并删除它们（点击 - 按钮）
3. 同时删除任何显示"Electron"或名称不明确的条目
4. 点击 + 按钮并手动添加新的WordTaker应用
5. 确保复选框已启用
6. 重启WordTaker

⚠️ 这在开发期间重新构建应用时特别常见。

📝 没有此权限，文本将只复制到剪贴板（无自动粘贴）。

您想现在打开系统设置吗？`;
    } else {
      dialogMessage = `🔒 WordTaker需要辅助功能权限才能将文本粘贴到其他应用程序中。

📋 当前状态：剪贴板复制有效，但粘贴（Cmd+V 模拟）失败。

🔧 解决方法：
1. 打开系统设置（或较旧 macOS 上的系统偏好设置）
2. 转到隐私与安全性 → 辅助功能
3. 点击锁图标并输入您的密码
4. 将WordTaker添加到列表中并勾选复选框
5. 重启WordTaker

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

  // 按一次粘贴键（不恢复剪贴板），平台通用
  _pressPaste() {
    return new Promise((resolve, reject) => {
      let cmd, args;
      if (process.platform === "darwin") {
        cmd = "osascript"; args = ["-e", 'tell application "System Events" to keystroke "v" using command down'];
      } else if (process.platform === "win32") {
        cmd = "powershell"; args = ["-Command", 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^v")'];
      } else {
        cmd = "xdotool"; args = ["key", "ctrl+v"];
      }
      const p = spawn(cmd, args);
      const to = setTimeout(() => { try { p.kill("SIGKILL"); } catch (e) {} reject(new Error("paste timeout")); }, 3000);
      p.on("close", (code) => { clearTimeout(to); code === 0 ? resolve() : reject(new Error("paste " + code)); });
      p.on("error", (e) => { clearTimeout(to); reject(e); });
    });
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

  // 追加一段文本到光标处：写剪贴板→Cmd+V，不恢复。与 pasteText 共用串行链，保证顺序。
  async appendChunk(text) {
    const run = async () => {
      if (!text) return;
      clipboard.writeText(text);
      if (clipboard.readText() !== text) clipboard.writeText(text);
      if (process.platform === "darwin") {
        const ok = await this.ensureAccessibilityCached();
        if (!ok) throw new Error("需要辅助功能权限");
      }
      await this._pressPaste();
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