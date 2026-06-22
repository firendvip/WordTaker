const { ipcMain } = require("electron");
const AiService = require("./aiService");

// 设置键白名单：渲染层只能写入这些键，杜绝写入 __proto__ 等任意键
const ALLOWED_SETTING_KEYS = new Set([
  "ai_api_key", "ai_base_url", "ai_model", "enable_ai_optimization",
  "copywriting_mode_enabled", "llm_prompt_template", "llm_temperature",
  "llm_max_tokens", "llm_extra_body", "llm_fallback_paste_raw",
  "recording_trigger", "cancel_key", "cancel_taps", "raw_stop_key", "raw_stop_taps",
  "sound_scheme", "sound_volume",
  "asr_engine", "skip_polish_max_chars",
  // 润色角色 + 「转英文」触发键
  "llm_active_role", "translate_trigger", "translate_fallback_select_all",
  // 文案优化中转（key 留在服务器端，客户端只存中转地址与令牌）
  "llm_relay_enabled", "llm_relay_url", "llm_relay_token", "llm_streaming_enabled",
  // 保留最近一次生成结果到剪贴板（开启后粘贴完不恢复用户原剪贴板）
  "keep_result_in_clipboard",
  // 胶囊中心动画皮肤（'music' | 'voiceink'）
  "pill_skin",
  // 胶囊跟随输入焦点：true 跟随焦点/鼠标；false 固定屏幕底部居中
  "pill_follow_focus",
]);
// 转录选项白名单：渲染层只能透传这些键到 Python 边界，丢弃未知键（IPCVAL-1）。
// 与 funasr_server.py 的 default_options 对齐。
const ALLOWED_TRANSCRIBE_OPTION_KEYS = new Set([
  "engine", "language", "hotword", "use_vad", "use_punc", "batch_size_s",
]);

// 只保留白名单内的转录选项键，丢弃其余键（含 __proto__ 等原型污染键）。
function sanitizeTranscribeOptions(options) {
  if (!options || typeof options !== "object") return {};
  const safe = {};
  for (const key of ALLOWED_TRANSCRIBE_OPTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      safe[key] = options[key];
    }
  }
  return safe;
}

// 合法日志级别，防止 this.logger[level] 调用注入
const VALID_LOG_LEVELS = new Set(["info", "warn", "error", "debug"]);
// 允许查询的 app 路径名
const ALLOWED_APP_PATHS = new Set([
  "userData", "logs", "temp", "appData", "home", "documents", "downloads", "desktop",
]);
class IPCHandlers {
  constructor(managers) {
    this.environmentManager = managers.environmentManager;
    this.databaseManager = managers.databaseManager;
    this.clipboardManager = managers.clipboardManager;
    this.funasrManager = managers.funasrManager;
    this.windowManager = managers.windowManager;
    this.hotkeyManager = managers.hotkeyManager;
    this.aiService = new AiService({ databaseManager: managers.databaseManager, logger: managers.logger });
    this.logger = managers.logger; // 添加logger引用
    
    // 跟踪F2热键注册状态
    this.f2RegisteredSenders = new Set();
    
    this.setupHandlers();
  }

