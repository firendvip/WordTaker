const { contextBridge, ipcRenderer } = require("electron");

// 暴露安全的API给渲染进程
contextBridge.exposeInMainWorld("electronAPI", {
  // 窗口控制
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  showWindow: () => ipcRenderer.invoke("show-window"),
  minimizeWindow: () => ipcRenderer.invoke("minimize-window"),
  closeWindow: () => ipcRenderer.invoke("close-window"),

  // 录音相关
  startRecording: () => ipcRenderer.invoke("start-recording"),
  stopRecording: () => ipcRenderer.invoke("stop-recording"),
  onToggleDictation: (callback) => {
    ipcRenderer.on("toggle-dictation", callback);
    return () => ipcRenderer.removeListener("toggle-dictation", callback);
  },

  // FunASR语音识别
  transcribeAudio: (audioData, options) => ipcRenderer.invoke("transcribe-audio", audioData, options),
  checkFunASRStatus: () => ipcRenderer.invoke("check-funasr-status"),
  installFunASR: () => ipcRenderer.invoke("install-funasr"),
  restartFunasrServer: () => ipcRenderer.invoke("restart-funasr-server"),

  // 模型文件管理
  checkModelFiles: () => ipcRenderer.invoke("check-model-files"),
  getDownloadProgress: () => ipcRenderer.invoke("get-download-progress"),
  downloadModels: () => ipcRenderer.invoke("download-models"),

  // AI文本处理
  processText: (text, mode) => ipcRenderer.invoke("process-text", text, mode),
  checkAIStatus: (testConfig) => ipcRenderer.invoke("check-ai-status", testConfig),

  // 剪贴板操作
  pasteText: (text) => ipcRenderer.invoke("paste-text", text),
  copyText: (text) => ipcRenderer.invoke("copy-text", text),
  readClipboard: () => ipcRenderer.invoke("read-clipboard"),
  writeClipboard: (text) => ipcRenderer.invoke("write-clipboard", text),

  // 数据库操作
  saveTranscription: (transcriptionData) =>
    ipcRenderer.invoke("save-transcription", transcriptionData),
  getTranscriptions: (limit, offset) => 
    ipcRenderer.invoke("get-transcriptions", limit, offset),
  deleteTranscription: (id) =>
    ipcRenderer.invoke("delete-transcription", id),
  updateTranscription: (id, fields) =>
    ipcRenderer.invoke("update-transcription", id, fields),
  clearAllTranscriptions: () => 
    ipcRenderer.invoke("clear-all-transcriptions"),

  // 设置管理
  getSettings: () => ipcRenderer.invoke("get-settings"),
  getAllSettings: () => ipcRenderer.invoke("get-all-settings"),
  getSetting: (key, defaultValue) => ipcRenderer.invoke("get-setting", key, defaultValue),
  setSetting: (key, value) => ipcRenderer.invoke("set-setting", key, value),
  saveSetting: (key, value) => ipcRenderer.invoke("save-setting", key, value),
  resetSettings: () => ipcRenderer.invoke("reset-settings"),

  // 热键管理
  registerHotkey: (hotkey) => ipcRenderer.invoke("register-hotkey", hotkey),
  unregisterHotkey: (hotkey) => ipcRenderer.invoke("unregister-hotkey", hotkey),
  getCurrentHotkey: () => ipcRenderer.invoke("get-current-hotkey"),
  // 重载录音触发键（自定义快捷键保存后调用）
  reloadRecordingTrigger: () => ipcRenderer.invoke("reload-recording-trigger"),
  // 重载「转英文」触发键（自定义快捷键保存后调用）
  reloadTranslateTrigger: () => ipcRenderer.invoke("reload-translate-trigger"),
  // 隐藏胶囊（粘贴/取消后调用）
  hideRecorder: () => ipcRenderer.invoke("hide-recorder"),
  // 通知主进程录音开始/结束（用于按需注册 Esc 取消键）
  setRecorderState: (recording) => ipcRenderer.send("recorder-state", recording),
  // 监听取消录音事件（Esc 触发）
  onCancelRecording: (callback) => {
    ipcRenderer.on("cancel-recording", callback);
    return () => ipcRenderer.removeListener("cancel-recording", callback);
  },

  // 录音开始时预热 LLM 连接（与说话时间重叠，省握手）
  prewarmLLM: () => ipcRenderer.invoke("prewarm-llm"),

  // 流式润色 + 增量上屏（主进程边收边贴）
  processTextStream: (text) => ipcRenderer.invoke("process-text-stream", text),

  // 润色进度监听（契约 B）：回调直接收到负载对象 { status, charCount, chunk }
  onPolishProgress: (callback) => {
    const listener = (_e, data) => callback(data);
    ipcRenderer.on("polish-progress", listener);
    return () => ipcRenderer.removeListener("polish-progress", listener);
  },

  // 内存信息（契约 C）：{ freeBytes, totalBytes }
  getMemoryInfo: () => ipcRenderer.invoke("get-memory-info"),

  // 系统通知（透明胶囊窗口无法显示 toast，改走系统通知）
  showNotification: (title, body) => ipcRenderer.invoke("show-notification", { title, body }),

  // F2热键管理
  registerF2Hotkey: () => ipcRenderer.invoke("register-f2-hotkey"),
  unregisterF2Hotkey: () => ipcRenderer.invoke("unregister-f2-hotkey"),
  setRecordingState: (isRecording) => ipcRenderer.invoke("set-recording-state", isRecording),
  getRecordingState: () => ipcRenderer.invoke("get-recording-state"),
  
  // F2双击事件监听
  onF2DoubleClick: (callback) => {
    ipcRenderer.on("f2-double-click", callback);
    return () => ipcRenderer.removeListener("f2-double-click", callback);
  },
  
  // 热键触发事件监听
  onHotkeyTriggered: (callback) => {
    ipcRenderer.on("hotkey-triggered", callback);
    return () => ipcRenderer.removeListener("hotkey-triggered", callback);
  },

  // 「转英文」状态事件监听（start/done/cancel/error）
  onTranslateStatus: (callback) => {
    ipcRenderer.on("translate-status", callback);
    return () => ipcRenderer.removeListener("translate-status", callback);
  },

  // 胶囊皮肤：重载并广播到胶囊窗口（设置变更后调用）
  reloadPillSkin: () => ipcRenderer.invoke('reload-pill-skin'),
  // 托盘图标样式：切换中笑/彩色后刷新菜单栏托盘
  reloadTrayIcon: () => ipcRenderer.invoke('reload-tray-icon'),
  // 监听胶囊皮肤变更事件（主进程广播 { skin }）
  onPillSkinChanged: (callback) => {
    ipcRenderer.on('pill-skin-changed', callback);
    return () => ipcRenderer.removeListener('pill-skin-changed', callback);
  },

  // 文件操作
  exportTranscriptions: (format) => ipcRenderer.invoke("export-transcriptions", format),
  importSettings: () => ipcRenderer.invoke("import-settings"),
  exportSettings: () => ipcRenderer.invoke("export-settings"),

  // 系统信息
  getSystemInfo: () => ipcRenderer.invoke("get-system-info"),
  checkPermissions: () => ipcRenderer.invoke("check-permissions"),
  requestPermissions: () => ipcRenderer.invoke("request-permissions"),
  testAccessibilityPermission: () => ipcRenderer.invoke("test-accessibility-permission"),
  openSystemPermissions: () => ipcRenderer.invoke("open-system-permissions"),

  // 应用信息
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),

  // 调试和日志
  log: (level, message, data) => ipcRenderer.invoke("log", level, message, data),
  getDebugInfo: () => ipcRenderer.invoke("get-debug-info"),

  // 事件监听
  onTranscriptionUpdate: (callback) => {
    ipcRenderer.on("transcription-update", callback);
    return () => ipcRenderer.removeListener("transcription-update", callback);
  },
  onProcessingUpdate: (callback) => {
    ipcRenderer.on("processing-update", callback);
    return () => ipcRenderer.removeListener("processing-update", callback);
  },
  onError: (callback) => {
    ipcRenderer.on("error", callback);
    return () => ipcRenderer.removeListener("error", callback);
  },
  onSettingsUpdate: (callback) => {
    ipcRenderer.on("settings-update", callback);
    return () => ipcRenderer.removeListener("settings-update", callback);
  },

  // 控制面板相关
  openControlPanel: () => ipcRenderer.invoke("open-control-panel"),
  closeControlPanel: () => ipcRenderer.invoke("close-control-panel"),

  // 历史记录窗口相关
  openHistoryWindow: () => ipcRenderer.invoke("open-history-window"),
  closeHistoryWindow: () => ipcRenderer.invoke("close-history-window"),
  hideHistoryWindow: () => ipcRenderer.invoke("hide-history-window"),

  // 设置窗口相关
  openSettingsWindow: () => ipcRenderer.invoke("open-settings-window"),
  closeSettingsWindow: () => ipcRenderer.invoke("close-settings-window"),
  hideSettingsWindow: () => ipcRenderer.invoke("hide-settings-window"),

  // 中文特定功能
  detectLanguage: (text) => ipcRenderer.invoke("detect-language", text),
  segmentChinese: (text) => ipcRenderer.invoke("segment-chinese", text),
  addPunctuation: (text) => ipcRenderer.invoke("add-punctuation", text),

  // 音频处理
  convertAudioFormat: (audioData, targetFormat) => 
    ipcRenderer.invoke("convert-audio-format", audioData, targetFormat),
  enhanceAudio: (audioData) => ipcRenderer.invoke("enhance-audio", audioData),

  // 模型管理
  downloadModel: (modelName) => ipcRenderer.invoke("download-model", modelName),
  getAvailableModels: () => ipcRenderer.invoke("get-available-models"),
  getCurrentModel: () => ipcRenderer.invoke("get-current-model"),
  switchModel: (modelName) => ipcRenderer.invoke("switch-model", modelName),

  // 模型下载进度监听
  onModelDownloadProgress: (callback) => {
    ipcRenderer.on("model-download-progress", callback);
    return () => ipcRenderer.removeListener("model-download-progress", callback);
  },

  // 性能监控
  getPerformanceStats: () => ipcRenderer.invoke("get-performance-stats"),
  clearPerformanceStats: () => ipcRenderer.invoke("clear-performance-stats")
});

// 添加一些实用的常量
contextBridge.exposeInMainWorld("constants", {
  APP_NAME: "弦外小猫",
  // 版本号不在此硬编码（避免与 package.json 漂移）。
  // 单一来源 = package.json：渲染层通过 electronAPI.getAppVersion() 取 app.getVersion()。
  SUPPORTED_AUDIO_FORMATS: ["wav", "mp3", "m4a", "flac"],
  SUPPORTED_EXPORT_FORMATS: ["txt", "docx", "pdf", "json"],
  DEFAULT_HOTKEY: "CommandOrControl+Shift+Space",
  MAX_RECORDING_DURATION: 300000, // 5分钟
  MAX_TEXT_LENGTH: 10000,
  CHINESE_LANGUAGE_CODES: ["zh", "zh-CN", "zh-TW", "zh-HK"]
});

// 添加调试信息（仅在开发模式下）
if (process.env.NODE_ENV === "development") {
  contextBridge.exposeInMainWorld("debug", {
    getElectronVersion: () => process.versions.electron,
    getNodeVersion: () => process.versions.node,
    getChromeVersion: () => process.versions.chrome,
    getPlatform: () => process.platform,
    getArch: () => process.arch
  });
}