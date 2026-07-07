const { ipcMain } = require("electron");
const AiService = require("./aiService");

// 已停用 IPC 硬超时兜底：长语音转写润色可能耗时较久，硬超时会把长文本的润色请求
// 提前中断并回退直贴原文（已确诊 BUG）。按用户要求去除该时间兜底，直接 await
// aiService 结果，仅用 try/catch 处理真实错误。

// 设置键白名单：渲染层只能写入这些键，杜绝写入 __proto__ 等任意键
const ALLOWED_SETTING_KEYS = new Set([
  "ai_api_key", "ai_base_url", "ai_model", "enable_ai_optimization",
  "copywriting_mode_enabled", "llm_prompt_template", "llm_temperature",
  "llm_max_tokens", "llm_extra_body", "llm_fallback_paste_raw",
  "recording_trigger", "cancel_key", "cancel_taps",
  "sound_scheme", "sound_volume",
  "asr_engine", "skip_polish_max_chars",
  // 润色引擎：cloud / local-4b（互不兜底）
  "polish_engine",
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
  // 托盘图标样式（'smile' 中笑模板，默认 | 'color' 彩色猫头）
  "tray_icon_style",
  // 开机启动（布尔；主进程侧强制 boolean）
  "launch_at_login",
  // 词转词规则 JSON 字符串数组 [{from,to}]，AI 处理时自动替换
  "wtw_rules_json",
  // 首启引导标志：安装后首启自动弹「权限」页一次后置 true（主进程写入）
  "onboarding_completed",
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
    this.llmManager = managers.llmManager;
    this.windowManager = managers.windowManager;
    this.hotkeyManager = managers.hotkeyManager;
    this.aiService = new AiService({
      databaseManager: managers.databaseManager,
      logger: managers.logger,
      llmManager: managers.llmManager,
    });
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
      // IPC 是信任边界：自校验入参，避免 text 为空导致下游抛错或浪费请求。
      // 不再做长度上限拦截：任意长度文本都允许送去润色（去除长文本被截断/直贴原文的限制）。
      if (typeof text !== 'string' || !text.trim()) {
        return { success: false, error: '无有效文本' };
      }
      // 润色模式（copywriting）按当前「角色」解析：normal→normal / gaoeq→gaoeq / vibecoding→copywriting。
      // 其它模式（如 optimize）保持原样透传。
      const effectiveMode = mode === 'copywriting' ? await this.aiService.getPolishMode() : mode;
      // 已去除硬超时兜底：直接 await 润色结果，长文本不再被时间兜底中断。
      try {
        return await this.aiService.processTextWithAI(text, effectiveMode);
      } catch (error) {
        this.logger.error("process-text 处理失败:", error?.message || error);
        return { success: false, error: error?.message || '处理失败' };
      }
    });

    ipcMain.handle("check-ai-status", async (event, testConfig = null) => {
      return await this.aiService.checkAIStatus(testConfig);
    });

    // ——— 润色引擎（cloud / local-4b，互不兜底）———

    // 取当前润色引擎（默认 cloud）
    ipcMain.handle("get-polish-engine", async () => {
      try {
        return await this.databaseManager.getSetting("polish_engine", "cloud");
      } catch (error) {
        this.logger.error("读取润色引擎失败:", error);
        return "cloud";
      }
    });

    // 设置润色引擎；本地引擎立即触发预加载/切换（不阻塞返回）
    ipcMain.handle("set-polish-engine", async (event, engine) => {
      const VALID = new Set(["cloud", "local-4b"]);
      if (!VALID.has(engine)) {
        return { success: false, error: "无效的润色引擎" };
      }
      const r = this.databaseManager.setSetting("polish_engine", engine);
      // 本地引擎且模型就绪：后台切换/预热，即时生效（不等待）
      if (engine.startsWith("local-") && this.llmManager && this.llmManager.isModelReady(engine)) {
        this.llmManager.ensureEngine(engine).catch((e) =>
          this.logger.warn("切换本地引擎预热失败:", e?.message || e)
        );
      }
      return { success: !!(r && r.success !== false), engine };
    });

    // 查询各本地模型下载/就绪状态
    ipcMain.handle("get-local-models-status", () => {
      try {
        if (!this.llmManager) return {};
        return this.llmManager.getModelsStatus();
      } catch (error) {
        this.logger.error("查询本地模型状态失败:", error);
        return {};
      }
    });

    // 触发本地模型下载（带进度事件 local-model-download-progress）
    ipcMain.handle("download-local-model", async (event, engine) => {
      try {
        if (!this.llmManager) return { success: false, error: "本地 LLM 不可用" };
        return await this.llmManager.downloadModel(engine, (progress) => {
          try { event.sender.send("local-model-download-progress", progress); } catch (e) {}
        });
      } catch (error) {
        this.logger.error("下载本地模型失败:", error);
        return { success: false, error: error?.message || "下载失败" };
      }
    });

    // 录音开始时预热 LLM 连接（fire-and-forget，失败无妨）
    ipcMain.handle("prewarm-llm", () => {
      this.aiService.prewarm();
      return { success: true };
    });

    // 流式润色 + 增量上屏：边收边贴到光标处。返回 { success, text, pastedAny }
    ipcMain.handle("process-text-stream", async (event, text) => {
      if (typeof text !== "string" || !text.trim()) return { success: false, error: "无有效文本", pastedAny: false };
      // 不再做长度上限拦截：任意长度文本都允许走流式润色。
      // 流式上屏受设置开关控制（防御性）：llm_streaming_enabled 为 false 时返回明确的
      // streaming-unavailable。正常情况下渲染层关闭开关时也不会调用本 handler。
      const streamingEnabled = await this.databaseManager.getSetting("llm_streaming_enabled", false);
      if (!streamingEnabled) {
        const reason = "流式上屏未开启：请在设置中开启「流式上屏」后再使用。";
        this.logger.warn("流式上屏不可用:", reason);
        return { success: false, error: reason, code: "streaming-unavailable", pastedAny: false };
      }
      // 引擎路由：cloud 需 relay 配置；local-* 走本地模型，不需要 relay。
      const polishEngine = await this.databaseManager.getSetting("polish_engine", "cloud");
      let relayUrl = "";
      if (polishEngine === "cloud") {
        const relayEnabled = await this.databaseManager.getSetting("llm_relay_enabled", false);
        relayUrl = await this.databaseManager.getSetting("llm_relay_url", "");
        if (!relayEnabled || !relayUrl) {
          // 不是静默 no-op：返回明确的、可被渲染层展示的原因（STREAM-1）。
          const reason = "流式上屏需要配置中转（relay）：请在设置中开启中转并填写中转地址后再使用。";
          this.logger.warn("流式上屏不可用:", reason);
          return { success: false, error: reason, code: "streaming-unavailable", pastedAny: false };
        }
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
      // 契约 A：润色进度累计已生成字符数（已收到全部增量的字符长度）。
      let polishedCharCount = 0;
      // 进入流式前广播 start
      try { event.sender.send("polish-progress", { status: "start", charCount: 0 }); } catch (e) { /* 渲染层不可用时忽略 */ }
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
        // 契约 A：累计已生成字符数 = 已收到全部增量的字符长度。
        polishedCharCount += [...d].length;
        try { event.sender.send("polish-progress", { status: "delta", charCount: polishedCharCount, chunk: d }); } catch (e) { /* 渲染层不可用时忽略 */ }
        const len = [...buffer].length;
        if (!firstFlushDone) {
          if (len >= FIRST_FLUSH_CHARS) { flush(); firstFlushDone = true; }
          return; // 首块只按字数触发，忽略句末标点
        }
        if (len >= STREAM_FLUSH_MIN_CHARS || SENTENCE_BOUNDARY.test(d)) flush();
      };

      // 润色模式按当前「角色」决定：normal→normal / gaoeq→gaoeq / vibecoding→copywriting
      const polishMode = await this.aiService.getPolishMode();
      // 已去除硬超时兜底：直接 await 流式润色结果，长文本不再被时间兜底中断。
      // 真实错误（网络/中转失败等）仍会收尾贴出已攒缓冲并恢复剪贴板。
      let result;
      try {
        result = await this.aiService.processTextStreamRouted(text, polishMode, relayUrl, onDelta);
      } catch (error) {
        this.logger.error("process-text-stream 处理失败:", error?.message || error);
        // 出错也要收尾：贴出已攒缓冲并恢复剪贴板，避免残留状态。
        try {
          flush(true);
          await this.clipboardManager.appendChunk("");
        } catch (e) {
          this.logger.error("流式出错收尾失败:", e?.message || String(e));
        }
        let keepResultOnError = false;
        try {
          keepResultOnError = await this.databaseManager.getSetting("keep_result_in_clipboard", false);
        } catch (e) {
          keepResultOnError = false;
        }
        if (!keepResultOnError) {
          setTimeout(() => this.clipboardManager.restoreClipboard(original), 500);
        }
        try { event.sender.send("polish-progress", { status: "done", charCount: polishedCharCount }); } catch (e) { /* 渲染层不可用时忽略 */ }
        return { success: false, error: error?.message || '处理失败', pastedAny };
      }
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
      } else {
        // 开启「保留结果到剪贴板」时：流式增量粘贴的最后一次 appendChunk 只把「最后一段 chunk」
        // 留在了剪贴板，而不是完整润色全文。这里在所有增量粘贴完成后，用完整全文覆盖剪贴板，
        // 保证无论是否流式上屏，剪贴板里都是完整的润色结果（而非最后一段）。
        // 稍等再写，避免抢在最后一次 Cmd+V 之前污染其正在消费的粘贴内容。
        const fullText = result.text || "";
        if (fullText) {
          setTimeout(() => {
            this.clipboardManager.writeClipboard(fullText).catch((e) =>
              this.logger.warn("保留完整润色结果到剪贴板失败:", e?.message || e)
            );
          }, 500);
        }
      }

      // 契约 A：收尾广播 done（最终字符数）。
      try { event.sender.send("polish-progress", { status: "done", charCount: polishedCharCount }); } catch (e) { /* 渲染层不可用时忽略 */ }

      if (flushError) {
        return { success: false, error: flushError, text: result.text || "", pastedAny };
      }
      return { success: !!result.success, text: result.text || "", error: result.error, reason: result.reason, pastedAny };
    });

    // 契约 C：内存信息（用 Node os 模块返回空闲/总内存字节数）。
    ipcMain.handle("get-memory-info", () => {
      const os = require("os");
      return { freeBytes: os.freemem(), totalBytes: os.totalmem() };
    });

    // 系统通知：胶囊窗口透明且仅 88px，无法承载 toast，改由主进程弹系统通知
    // （用于「录音内存感知自动停止」等需用户可见的提示）。
    ipcMain.handle("show-notification", (event, payload) => {
      try {
        const { Notification } = require("electron");
        if (!Notification || !Notification.isSupported()) return { success: false };
        const title = (payload && payload.title) || "弦外小猫";
        const body = (payload && payload.body) || "";
        new Notification({ title, body, silent: false }).show();
        return { success: true };
      } catch (e) {
        this.logger.warn && this.logger.warn("show-notification 失败:", e?.message || e);
        return { success: false };
      }
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
      // 开机启动只允许布尔值（IPC 入参主进程侧校验）
      if (key === "launch_at_login") value = value === true;
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

    // 仅允许打开 http(s) 链接，且域名限白名单（支付宝收银台 / look3.cn），拒绝其他目标
    ipcMain.handle("open-external", (event, url) => {
      try {
        const parsed = new URL(String(url));
        if (!["http:", "https:"].includes(parsed.protocol)) {
          this.logger.warn("open-external 拒绝非 http(s) 协议:", parsed.protocol);
          return { success: false, error: "protocol not allowed" };
        }
        const host = parsed.hostname.toLowerCase();
        const hostAllowed =
          host === "look3.cn" ||
          host.endsWith(".look3.cn") ||
          host === "openapi.alipay.com" ||
          host.endsWith(".alipay.com");
        if (!hostAllowed) {
          this.logger.warn("open-external 拒绝非白名单域名:", host);
          return { success: false, error: "host not allowed" };
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

    // 应用内更新（免签名）：查版本清单 → semver 比对 → 下载 dmg → 打开引导安装。
    const updater = require("./updater");

    // 兼容旧调用名：check-for-updates 与新名 check-for-update 行为一致。
    const doCheckForUpdate = () => updater.checkForUpdate({ logger: this.logger });
    ipcMain.handle("check-for-updates", doCheckForUpdate);
    ipcMain.handle("check-for-update", doCheckForUpdate);

    // 触发下载并打开 dmg；进度经 update-download-progress 事件回渲染层。
    ipcMain.handle("download-update", async (event, url) => {
      try {
        if (typeof url !== "string" || !url.trim()) {
          return { success: false, error: "缺少更新下载地址" };
        }
        const sender = event.sender;
        const result = await updater.downloadAndOpen(
          url.trim(),
          (p) => {
            try {
              if (sender && !sender.isDestroyed()) {
                sender.send("update-download-progress", p);
              }
            } catch (_) {
              /* 忽略进度发送失败 */
            }
          },
          { logger: this.logger }
        );
        return result;
      } catch (error) {
        this.logger.warn &&
          this.logger.warn("download-update 失败:", error?.message || error);
        return { success: false, error: error?.message || "下载更新失败" };
      }
    });

    // ——— 收费后端：云端额度查询（匿名 deviceId 可用）———
    ipcMain.handle("get-cloud-quota", async () => {
      try {
        const backendClient = require("./backendClient");
        const q = await backendClient.getQuota();
        return { success: true, ...q };
      } catch (error) {
        this.logger.warn("查询云端额度失败:", error?.message || error);
        return {
          success: false,
          error: error?.message || "查询云端额度失败",
          kind: error?.kind,
          code: error?.code,
        };
      }
    });

    // ——— CP3 会员/计费：套餐列表 / 下单 / dev 直付 / 兑换码 ———
    this.setupBillingHandlers();

    // ——— CP2 登录闭环：手机验证码 / 邮箱验证码 / 微信(mock) ———
    this.setupAuthHandlers();

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

  // ——— CP3 会员/计费 IPC：套餐 / 下单 / dev 直付 / 兑换码 ———
  // 购买/兑换改额度的操作需登录（Bearer）；device+Bearer 头由 backendClient 统一注入。
  // 后端结构化错误统一映射为 { success:false, error, kind, code }。
  setupBillingHandlers() {
    const backendClient = require("./backendClient");
    const tokenStore = require("./tokenStore");

    const failFromError = (error, fallbackMsg) => ({
      success: false,
      error: error?.message || fallbackMsg,
      kind: error?.kind,
      code: error?.code,
    });
    const requireLogin = () => !!tokenStore.getAccessToken();

    // 套餐列表（公开，无需登录）
    ipcMain.handle("list-plans", async () => {
      try {
        const plans = await backendClient.listPlans();
        return { success: true, plans };
      } catch (error) {
        this.logger.warn("查询套餐失败:", error?.message || error);
        return failFromError(error, "查询套餐失败");
      }
    });

    // 下单（需登录）
    ipcMain.handle("create-order", async (event, planCode, channel) => {
      if (typeof planCode !== "string" || !planCode.trim()) {
        return { success: false, error: "无效的套餐", code: "INVALID_PLAN" };
      }
      const ch = channel === "alipay" ? "alipay" : "wechat";
      if (!requireLogin()) {
        return { success: false, error: "请先登录后再购买", code: "UNAUTHORIZED" };
      }
      try {
        const order = await backendClient.createOrder(planCode.trim(), ch);
        return { success: true, order };
      } catch (error) {
        this.logger.warn("创建订单失败:", error?.message || error);
        return failFromError(error, "创建订单失败");
      }
    });

    // dev 直付（需登录）
    ipcMain.handle("mock-pay", async (event, orderId) => {
      if (orderId == null || String(orderId).trim() === "") {
        return { success: false, error: "无效的订单", code: "INVALID_ORDER" };
      }
      if (!requireLogin()) {
        return { success: false, error: "请先登录", code: "UNAUTHORIZED" };
      }
      try {
        const result = await backendClient.mockPay(String(orderId));
        return { success: true, ...result };
      } catch (error) {
        this.logger.warn("模拟支付失败:", error?.message || error);
        return failFromError(error, "支付失败");
      }
    });

    // 兑换码（需登录）
    ipcMain.handle("redeem-code", async (event, code) => {
      if (typeof code !== "string" || !code.trim()) {
        return { success: false, error: "请输入兑换码", code: "INVALID_CODE" };
      }
      if (!requireLogin()) {
        return { success: false, error: "请先登录后再兑换", code: "UNAUTHORIZED" };
      }
      try {
        const data = await backendClient.redeem(code.trim());
        return {
          success: true,
          charAmount: data.charAmount ?? null,
          cloudRemaining: data.cloudRemaining ?? null,
        };
      } catch (error) {
        this.logger.warn("兑换码兑换失败:", error?.message || error);
        return failFromError(error, "兑换失败");
      }
    });
  }

  // ——— CP2 登录 IPC：接线 backendClient + tokenStore ———
  // 主进程持有 JWT/deviceId 并注入请求头；渲染层只经白名单 IPC 触发，不直接持有密钥。
  setupAuthHandlers() {
    const backendClient = require("./backendClient");
    const tokenStore = require("./tokenStore");

    // 手机号 / 邮箱轻校验（IPC 是信任边界，先在主进程侧拦明显非法值）。
    const isValidPhone = (p) => typeof p === "string" && /^1[3-9]\d{9}$/.test(p.trim());
    const isValidEmail = (e) =>
      typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
    const isValidCode = (c) => typeof c === "string" && /^\d{4,8}$/.test(c.trim());

    // 把后端结构化错误映射为渲染层友好的 { success:false, error, kind, code }。
    const failFromError = (error, fallbackMsg) => ({
      success: false,
      error: error?.message || fallbackMsg,
      kind: error?.kind,
      code: error?.code,
    });

    // 登录成功统一收尾：写 tokenStore（token + 账号摘要），返回登录态。
    const persistLogin = (data) => {
      const account = (data && data.account) || null;
      tokenStore.set({ accessToken: data.accessToken, account });
      return {
        success: true,
        loggedIn: true,
        account,
        isNew: !!(data && data.isNew),
        cloudRemaining: (data && data.cloudRemaining) ?? null,
      };
    };

    // 发码：手机
    ipcMain.handle("auth-sms-send", async (event, phone) => {
      if (!isValidPhone(phone)) {
        return { success: false, error: "手机号格式不正确", code: "INVALID_PHONE" };
      }
      try {
        await backendClient.authSmsSend(phone.trim());
        return { success: true };
      } catch (error) {
        this.logger.warn("发送短信验证码失败:", error?.message || error);
        return failFromError(error, "发送验证码失败");
      }
    });

    // 登录：手机 + 验证码
    ipcMain.handle("auth-sms-login", async (event, phone, code, inviteCode) => {
      if (!isValidPhone(phone)) {
        return { success: false, error: "手机号格式不正确", code: "INVALID_PHONE" };
      }
      if (!isValidCode(code)) {
        return { success: false, error: "验证码格式不正确", code: "INVALID_CODE" };
      }
      try {
        const json = await backendClient.authSmsLogin(
          phone.trim(),
          code.trim(),
          typeof inviteCode === "string" ? inviteCode.trim() : undefined
        );
        const data = (json && json.data) || {};
        if (!data.accessToken) return { success: false, error: "登录失败：无 token" };
        return persistLogin(data);
      } catch (error) {
        this.logger.warn("手机验证码登录失败:", error?.message || error);
        return failFromError(error, "登录失败");
      }
    });

    // 发码：邮箱
    ipcMain.handle("auth-email-send", async (event, email) => {
      if (!isValidEmail(email)) {
        return { success: false, error: "邮箱格式不正确", code: "INVALID_EMAIL" };
      }
      try {
        await backendClient.authEmailSend(email.trim());
        return { success: true };
      } catch (error) {
        this.logger.warn("发送邮箱验证码失败:", error?.message || error);
        return failFromError(error, "发送验证码失败");
      }
    });

    // 登录：邮箱 + 验证码
    ipcMain.handle("auth-email-login", async (event, email, code, inviteCode) => {
      if (!isValidEmail(email)) {
        return { success: false, error: "邮箱格式不正确", code: "INVALID_EMAIL" };
      }
      if (!isValidCode(code)) {
        return { success: false, error: "验证码格式不正确", code: "INVALID_CODE" };
      }
      try {
        const json = await backendClient.authEmailLogin(
          email.trim(),
          code.trim(),
          typeof inviteCode === "string" ? inviteCode.trim() : undefined
        );
        const data = (json && json.data) || {};
        if (!data.accessToken) return { success: false, error: "登录失败：无 token" };
        return persistLogin(data);
      } catch (error) {
        this.logger.warn("邮箱验证码登录失败:", error?.message || error);
        return failFromError(error, "登录失败");
      }
    });

    // 登录：微信（应用内弹窗承载官方 qrconnect 页 + 拦截回调 code）
    // 编排：取授权 URL(含 redirect_uri+state) → 开内嵌窗打开官方页
    //   → 拦截回调（阻止真正载入，避免 code 被消耗）→ 校验 state → 换取 JWT。
    ipcMain.handle("auth-wechat-login", async (event, inviteCode) => {
      const invite = typeof inviteCode === "string" ? inviteCode.trim() : undefined;
      const WECHAT_TIMEOUT_MS = 180000;
      const { BrowserWindow } = require("electron");

      let step;
      try {
        step = await backendClient.getWechatAuthUrl();
      } catch (error) {
        this.logger.warn("获取微信授权链接失败:", error?.message || error);
        return failFromError(error, "微信登录失败");
      }
      const authUrl = step && step.url;
      const expectedState = step && step.state;
      if (!authUrl) return { success: false, error: "微信登录失败：无授权链接" };

      // 以授权 URL 里真实的 redirect_uri 为回调拦截前缀（兼容 dev/prod）。
      let redirectPrefix;
      try {
        const ru = new URL(authUrl).searchParams.get("redirect_uri");
        redirectPrefix = ru ? decodeURIComponent(ru) : null;
      } catch (_) {
        redirectPrefix = null;
      }
      if (!redirectPrefix) return { success: false, error: "微信登录失败：无回调地址" };

      const parent = this.windowManager && this.windowManager.mainWindow;
      const win = new BrowserWindow({
        width: 400,
        height: 600,
        parent: parent && !parent.isDestroyed() ? parent : undefined,
        modal: false,
        title: "微信登录",
        center: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        backgroundColor: "#ffffff",
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      // 就绪后再显示，避免加载时白屏闪烁。
      win.webContents.once("ready-to-show", () => {
        if (!win.isDestroyed()) win.show();
      });

      // 用 Promise 收敛所有出口（拦截成功 / 用户关窗 / 超时 / 异常），
      // 并在 finally 统一清理监听器与窗口，防泄漏。
      const result = await new Promise((resolve) => {
        let settled = false;
        let timer = null;

        const cleanup = () => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          try {
            win.webContents.removeListener("will-redirect", onNavigate);
            win.webContents.removeListener("will-navigate", onNavigate);
            win.webContents.removeListener("did-fail-load", onFailLoad);
            win.webContents.removeListener("did-finish-load", onFinishLoad);
            win.removeListener("closed", onClosed);
          } catch (_) {}
          if (!win.isDestroyed()) win.close();
        };

        const finish = (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const onNavigate = (evt, targetUrl) => {
          if (typeof targetUrl !== "string" || !targetUrl.startsWith(redirectPrefix)) return;
          // 阻止真正载入后端 GET，避免一次性 code 被消耗。
          evt.preventDefault();
          let code, state;
          try {
            const q = new URL(targetUrl).searchParams;
            code = q.get("code");
            state = q.get("state");
          } catch (_) {}
          if (expectedState && state !== expectedState) {
            finish({ success: false, error: "微信登录失败：状态校验不通过" });
            return;
          }
          if (!code) {
            finish({ success: false, error: "微信登录失败：未获取到授权码" });
            return;
          }
          finish({ __code: code });
        };

        const onClosed = () => {
          if (settled) return;
          settled = true;
          resolve({ success: false, error: "已取消微信登录" });
        };

        // 内联友好页（居中、简洁），仅用于展示，点关闭=取消登录。
        const friendlyPage = (title, message) => {
          const esc = (s) =>
            String(s == null ? "" : s)
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;");
          const html =
            '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            "<style>html,body{height:100%;margin:0}" +
            "body{display:flex;align-items:center;justify-content:center;" +
            "font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',sans-serif;" +
            "background:#fff;color:#333}" +
            ".box{max-width:300px;text-align:center;padding:24px}" +
            ".t{font-size:16px;font-weight:600;margin-bottom:10px}" +
            ".m{font-size:13px;line-height:1.6;color:#666;margin-bottom:22px}" +
            ".btn{appearance:none;border:none;border-radius:8px;background:#07c160;" +
            "color:#fff;font-size:14px;padding:9px 26px;cursor:pointer}" +
            ".btn:hover{background:#06ad56}</style></head><body>" +
            '<div class="box"><div class="t">' +
            esc(title) +
            '</div><div class="m">' +
            esc(message) +
            '</div><button class="btn" onclick="window.close()">关闭</button></div>' +
            "</body></html>";
          return "data:text/html;charset=utf-8," + encodeURIComponent(html);
        };

        // 网络失败友好页（忽略主动取消 -3）。不影响正常拦截流程。
        const onFailLoad = (evt, errorCode, _errorDesc, _validatedURL, isMainFrame) => {
          try {
            if (settled) return;
            if (!isMainFrame) return;
            if (errorCode === -3) return; // ERR_ABORTED：多为拦截时的主动取消
            if (win.isDestroyed()) return;
            win.loadURL(
              friendlyPage("无法连接微信服务器", "请检查网络后重试")
            ).catch(() => {});
          } catch (_) {}
        };

        // 微信报错友好化（保守白名单，防误伤正常扫码页）。
        const WECHAT_ERROR_PHRASES = [
          "Scope 参数错误",
          "没有 Scope 权限",
          "redirect_uri 参数错误",
          "appid 参数错误",
          "该链接无法访问",
          "无法访问",
        ];
        const onFinishLoad = () => {
          try {
            if (settled) return;
            if (win.isDestroyed()) return;
            let cur = "";
            try {
              cur = win.webContents.getURL() || "";
            } catch (_) {}
            // 已跳到 redirect_uri（回调）时不处理，交给拦截逻辑。
            if (redirectPrefix && cur.startsWith(redirectPrefix)) return;
            win.webContents
              .executeJavaScript("document.body.innerText")
              .then((text) => {
                try {
                  if (settled) return;
                  if (win.isDestroyed()) return;
                  const body = typeof text === "string" ? text : "";
                  if (!body) return;
                  const hit = WECHAT_ERROR_PHRASES.find((p) => body.includes(p));
                  if (!hit) return;
                  const snippet = body.trim().slice(0, 60);
                  win.loadURL(
                    friendlyPage("微信登录暂不可用", snippet || hit)
                  ).catch(() => {});
                } catch (_) {}
              })
              .catch(() => {});
          } catch (_) {}
        };

        timer = setTimeout(() => finish({ success: false, error: "微信登录超时" }), WECHAT_TIMEOUT_MS);

        win.webContents.on("will-redirect", onNavigate);
        win.webContents.on("will-navigate", onNavigate);
        win.webContents.on("did-fail-load", onFailLoad);
        win.webContents.on("did-finish-load", onFinishLoad);
        win.on("closed", onClosed);
        win.loadURL(authUrl).catch((err) => {
          finish({ success: false, error: err?.message || "微信登录失败：页面加载失败" });
        });
      });

      // 未拿到 code 的各类出口，直接返回其失败结构。
      if (!result || !result.__code) return result;

      try {
        const json = await backendClient.authWechatLogin(result.__code, invite);
        const data = (json && json.data) || {};
        if (!data.accessToken) return { success: false, error: "微信登录失败：无 token" };
        return persistLogin(data);
      } catch (error) {
        this.logger.warn("微信登录失败:", error?.message || error);
        return failFromError(error, "微信登录失败");
      }
    });

    // 拉取当前账号（校验 token 有效 + 刷新账号摘要）
    ipcMain.handle("auth-me", async () => {
      try {
        const json = await backendClient.authMe();
        const d = (json && json.data) || {};
        // auth/me 的 data 形如 { account, cloudRemaining, subscription }；
        // 兼容后端直接返回账号对象的情况（无 data.account 时回退 data 本身）。
        const account = d.account || (json && json.data) || null;
        // 刷新本地账号摘要（token 不变）
        const t = tokenStore.get();
        if (t && account) tokenStore.set({ accessToken: t.accessToken, account });
        return {
          success: true,
          account,
          cloudRemaining: d.cloudRemaining ?? null,
          subscription: d.subscription ?? null,
        };
      } catch (error) {
        // 401 视为登录态失效：清除本地 token
        if (error && error.status === 401) {
          tokenStore.clear();
          return { success: false, error: "登录已失效", code: "UNAUTHORIZED", loggedIn: false };
        }
        return failFromError(error, "获取账号失败");
      }
    });

    // 退出登录：清除本地 token
    ipcMain.handle("auth-logout", async () => {
      try {
        tokenStore.clear();
        return { success: true };
      } catch (error) {
        return { success: false, error: error?.message || "退出登录失败" };
      }
    });

    // 启动/初始化时查询登录态（读本地 tokenStore，不打网络）
    ipcMain.handle("get-auth-state", async () => {
      try {
        const t = tokenStore.get();
        return { success: true, loggedIn: !!t, account: (t && t.account) || null };
      } catch (error) {
        return { success: false, loggedIn: false, account: null };
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