  setupHandlers() {
    // 环境和配置相关
    ipcMain.handle("get-config", () => {
      return this.environmentManager.exportConfig();
    });

    ipcMain.handle("validate-environment", () => {
      return this.environmentManager.validateEnvironment();
    });

    // 录音相关（实际录音在渲染层用 MediaRecorder 完成，这两个 IPC 为历史遗留、未实现）
    ipcMain.handle("start-recording", async () => {
      return { success: false, error: "功能暂未实现" };
    });

    ipcMain.handle("stop-recording", async () => {
      return { success: false, error: "功能暂未实现" };
    });

    // Python 和 FunASR 相关
    ipcMain.handle("check-python", async () => {
      return await this.funasrManager.checkPythonInstallation();
    });

    ipcMain.handle("install-python", async (event, progressCallback) => {
      return await this.funasrManager.installPython((progress) => {
        event.sender.send("python-install-progress", progress);
      });
    });

    ipcMain.handle("check-funasr", async () => {
      return await this.funasrManager.checkFunASRInstallation();
    });

    ipcMain.handle("check-funasr-status", async () => {
      const status = await this.funasrManager.checkStatus();
      
      // 添加模型初始化状态信息
      return {
        ...status,
        models_initialized: this.funasrManager.modelsInitialized,
        server_ready: this.funasrManager.serverReady,
        is_initializing: this.funasrManager.initializationPromise !== null
      };
    });

    ipcMain.handle("install-funasr", async (event) => {
      return await this.funasrManager.installFunASR((progress) => {
        event.sender.send("funasr-install-progress", progress);
      });
    });

    ipcMain.handle("funasr-status", async () => {
      return await this.funasrManager.checkStatus();
    });

    // 模型文件管理
    ipcMain.handle("check-model-files", async () => {
      return await this.funasrManager.checkModelFiles();
    });

    ipcMain.handle("get-download-progress", async () => {
      return await this.funasrManager.getDownloadProgress();
    });

    ipcMain.handle("download-models", async (event) => {
      return await this.funasrManager.downloadModels((progress) => {
        event.sender.send("model-download-progress", progress);
      });
    });

    // AI文本处理
    ipcMain.handle("process-text", async (event, text, mode = 'optimize') => {
      // IPC 是信任边界：自校验入参，避免 text 为空/超长导致下游抛错或浪费请求
      if (typeof text !== 'string' || !text.trim()) {
        return { success: false, error: '无有效文本' };
      }
      const MAX_TEXT_LENGTH = 10000;
      if (text.length > MAX_TEXT_LENGTH) {
        return { success: false, error: '文本过长' };
      }
      // 润色模式（copywriting）按当前「角色」解析：vibecoding→copywriting / gaoeq→gaoeq。
      // 其它模式（如 optimize）保持原样透传。
      const effectiveMode = mode === 'copywriting' ? await this.aiService.getPolishMode() : mode;
      return await this.aiService.processTextWithAI(text, effectiveMode);
    });

    ipcMain.handle("check-ai-status", async (event, testConfig = null) => {
      return await this.aiService.checkAIStatus(testConfig);
    });

    // 录音开始时预热 LLM 连接（fire-and-forget，失败无妨）
    ipcMain.handle("prewarm-llm", () => {
      this.aiService.prewarm();
      return { success: true };
    });

    // 流式润色 + 增量上屏：边收边贴到光标处。返回 { success, text, pastedAny }
    ipcMain.handle("process-text-stream", async (event, text) => {
      if (typeof text !== "string" || !text.trim()) return { success: false, error: "无有效文本", pastedAny: false };
      if (text.length > 10000) return { success: false, error: "文本过长", pastedAny: false };
      const streaming = await this.databaseManager.getSetting("llm_streaming_enabled", false);
      const relayEnabled = await this.databaseManager.getSetting("llm_relay_enabled", false);
      const relayUrl = await this.databaseManager.getSetting("llm_relay_url", "");
      if (!streaming || !relayEnabled || !relayUrl) {
        // 不是静默 no-op：返回明确的、可被渲染层展示的原因（STREAM-1）。
        const reason = !streaming
          ? "未开启流式上屏"
          : "流式上屏需要配置中转（relay）：请在设置中开启中转并填写中转地址后再使用。";
        this.logger.warn("流式上屏不可用:", reason);
        return { success: false, error: reason, code: "streaming-unavailable", pastedAny: false };
      }

      // 流式增量粘贴节流：按"句子边界或攒够 N 字"才贴一次，并对中途粘贴次数设硬上限，
      // 杜绝长句触发的 Cmd+V/osascript 进程风暴卡死输入法（稳定性优先）。
      const STREAM_FLUSH_MIN_CHARS = 40;
      const STREAM_MAX_PASTES = 40;
      const SENTENCE_BOUNDARY = /[。！？!?；;\n]/;
      // 首块只看字数、不看标点，让首字尽快出现（约节省 ~200ms 首字时间）
      const FIRST_FLUSH_CHARS = 12;
      const original = this.clipboardManager.captureClipboard();
      let buffer = "";
      let pastedAny = false;
      let pasteCount = 0;
      let firstFlushDone = false;
      const flush = (force) => {
        if (!buffer) return;
        // 达到中途上限后停止逐段粘贴，剩余内容攒到结束时一次性贴出
        if (!force && pasteCount >= STREAM_MAX_PASTES) return;
        const chunk = buffer;
        buffer = "";
        pastedAny = true;
        pasteCount++;
        // 投入串行链，不阻塞流读取
        this.clipboardManager.appendChunk(chunk).catch((e) => this.logger.warn("增量粘贴失败:", e?.message || e));
      };
      const onDelta = (d) => {
        buffer += d;
        const len = [...buffer].length;
        if (!firstFlushDone) {
          if (len >= FIRST_FLUSH_CHARS) { flush(); firstFlushDone = true; }
          return; // 首块只按字数触发，忽略句末标点
        }
        if (len >= STREAM_FLUSH_MIN_CHARS || SENTENCE_BOUNDARY.test(d)) flush();
      };

      // 润色模式按当前「角色」决定：vibecoding→copywriting / gaoeq→gaoeq
      const polishMode = await this.aiService.getPolishMode();
      const result = await this.aiService.processTextViaRelayStream(text, polishMode, relayUrl, onDelta);
      let flushError = null;
      try {
        flush(true); // 结束：强制贴出剩余缓冲（绕过上限）
        await this.clipboardManager.appendChunk(""); // 等待所有增量贴完
      } catch (e) {
        // 不再静默吞掉：记录上下文并把失败上报给渲染层，便于回退/告警（SF-1）。
        flushError = e?.message || String(e);
        this.logger.error("流式增量粘贴收尾失败:", flushError);
      }
      // 贴完后稍等再恢复原剪贴板，避免抢在最后一次 Cmd+V 之前。
      // 「保留最近一次生成结果到剪贴板」开启时跳过恢复，把生成文本留在剪贴板；
      // 读取设置失败一律回退到默认行为（恢复），绝不因读设置异常而破坏原有恢复逻辑。
      let keepResult = false;
      try {
        keepResult = await this.databaseManager.getSetting("keep_result_in_clipboard", false);
      } catch (e) {
        keepResult = false;
      }
      if (!keepResult) {
        setTimeout(() => this.clipboardManager.restoreClipboard(original), 500);
      }

      if (flushError) {
        return { success: false, error: flushError, text: result.text || "", pastedAny };
      }
      return { success: !!result.success, text: result.text || "", error: result.error, pastedAny };
    });

    // 音频转录相关
    ipcMain.handle("transcribe-audio", async (event, audioData, options) => {
      try {
        // IPC 是信任边界：只放行已知的转录选项键，丢弃未知键，避免任意键透传到 Python（IPCVAL-1）。
        const safeOptions = sanitizeTranscribeOptions(options);
        return await this.funasrManager.transcribeAudio(audioData, safeOptions);
      } catch (error) {
        this.logger.error("转录失败:", error?.message || error);
        return { success: false, error: error?.message || "转录失败" };
      }
    });

    // 数据库相关：每个 DB-facing IPC 都包 try/catch，失败返回结构化错误 + 记日志（SF-2），
    // 避免数据库异常直接 reject 渲染层 Promise / 崩溃。
    ipcMain.handle("save-transcription", (event, data) => {
      try {
        return this.databaseManager.saveTranscription(data);
      } catch (error) {
        this.logger.error("保存转录失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-transcriptions", (event, limit, offset) => {
      try {
        return this.databaseManager.getTranscriptions(limit, offset);
      } catch (error) {
        this.logger.error("获取转录列表失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-transcription", (event, id) => {
      try {
        return this.databaseManager.getTranscriptionById(id);
      } catch (error) {
        this.logger.error("获取转录失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("delete-transcription", (event, id) => {
      try {
        return this.databaseManager.deleteTranscription(id);
      } catch (error) {
        this.logger.error("删除转录失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("update-transcription", (event, id, fields) => {
      try {
        return this.databaseManager.updateTranscription(id, fields);
      } catch (error) {
        this.logger.error("更新转录失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("search-transcriptions", (event, query, limit) => {
      try {
        return this.databaseManager.searchTranscriptions(query, limit);
      } catch (error) {
        this.logger.error("搜索转录失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-transcription-stats", () => {
      try {
        return this.databaseManager.getTranscriptionStats();
      } catch (error) {
        this.logger.error("获取转录统计失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("clear-all-transcriptions", () => {
      try {
        return this.databaseManager.clearAllTranscriptions();
      } catch (error) {
        this.logger.error("清空转录失败:", error);
        return { success: false, error: error.message };
      }
    });

    // 设置相关
    ipcMain.handle("get-setting", (event, key, defaultValue) => {
      try {
        return this.databaseManager.getSetting(key, defaultValue);
      } catch (error) {
        this.logger.error("读取设置失败:", error);
        return defaultValue;
      }
    });

    ipcMain.handle("set-setting", (event, key, value) => {
      if (!ALLOWED_SETTING_KEYS.has(key)) {
        this.logger.warn("set-setting 拒绝未知设置键:", key);
        return { success: false, error: "invalid setting key" };
      }
      return this.databaseManager.setSetting(key, value);
    });

    ipcMain.handle("get-all-settings", () => {
      try {
        return this.databaseManager.getAllSettings();
      } catch (error) {
        this.logger.error("读取全部设置失败:", error);
        return {};
      }
    });

    ipcMain.handle("get-settings", () => {
      try {
        return this.databaseManager.getAllSettings();
      } catch (error) {
        this.logger.error("读取全部设置失败:", error);
        return {};
      }
    });

    ipcMain.handle("save-setting", (event, key, value) => {
      if (!ALLOWED_SETTING_KEYS.has(key)) {
        this.logger.warn("save-setting 拒绝未知设置键:", key);
        return { success: false, error: "invalid setting key" };
      }
      return this.databaseManager.setSetting(key, value);
    });

    ipcMain.handle("reset-settings", () => {
      // TODO: 实现重置设置功能
      return this.databaseManager.resetSettings();
    });

    // 剪贴板相关
    ipcMain.handle("copy-text", async (event, text) => {
      try {
        return await this.clipboardManager.copyText(text);
      } catch (error) {
        this.logger.error("复制文本失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("paste-text", async (event, text) => {
      return this.clipboardManager.pasteText(text);
    });

    ipcMain.handle("insert-text-directly", async (event, text) => {
      try {
        return await this.clipboardManager.insertTextDirectly(text);
      } catch (error) {
        this.logger.error("直接插入文本失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("enable-macos-accessibility", async () => {
      try {
        if (process.platform === "darwin") {
          const result = await this.clipboardManager.enableMacOSAccessibility();
          return { success: result };
        }
        return { success: true, message: "非 macOS 平台，无需设置" };
      } catch (error) {
        this.logger.error("启用 macOS accessibility 失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("read-clipboard", async () => {
      try {
        const text = await this.clipboardManager.readClipboard();
        return { success: true, text };
      } catch (error) {
        this.logger.error("读取剪贴板失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("write-clipboard", async (event, text) => {
      try {
        return await this.clipboardManager.writeClipboard(text);
      } catch (error) {
        this.logger.error("写入剪贴板失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-clipboard-history", () => {
      return { success: false, error: "功能暂未实现", items: [] };
    });

    ipcMain.handle("clear-clipboard-history", () => {
      return { success: false, error: "功能暂未实现" };
    });

    // 窗口管理相关
    ipcMain.handle("hide-window", () => {
      if (this.windowManager.mainWindow) {
        this.windowManager.mainWindow.hide();
      }
      return true;
    });

    ipcMain.handle("show-window", () => {
      if (this.windowManager.mainWindow) {
        this.windowManager.mainWindow.show();
      }
      return true;
    });

    ipcMain.handle("minimize-window", () => {
      if (this.windowManager.mainWindow) {
        this.windowManager.mainWindow.minimize();
      }
      return true;
    });

    ipcMain.handle("close-window", () => {
      if (this.windowManager.mainWindow) {
        this.windowManager.mainWindow.close();
      }
      return true;
    });

    ipcMain.handle("show-control-panel", () => {
      this.windowManager.showControlPanel();
      return true;
    });

    ipcMain.handle("hide-control-panel", () => {
      this.windowManager.hideControlPanel();
      return true;
    });

    ipcMain.handle("open-control-panel", () => {
      this.windowManager.showControlPanel();
      return true;
    });

    ipcMain.handle("close-control-panel", () => {
      this.windowManager.hideControlPanel();
      return true;
    });

    ipcMain.handle("open-history-window", () => {
      this.windowManager.showHistoryWindow();
      return true;
    });

    ipcMain.handle("close-history-window", () => {
      this.windowManager.closeHistoryWindow();
      return true;
    });

    ipcMain.handle("hide-history-window", () => {
      this.windowManager.hideHistoryWindow();
      return true;
    });

    ipcMain.handle("open-settings-window", () => {
      this.windowManager.showSettingsWindow();
      return true;
    });

    ipcMain.handle("close-settings-window", () => {
      this.windowManager.closeSettingsWindow();
      return true;
    });

    ipcMain.handle("hide-settings-window", () => {
      this.windowManager.hideSettingsWindow();
      return true;
    });

    ipcMain.handle("close-app", () => {
      require("electron").app.quit();
    });

    // 热键管理 - 添加发送者跟踪机制
    this.hotkeyRegisteredSenders = new Set(); // 跟踪已注册热键的发送者
    
    ipcMain.handle("register-hotkey", (event, hotkey) => {
      try {
        if (this.hotkeyManager) {
          const senderId = event.sender.id;
          
          // 检查是否已经为这个发送者注册过热键
          if (this.hotkeyRegisteredSenders.has(senderId)) {
            this.logger.info(`发送者 ${senderId} 已注册过热键，跳过重复注册`);
            return { success: true };
          }
          
          const success = this.hotkeyManager.registerHotkey(hotkey, () => {
            // 只发送热键触发事件到主窗口，避免重复触发
            this.logger.info(`热键 ${hotkey} 被触发，发送事件到主窗口`);
            if (this.windowManager && this.windowManager.mainWindow && !this.windowManager.mainWindow.isDestroyed()) {
              this.windowManager.mainWindow.webContents.send("hotkey-triggered", { hotkey });
            }
          });
          
          if (success) {
            // 添加发送者到跟踪列表
            this.hotkeyRegisteredSenders.add(senderId);
            
            // 监听窗口关闭事件，清理注册记录
            event.sender.on('destroyed', () => {
              this.hotkeyRegisteredSenders.delete(senderId);
              this.logger.info(`清理发送者 ${senderId} 的热键注册记录`);
            });
            
            this.logger.info(`热键 ${hotkey} 注册成功，发送者: ${senderId}`);
          } else {
            this.logger.error(`热键 ${hotkey} 注册失败`);
          }
          
          return { success };
        }
        return { success: false, error: "热键管理器未初始化" };
      } catch (error) {
        this.logger.error("注册热键失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("unregister-hotkey", (event, hotkey) => {
      try {
        if (this.hotkeyManager) {
          const success = this.hotkeyManager.unregisterHotkey(hotkey);
          return { success };
        }
        return { success: false, error: "热键管理器未初始化" };
      } catch (error) {
        this.logger.error("注销热键失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-current-hotkey", () => {
      try {
        if (this.hotkeyManager) {
          const hotkeys = this.hotkeyManager.getRegisteredHotkeys();
          // 返回第一个非F2的热键，或默认热键
          const mainHotkey = hotkeys.find(key => key !== 'F2') || "CommandOrControl+Shift+Space";
          return mainHotkey;
        }
        return "CommandOrControl+Shift+Space";
      } catch (error) {
        this.logger.error("获取当前热键失败:", error);
        return "CommandOrControl+Shift+Space";
      }
    });

    // F2热键管理
    ipcMain.handle("register-f2-hotkey", (event) => {
      try {
        const senderId = event.sender.id;
        
        // 检查是否已经为这个发送者注册过F2热键
        if (this.f2RegisteredSenders.has(senderId)) {
          this.logger.info(`F2热键已为发送者 ${senderId} 注册过，跳过重复注册`);
          return { success: true };
        }
        
        if (this.hotkeyManager) {
          // 只有在没有任何发送者注册时才注册热键
          const isFirstRegistration = this.f2RegisteredSenders.size === 0;
          
          if (isFirstRegistration) {
            const success = this.hotkeyManager.registerF2DoubleClick((data) => {
              // 发送F2双击事件到所有注册的渲染进程
              this.logger.info("发送F2双击事件到渲染进程:", data);
              this.f2RegisteredSenders.forEach(id => {
                const window = require("electron").BrowserWindow.getAllWindows().find(w => w.webContents.id === id);
                if (window && !window.isDestroyed()) {
                  window.webContents.send("f2-double-click", data);
                }
              });
            });
            
            if (!success) {
              return { success: false, error: "F2热键注册失败" };
            }
          }
          
          // 添加发送者到跟踪列表
          this.f2RegisteredSenders.add(senderId);
          
          // 监听窗口关闭事件，清理注册记录
          event.sender.on('destroyed', () => {
            this.f2RegisteredSenders.delete(senderId);
            this.logger.info(`清理发送者 ${senderId} 的F2热键注册记录`);

            // 如果没有发送者了，注销热键
            if (this.f2RegisteredSenders.size === 0) {
              this.hotkeyManager.unregisterHotkey('F2');
              this.logger.info('所有发送者都已注销，注销F2热键');
            }
          });
          
          return { success: true };
        }
        return { success: false, error: "热键管理器未初始化" };
      } catch (error) {
        this.logger.error("注册F2热键失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("unregister-f2-hotkey", (event) => {
      try {
        const senderId = event.sender.id;
        
        if (this.hotkeyManager && this.f2RegisteredSenders.has(senderId)) {
          this.f2RegisteredSenders.delete(senderId);
          
          // 如果没有其他发送者注册F2热键，则注销热键
          if (this.f2RegisteredSenders.size === 0) {
            const success = this.hotkeyManager.unregisterHotkey('F2');
            this.logger.info('所有发送者都已注销，注销F2热键');
            return { success };
          } else {
            this.logger.info(`发送者 ${senderId} 已注销，但还有其他发送者注册了F2热键`);
            return { success: true };
          }
        }
        return { success: false, error: "热键管理器未初始化或未注册" };
      } catch (error) {
        this.logger.error("注销F2热键失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("set-recording-state", (event, isRecording) => {
      try {
        if (this.hotkeyManager) {
          this.hotkeyManager.setRecordingState(isRecording);
          return { success: true };
        }
        return { success: false, error: "热键管理器未初始化" };
      } catch (error) {
        this.logger.error("设置录音状态失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-recording-state", () => {
      try {
        if (this.hotkeyManager) {
          const isRecording = this.hotkeyManager.getRecordingState();
          return { success: true, isRecording };
        }
        return { success: false, error: "热键管理器未初始化" };
      } catch (error) {
        this.logger.error("获取录音状态失败:", error);
        return { success: false, error: error.message };
      }
    });

    // 文件操作
    ipcMain.handle("export-transcriptions", (event, format) => {
      // 导出全部历史到「下载」目录的 txt 文件
      try {
        const fs = require("fs");
        const path = require("path");
        const rows = this.databaseManager.getTranscriptions(1000000, 0) || [];
        const lines = rows.map((r) => {
          const t = r.created_at || "";
          const text = r.text || r.processed_text || r.raw_text || "";
          return `[${t}] ${text}`;
        });
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        const file = path.join(require("electron").app.getPath("downloads"), `WordTaker_转录导出_${stamp}.txt`);
        fs.writeFileSync(file, lines.join("\n"), "utf8");
        return { success: true, path: file, count: rows.length };
      } catch (error) {
        this.logger.error("导出转录失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("import-settings", () => {
      return { success: false, error: "功能暂未实现" };
    });

    ipcMain.handle("export-settings", () => {
      return { success: false, error: "功能暂未实现" };
    });

    // 文件系统相关：仅允许显示应用数据目录内的文件，拒绝任意路径探测
    ipcMain.handle("show-item-in-folder", (event, fullPath) => {
      try {
        if (typeof fullPath !== "string" || !fullPath) {
          return { success: false, error: "invalid path" };
        }
        const path = require("path");
        const resolved = path.resolve(fullPath);
        const userData = require("electron").app.getPath("userData");
        if (resolved !== userData && !resolved.startsWith(userData + path.sep)) {
          this.logger.warn("show-item-in-folder 拒绝越界路径:", resolved);
          return { success: false, error: "path not allowed" };
        }
        require("electron").shell.showItemInFolder(resolved);
        return { success: true };
      } catch (error) {
        this.logger.error("show-item-in-folder 失败:", error);
        return { success: false, error: error.message };
      }
    });

    // 仅允许打开 http(s) 链接，拒绝 file:/javascript: 等危险协议
    ipcMain.handle("open-external", (event, url) => {
      try {
        const parsed = new URL(String(url));
        if (!["http:", "https:"].includes(parsed.protocol)) {
          this.logger.warn("open-external 拒绝非 http(s) 协议:", parsed.protocol);
          return { success: false, error: "protocol not allowed" };
        }
        require("electron").shell.openExternal(parsed.toString());
        return { success: true };
      } catch (error) {
        this.logger.error("open-external 失败:", error);
        return { success: false, error: error.message };
      }
    });

    // 系统信息
    ipcMain.handle("get-system-info", () => {
      return {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        electronVersion: process.versions.electron
      };
    });

    ipcMain.handle("check-permissions", async () => {
      try {
        // 检查辅助功能权限
        const hasAccessibility = await this.clipboardManager.checkAccessibilityPermissions();
        
        return {
          microphone: true, // 麦克风权限由前端检查
          accessibility: hasAccessibility
        };
      } catch (error) {
        this.logger.error("检查权限失败:", error);
        return {
          microphone: false,
          accessibility: false,
          error: error.message
        };
      }
    });

    ipcMain.handle("request-permissions", async () => {
      try {
        // 对于辅助功能权限，我们只能引导用户手动授予
        // 这里可以打开系统设置页面
        if (process.platform === "darwin") {
          this.clipboardManager.openSystemSettings();
        }
        return { success: true };
      } catch (error) {
        this.logger.error("请求权限失败:", error);
        return { success: false, error: error.message };
      }
    });

    // 测试辅助功能权限
    ipcMain.handle("test-accessibility-permission", async () => {
      try {
        // 使用测试文本检查权限
        await this.clipboardManager.pasteText("WordTaker权限测试");
        return { success: true, message: "辅助功能权限测试成功" };
      } catch (error) {
        this.logger.error("辅助功能权限测试失败:", error);
        return { success: false, error: error.message };
      }
    });

    // 打开系统权限设置
    ipcMain.handle("open-system-permissions", () => {
      try {
        if (process.platform === "darwin") {
          this.clipboardManager.openSystemSettings();
          return { success: true };
        } else {
          return { success: false, error: "当前平台不支持自动打开权限设置" };
        }
      } catch (error) {
        this.logger.error("打开系统权限设置失败:", error);
        return { success: false, error: error.message };
      }
    });

    // 应用信息
    ipcMain.handle("get-app-version", () => {
      return require("electron").app.getVersion();
    });

    ipcMain.handle("get-app-path", (event, name) => {
      if (!ALLOWED_APP_PATHS.has(name)) {
        this.logger.warn("get-app-path 拒绝未授权路径名:", name);
        return null;
      }
      return require("electron").app.getPath(name);
    });

    ipcMain.handle("check-for-updates", () => {
      // TODO: 实现更新检查功能
      return { hasUpdate: false };
    });

    // 调试和日志（level 白名单，防止 this.logger[level] 注入）
    ipcMain.handle("log", (event, level, message, data) => {
      const lvl = VALID_LOG_LEVELS.has(level) ? level : "info";
      this.logger[lvl](`[渲染进程] ${message}`, data || "");
      return true;
    });

    ipcMain.handle("get-debug-info", () => {
      return {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        electronVersion: process.versions.electron,
        appVersion: require("electron").app.getVersion()
      };
    });

    // 保持向后兼容性
    ipcMain.handle("log-message", (event, level, message, data) => {
      const lvl = VALID_LOG_LEVELS.has(level) ? level : "info";
      this.logger[lvl](`[渲染进程] ${message}`, data || "");
      return true;
    });

    // 中文特定功能
    ipcMain.handle("detect-language", (event, text) => {
      // TODO: 实现语言检测功能
      return { language: "zh-CN", confidence: 0.95 };
    });

    ipcMain.handle("segment-chinese", (event, text) => {
      // TODO: 实现中文分词功能
      return { segments: text.split("") };
    });

    ipcMain.handle("add-punctuation", (event, text) => {
      // TODO: 实现标点符号添加功能
      return { text: text };
    });

    // 音频处理
    ipcMain.handle("convert-audio-format", (event, audioData, targetFormat) => {
      // TODO: 实现音频格式转换功能
      return { success: true, data: audioData };
    });

    ipcMain.handle("enhance-audio", (event, audioData) => {
      // TODO: 实现音频增强功能
      return { success: true, data: audioData };
    });

    // 模型管理 - 更新为实际功能
    ipcMain.handle("download-model", async (event, modelName) => {
      // 使用统一的模型下载功能
      return await this.funasrManager.downloadModels((progress) => {
        event.sender.send("model-download-progress", progress);
      });
    });

    ipcMain.handle("get-available-models", () => {
      // 返回FunASR支持的模型列表
      return {
        models: [
          {
            name: "paraformer-large",
            displayName: "Paraformer Large (ASR)",
            type: "asr",
            size: "840MB",
            description: "大型中文语音识别模型"
          },
          {
            name: "fsmn-vad",
            displayName: "FSMN VAD",
            type: "vad",
            size: "1.6MB",
            description: "语音活动检测模型"
          },
          {
            name: "ct-transformer-punc",
            displayName: "CT Transformer (标点)",
            type: "punc",
            size: "278MB",
            description: "标点符号恢复模型"
          }
        ]
      };
    });

    ipcMain.handle("get-current-model", async () => {
      const status = await this.funasrManager.checkStatus();
      return {
        model: "paraformer-large",
        status: status.models_downloaded ? "ready" : "not_downloaded",
        details: status
      };
    });

    ipcMain.handle("switch-model", (event, modelName) => {
      // FunASR目前使用固定模型组合，暂不支持切换
      return {
        success: false,
        error: "FunASR使用固定模型组合，暂不支持切换单个模型"
      };
    });

    // 性能监控
    ipcMain.handle("get-performance-stats", () => {
      // TODO: 实现性能统计功能
      return { stats: {} };
    });

    ipcMain.handle("clear-performance-stats", () => {
      // TODO: 实现清除性能统计功能
      return { success: true };
    });

    // 错误报告
    ipcMain.handle("report-error", (event, error) => {
      this.logger.error("渲染进程错误:", error);
      // TODO: 实现错误报告功能
      return true;
    });

    // 开发工具
    if (process.env.NODE_ENV === "development") {
      ipcMain.handle("open-dev-tools", (event) => {
        const window = require("electron").BrowserWindow.fromWebContents(event.sender);
        if (window) {
          window.webContents.openDevTools();
        }
      });

      ipcMain.handle("reload-window", (event) => {
        const window = require("electron").BrowserWindow.fromWebContents(event.sender);
        if (window) {
          window.reload();
        }
      });
    }

    // 日志和调试相关
    ipcMain.handle("get-app-logs", (event, lines = 100) => {
      try {
        if (this.logger && this.logger.getRecentLogs) {
          return {
            success: true,
            logs: this.logger.getRecentLogs(lines)
          };
        }
        return {
          success: false,
          error: "日志管理器不可用"
        };
      } catch (error) {
        this.logger.error("获取应用日志失败:", error);
        return {
          success: false,
          error: error.message
        };
      }
    });

    ipcMain.handle("get-funasr-logs", (event, lines = 100) => {
      try {
        if (this.logger && this.logger.getFunASRLogs) {
          return {
            success: true,
            logs: this.logger.getFunASRLogs(lines)
          };
        }
        return {
          success: false,
          error: "日志管理器不可用"
        };
      } catch (error) {
        this.logger.error("获取FunASR日志失败:", error);
        return {
          success: false,
          error: error.message
        };
      }
    });

    ipcMain.handle("get-log-file-path", () => {
      try {
        if (this.logger && this.logger.getLogFilePath) {
          return {
            success: true,
            appLogPath: this.logger.getLogFilePath(),
            funasrLogPath: this.logger.getFunASRLogFilePath()
          };
        }
        return {
          success: false,
          error: "日志管理器不可用"
        };
      } catch (error) {
        this.logger.error("获取日志文件路径失败:", error);
        return {
          success: false,
          error: error.message
        };
      }
    });

    ipcMain.handle("open-log-file", (event, logType = 'app') => {
      try {
        if (this.logger) {
          const logPath = logType === 'funasr'
            ? this.logger.getFunASRLogFilePath()
            : this.logger.getLogFilePath();
          
          require("electron").shell.showItemInFolder(logPath);
          return { success: true };
        }
        return {
          success: false,
          error: "日志管理器不可用"
        };
      } catch (error) {
        this.logger.error("打开日志文件失败:", error);
        return {
          success: false,
          error: error.message
        };
      }
    });

    ipcMain.handle("get-system-debug-info", () => {
      try {
        const debugInfo = {
          system: {
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
            electronVersion: process.versions.electron,
            appVersion: require("electron").app.getVersion()
          },
          environment: {
            NODE_ENV: process.env.NODE_ENV,
            PATH: process.env.PATH,
            PYTHON_PATH: process.env.PYTHON_PATH,
            AI_API_KEY: '通过控制面板设置',
            AI_BASE_URL: '通过控制面板设置',
            AI_MODEL: '通过控制面板设置'
          },
          funasrStatus: {
            isInitialized: this.funasrManager.isInitialized,
            modelsInitialized: this.funasrManager.modelsInitialized,
            serverReady: this.funasrManager.serverReady,
            pythonCmd: this.funasrManager.pythonCmd
          }
        };

        if (this.logger && this.logger.getSystemInfo) {
          debugInfo.loggerInfo = this.logger.getSystemInfo();
        }

        return {
          success: true,
          debugInfo
        };
      } catch (error) {
        this.logger.error("获取系统调试信息失败:", error);
        return {
          success: false,
          error: error.message
        };
      }
    });

    ipcMain.handle("test-python-environment", async () => {
      try {
        this.logger && this.logger.info && this.logger.info('开始测试Python环境');
        
        const pythonCmd = await this.funasrManager.findPythonExecutable();
        const funasrStatus = await this.funasrManager.checkFunASRInstallation();
        
        const testResult = {
          success: true,
          pythonCmd,
          funasrStatus,
          timestamp: new Date().toISOString()
        };

        this.logger && this.logger.info && this.logger.info('Python环境测试完成', testResult);
        
        return testResult;
      } catch (error) {
        const errorResult = {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        };

        this.logger && this.logger.error && this.logger.error('Python环境测试失败', errorResult);
        
        return errorResult;
      }
    });

    ipcMain.handle("restart-funasr-server", async () => {
      try {
        this.logger && this.logger.info && this.logger.info('手动重启FunASR服务器');
        
        // 使用新的restartServer方法
        const result = await this.funasrManager.restartServer();
        
        return result;
      } catch (error) {
        this.logger && this.logger.error && this.logger.error('重启FunASR服务器失败', error);
        return {
          success: false,
          error: error.message
        };
      }
    });
  }

  // AI文本处理方法
  // 通过自建中转 (Cloudflare Worker) 做文案润色：只发送 { text, mode }，
  // 真实 DeepSeek key 永远不出现在客户端。
  removeAllHandlers() {
    ipcMain.removeAllListeners();
  }
}

module.exports = IPCHandlers;