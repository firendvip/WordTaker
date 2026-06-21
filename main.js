const { app, globalShortcut, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

// 导入日志管理器
const LogManager = require("./src/helpers/logManager");

// 初始化日志管理器
const logger = new LogManager();

// 添加全局错误处理
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error);
  if (error.code === "EPIPE") {
    return;
  }
  logger.error("Error stack:", error.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at:", { promise, reason });
});

// 导入助手模块
const EnvironmentManager = require("./src/helpers/environment");
const WindowManager = require("./src/helpers/windowManager");
const DatabaseManager = require("./src/helpers/database");
const ClipboardManager = require("./src/helpers/clipboard");
const FunASRManager = require("./src/helpers/funasrManager");
const TrayManager = require("./src/helpers/tray");
const HotkeyManager = require("./src/helpers/hotkeyManager");
const TriggerManager = require("./src/helpers/triggerManager");
const IPCHandlers = require("./src/helpers/ipcHandlers");

// 设置生产环境PATH
function setupProductionPath() {
  logger.info('设置生产环境PATH', {
    platform: process.platform,
    nodeEnv: process.env.NODE_ENV,
    currentPath: process.env.PATH
  });

  if (process.platform === 'darwin' && process.env.NODE_ENV !== 'development') {
    const commonPaths = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      '/Library/Frameworks/Python.framework/Versions/3.12/bin',
      '/Library/Frameworks/Python.framework/Versions/3.11/bin',
      '/Library/Frameworks/Python.framework/Versions/3.10/bin',
      '/Library/Frameworks/Python.framework/Versions/3.9/bin',
      '/Library/Frameworks/Python.framework/Versions/3.8/bin',
      // 添加更多可能的Python路径
      '/opt/homebrew/opt/python@3.11/bin',
      '/opt/homebrew/opt/python@3.10/bin',
      '/opt/homebrew/opt/python@3.9/bin',
      '/usr/local/opt/python@3.11/bin',
      '/usr/local/opt/python@3.10/bin',
      '/usr/local/opt/python@3.9/bin'
    ];
    
    const currentPath = process.env.PATH || '';
    const pathsToAdd = commonPaths.filter(p => !currentPath.includes(p));
    
    if (pathsToAdd.length > 0) {
      const newPath = `${currentPath}:${pathsToAdd.join(':')}`;
      process.env.PATH = newPath;
      logger.info('PATH已更新', {
        添加的路径: pathsToAdd,
        新PATH: newPath
      });
    } else {
      logger.info('PATH无需更新，所有路径已存在');
    }
  } else if (process.platform === 'win32' && process.env.NODE_ENV !== 'development') {
    // Windows平台的Python路径设置
    const commonPaths = [
      'C:\\Python311\\Scripts',
      'C:\\Python311',
      'C:\\Python310\\Scripts',
      'C:\\Python310',
      'C:\\Python39\\Scripts',
      'C:\\Python39',
      'C:\\Users\\' + require('os').userInfo().username + '\\AppData\\Local\\Programs\\Python\\Python311\\Scripts',
      'C:\\Users\\' + require('os').userInfo().username + '\\AppData\\Local\\Programs\\Python\\Python311',
      'C:\\Users\\' + require('os').userInfo().username + '\\AppData\\Local\\Programs\\Python\\Python310\\Scripts',
      'C:\\Users\\' + require('os').userInfo().username + '\\AppData\\Local\\Programs\\Python\\Python310'
    ];
    
    const currentPath = process.env.PATH || '';
    const pathsToAdd = commonPaths.filter(p => !currentPath.includes(p));
    
    if (pathsToAdd.length > 0) {
      const newPath = `${currentPath};${pathsToAdd.join(';')}`;
      process.env.PATH = newPath;
      logger.info('Windows PATH已更新', {
        添加的路径: pathsToAdd,
        新PATH: newPath
      });
    }
  }
}

// 在初始化管理器之前设置PATH
setupProductionPath();

// 设置用户数据目录环境变量，供Python脚本使用
process.env.ELECTRON_USER_DATA = app.getPath('userData');
logger.info('设置用户数据目录环境变量', {
  ELECTRON_USER_DATA: process.env.ELECTRON_USER_DATA
});

// 初始化管理器
const environmentManager = new EnvironmentManager();
const windowManager = new WindowManager(logger);
const databaseManager = new DatabaseManager();
const clipboardManager = new ClipboardManager(logger, databaseManager); // 传递logger与databaseManager（用于"保留结果到剪贴板"设置）
const funasrManager = new FunASRManager(logger); // 传递logger实例
const trayManager = new TrayManager();
const hotkeyManager = new HotkeyManager();
const triggerManager = new TriggerManager(logger);
// 第二个触发器：录音期间监听"不走 API 的结束键"（默认左 Ctrl）。
// uiohook 是单例（TriggerManager._hookRunning 守卫），多个实例可共存、各自挂自己的监听。
const rawStopTriggerManager = new TriggerManager(logger);
// 第三个触发器：取消键若被设为裸修饰键（单/双击），则用它监听；否则走 globalShortcut（Esc/F 键）。
const cancelTriggerManager = new TriggerManager(logger);
// 第四个触发器：「转英文」全局键（默认单击左 Ctrl）。仅在非录音时生效，
// 录音中按左 Ctrl 走「不走 API 的结束键(raw-stop)」，二者由 isRecording 互斥。
const translateTriggerManager = new TriggerManager(logger);

// 录音状态（由 recorder-state 同步）：转英文键在录音中必须让位给 raw-stop。
let isRecording = false;
// 「转英文」重入守卫：一次捕获→翻译→粘贴未完成前，忽略再次触发，避免键盘风暴。
let isTranslating = false;
// 应用是否已完成启动初始化（转英文触发器已挂载）。用于防止早期/边缘的 recorder-state(true)
// 在触发器尚未挂载前就误调用 stop() 造成的状态错乱。
let appFullyInitialized = false;
// 录音开始时间戳：用于最小录音时长守卫，忽略录音刚开始(<800ms)的取消，防止胶囊误消失。
let recordStartedAt = 0;

// 校验 recording_trigger，非法字段一律回退默认（防止渲染层写入异常对象）
function validateRecordingTrigger(t, fallback) {
  if (!t || typeof t !== 'object') return fallback;
  if (t.type === 'modifier-tap') {
    if (!TriggerManager.VALID_KEYS.has(t.key)) return fallback;
    if (t.taps !== 1 && t.taps !== 2) return fallback;
    return { type: 'modifier-tap', key: t.key, taps: t.taps };
  }
  if (t.type === 'accelerator') {
    if (typeof t.accelerator !== 'string' || !t.accelerator) return fallback;
    return { type: 'accelerator', accelerator: t.accelerator };
  }
  return fallback;
}

// 设置录音触发（默认：mac 单击左 Option / Windows 双击左 Alt；裸修饰键经 uiohook 监听）
function setupRecordingTrigger() {
  try {
    const platformDefault = process.platform === 'win32'
      ? { type: 'modifier-tap', key: 'LeftAlt', taps: 2 }
      : { type: 'modifier-tap', key: 'LeftOption', taps: 1 };
    const stored = databaseManager.getSetting('recording_trigger', platformDefault);
    const trigger = validateRecordingTrigger(stored, platformDefault);
    if (trigger !== stored) {
      logger.warn('recording_trigger 非法或缺失，已回退默认', { stored });
    }

    const fire = () => {
      // 每次触发把胶囊定位到"光标所在屏幕底部"并显示（不抢焦点）
      windowManager.showRecorderAtBottom();
      const win = windowManager.mainWindow;
      if (win && !win.isDestroyed()) {
        win.webContents.send('hotkey-triggered', { trigger });
        logger.info('录音触发 → 已发送 hotkey-triggered', trigger);
      }
    };

    // 先清掉旧的触发（便于设置变更后重载）
    triggerManager.stop();

    if (trigger.type === 'accelerator' && trigger.accelerator) {
      // 普通组合键走 Electron globalShortcut
      hotkeyManager.registerHotkey(trigger.accelerator, fire);
      logger.info('录音触发使用组合键', trigger.accelerator);
    } else {
      // 裸修饰键走 uiohook
      const ok = triggerManager.start(trigger, fire);
      if (!ok) {
        logger.error('[trigger] uiohook 启动失败，全局快捷键将不可用');
      }
    }
  } catch (error) {
    logger.error('设置录音触发失败:', error);
  }
}

// 设置变更后重载触发键（自定义快捷键时调用）
ipcMain.handle('reload-recording-trigger', () => {
  setupRecordingTrigger();
  return { success: true };
});

// 「转英文」热键处理：捕获选中文本 → 翻译为地道英文 → 粘贴回去。
// 录音中（左 Ctrl 走 raw-stop）或上一次仍在进行时直接跳过。全程在主进程编排，串行防风暴。
async function handleTranslateHotkey() {
  const sendTranslateStatus = (phase, extra = {}) => {
    try {
      const w = windowManager.mainWindow;
      if (w && !w.isDestroyed()) w.webContents.send('translate-status', { phase, ...extra });
    } catch (_) {}
  };
  const hidePillLater = (ms) => setTimeout(() => { try { windowManager.hideMainWindow(); } catch (_) {} }, ms);
  logger.info('转英文快捷键触发');
  if (isRecording) return; // 录音中按 Ctrl = 结束(raw-stop)，不触发转英文
  if (isTranslating) return; // 重入守卫
  if (!ipcHandlers || !ipcHandlers.aiService || !clipboardManager) {
    logger.error('转英文：服务未就绪');
    return;
  }
  isTranslating = true;
  windowManager.showRecorderAtBottom(); sendTranslateStatus('start');
  try {
    // 新增设置：允许在未选中文本时回退到「整框全选」翻译
    const allowSelectAll = await databaseManager.getSetting('translate_fallback_select_all', false);
    const cap = await clipboardManager.captureSelectionText({ allowSelectAll });
    const src = cap && cap.text ? cap.text : '';
    logger.info('转英文：捕获文本长度=' + (src ? src.length : 0));
    if (!src.trim()) {
      logger.info('转英文：未选中文本且未开启整框翻译，跳过');
      sendTranslateStatus('cancel'); hidePillLater(600);
      return;
    }
    const res = await ipcHandlers.aiService.translateToEnglish(src);
    if (res && res.success && res.text && res.text.trim()) {
      logger.info('转英文：翻译完成，粘贴中');
      sendTranslateStatus('done');
      await clipboardManager.pasteText(res.text);
      hidePillLater(650);
    } else {
      logger.warn('转英文失败:', res && res.error);
      sendTranslateStatus('error', { message: (res && res.error) || '翻译失败' }); hidePillLater(1200);
    }
  } catch (e) {
    logger.error('handleTranslateHotkey error:', e);
    sendTranslateStatus('error', { message: String(e && e.message || e) }); hidePillLater(1200);
  } finally {
    isTranslating = false;
  }
}

// 设置「转英文」触发键（默认单击左 Ctrl，裸修饰键经 uiohook 监听）。
function setupTranslateTrigger() {
  try {
    const fallback = { type: 'modifier-tap', key: 'LeftCtrl', taps: 2 };
    const stored = databaseManager.getSetting('translate_trigger', fallback);
    // 复用录音触发键的校验：非法字段一律回退默认
    const trigger = validateRecordingTrigger(stored, fallback);
    if (trigger !== stored) {
      logger.warn('translate_trigger 非法或缺失，已回退默认', { stored });
    }

    // 先清掉旧的触发（便于设置变更后重载）
    translateTriggerManager.stop();

    if (trigger.type === 'accelerator' && trigger.accelerator) {
      // 组合键走 Electron globalShortcut
      hotkeyManager.registerHotkey(trigger.accelerator, () => { handleTranslateHotkey(); });
      logger.info('转英文触发使用组合键', trigger.accelerator);
      logger.info('转英文触发器已挂载:', JSON.stringify(trigger));
    } else {
      // 裸修饰键走 uiohook
      const ok = translateTriggerManager.start(trigger, () => { handleTranslateHotkey(); });
      if (!ok) {
        logger.warn('转英文裸修饰键触发启动失败，请确认已授予“辅助功能”权限');
        logger.warn('转英文触发器挂载失败');
      } else {
        logger.info('转英文触发器已挂载:', JSON.stringify(trigger));
      }
    }
  } catch (error) {
    logger.error('设置转英文触发失败:', error);
  }
}

// 设置变更后重载「转英文」触发键
ipcMain.handle('reload-translate-trigger', () => {
  try {
    setupTranslateTrigger();
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});

// 胶囊皮肤变更后实时广播到胶囊窗口（主窗口），让中心动画即时切换
ipcMain.handle('reload-pill-skin', () => {
  try {
    const skin = databaseManager.getSetting('pill_skin', 'music');
    const w = windowManager.mainWindow;
    if (w && !w.isDestroyed()) w.webContents.send('pill-skin-changed', { skin });
    return { success: true, skin };
  } catch (e) {
    return { success: false, error: String(e && e.message || e) };
  }
});

// 隐藏胶囊（粘贴完成 / 取消后由渲染层调用）
ipcMain.handle('hide-recorder', () => {
  windowManager.hideMainWindow();
  // 安全网：胶囊隐藏即视为本次录音结束，确保全局 Esc / 裸结束键被释放，
  // 即使渲染层漏发 recorder-state(false) 也不会让 Esc 被全局长期吞掉。
  unregisterCancelKey();
  unregisterRawStopKey();
  return { success: true };
});

// 读取录音触发键的 { key, taps }（用于冲突检测）；非 modifier-tap 时返回 null。
function getRecordingTriggerModifier() {
  const trig = databaseManager.getSetting('recording_trigger', null);
  if (trig && trig.type === 'modifier-tap' && TriggerManager.VALID_KEYS.has(trig.key)) {
    return { key: trig.key, taps: trig.taps === 2 ? 2 : 1 };
  }
  return null;
}

function isSameModifierTap(a, b) {
  return !!a && !!b && a.key === b.key && Number(a.taps) === Number(b.taps);
}

// "不走 API 的结束键"（裸修饰键，默认左 Ctrl）：仅录音期间监听，停止后注销。
// 触发时通知渲染层走"原始识别、不调用大模型"的结束路径。
function registerRawStopKey() {
  try {
    const key = databaseManager.getSetting('raw_stop_key', 'LeftCtrl') || 'LeftCtrl';
    const taps = Number(databaseManager.getSetting('raw_stop_taps', 1)) === 2 ? 2 : 1;
    if (!TriggerManager.VALID_KEYS.has(key)) {
      logger.warn('raw_stop_key 非法，跳过注册', { key });
      return;
    }
    // 与录音触发键的 {key,taps} 完全相同则跳过，避免同一次按键被两个监听器同时当成结束
    const trig = getRecordingTriggerModifier();
    if (isSameModifierTap(trig, { key, taps })) {
      logger.warn('raw_stop_key 与录音触发键相同，跳过注册', { key, taps });
      return;
    }
    rawStopTriggerManager.start({ type: 'modifier-tap', key, taps }, () => {
      const win = windowManager.mainWindow;
      if (win && !win.isDestroyed()) win.webContents.send('raw-stop');
    });
  } catch (error) {
    logger.error('注册 raw 结束键失败:', error);
  }
}
function unregisterRawStopKey() {
  try { rawStopTriggerManager.stop(); } catch (_) { /* 忽略 */ }
}

// 取消录音：仅在录音期间注册，避免平时吞掉按键。
// 取消键现支持 Esc / F1 / F2 / F4 / F8 的单/双击；因 globalShortcut 无法识别"双击"，
// 这些键已加入 TriggerManager.VALID_KEYS，统一走 uiohook 第三触发器（cancelTriggerManager）。
// 注意：底层 uiohook 为"只监听不拦截"，因此 Esc/F 键会被观察到用于触发取消，
// 但不会被消费——它们仍会照常送达当前聚焦的应用（可接受）。
// 下方 globalShortcut 分支对当前选项已基本不会命中，保留为无害回退。
let cancelKeyRegistered = null; // 仅记录已注册的 globalShortcut 加速键（回退用）
function fireCancel() {
  if (Date.now() - recordStartedAt < 800) {
    logger.info('忽略过早的取消(录音不足800ms)，防止胶囊误消失');
    return;
  }
  const win = windowManager.mainWindow;
  if (win && !win.isDestroyed()) win.webContents.send('cancel-recording');
  windowManager.hideMainWindow();
}
function registerCancelKey() {
  try {
    const key = databaseManager.getSetting('cancel_key', 'Escape') || 'Escape';

    if (TriggerManager.VALID_KEYS.has(key)) {
      // 裸修饰键形态：用第三触发器监听单/双击
      const taps = Number(databaseManager.getSetting('cancel_taps', 1)) === 2 ? 2 : 1;
      const target = { key, taps };
      const trig = getRecordingTriggerModifier();
      if (isSameModifierTap(trig, target)) {
        logger.warn('cancel_key 与录音触发键相同，跳过注册', target);
        return;
      }
      const rawKey = databaseManager.getSetting('raw_stop_key', 'LeftCtrl') || 'LeftCtrl';
      const rawTaps = Number(databaseManager.getSetting('raw_stop_taps', 1)) === 2 ? 2 : 1;
      if (isSameModifierTap({ key: rawKey, taps: rawTaps }, target)) {
        logger.warn('cancel_key 与原文结束键相同，跳过注册', target);
        return;
      }
      cancelTriggerManager.start({ type: 'modifier-tap', key, taps }, fireCancel);
      return;
    }

    // 加速键形态（Esc/F 键）：走 Electron globalShortcut
    if (cancelKeyRegistered === key) return;
    if (cancelKeyRegistered) globalShortcut.unregister(cancelKeyRegistered);
    const ok = globalShortcut.register(key, fireCancel);
    cancelKeyRegistered = ok ? key : null;
  } catch (error) {
    logger.error('注册取消键失败:', error);
  }
}
function unregisterCancelKey() {
  try {
    if (cancelKeyRegistered) {
      globalShortcut.unregister(cancelKeyRegistered);
      cancelKeyRegistered = null;
    }
  } catch (error) {
    // 忽略
  }
  try { cancelTriggerManager.stop(); } catch (_) { /* 忽略 */ }
}

// 渲染层在录音开始/结束时通知主进程，用于按需注册/注销 Esc 取消键 + raw 结束键
ipcMain.on('recorder-state', (event, recording) => {
  // 记录录音状态：转英文键在录音中让位给 raw-stop（见 handleTranslateHotkey）。
  isRecording = !!recording;
  if (recording) {
    recordStartedAt = Date.now();
    registerCancelKey();
    registerRawStopKey();
    // 录音期间左 Ctrl 必须让位给 raw-stop：停掉转英文触发器，避免裸修饰键被双重监听。
    // 仅在应用完成初始化（触发器已挂载）后才停用，避免早期/边缘的 recorder-state(true) 误调用。
    if (appFullyInitialized) {
      try { translateTriggerManager.stop(); } catch (_) {}
    }
  } else {
    unregisterCancelKey();
    unregisterRawStopKey();
    // 录音结束后重新挂回转英文触发器。
    try {
      setupTranslateTrigger();
    } catch (_) { /* 忽略 */ }
  }
});

// 初始化数据库：损坏/锁定等同步异常会在任何窗口出现前崩主进程，
// 这里捕获后弹出可见错误对话框并干净退出，避免静默崩溃（DB-1）。
const dataDirectory = environmentManager.ensureDataDirectory();
try {
  databaseManager.initialize(dataDirectory);
} catch (error) {
  logger.error("数据库初始化失败:", error);
  try {
    dialog.showErrorBox(
      "WordTaker 启动失败",
      `无法初始化本地数据库，应用将退出。\n\n${error?.message || error}`
    );
  } catch (e) {
    logger.error("显示数据库错误对话框失败:", e);
  }
  app.quit();
  throw error;
}

// 使用所有管理器初始化IPC处理器
const ipcHandlers = new IPCHandlers({
  environmentManager,
  databaseManager,
  clipboardManager,
  funasrManager,
  windowManager,
  hotkeyManager,
  logger, // 传递logger实例
});

// 主应用启动函数
// 启动时清理上次崩溃残留的临时音频文件（os.tmpdir 下 funasr_audio_*.wav）
function cleanupOrphanTempAudio() {
  try {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const dir = os.tmpdir();
    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('funasr_audio_') && name.endsWith('.wav')) {
        try { fs.unlinkSync(path.join(dir, name)); removed++; } catch (e) { /* 跳过 */ }
      }
    }
    if (removed) logger.info('已清理孤儿临时音频文件', { removed });
  } catch (error) {
    logger.warn('清理孤儿临时音频文件失败:', error?.message || error);
  }
}

async function startApp() {
  logger.info('应用启动开始', {
    nodeEnv: process.env.NODE_ENV,
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    appVersion: app.getVersion()
  });

  // 清理上次异常退出残留的临时音频
  cleanupOrphanTempAudio();

  // 注释掉 accessibility 支持 - 可能干扰文本插入
  // try {
  //   app.setAccessibilitySupportEnabled(true);
  //   logger.info('✅ 已启用 Electron accessibility 支持');
  // } catch (error) {
  //   logger.warn('⚠️ 启用 accessibility 支持失败:', error.message);
  // }

  // 记录系统信息
  logger.info('系统信息', logger.getSystemInfo());

  // 开发模式下添加小延迟让Vite正确启动
  if (process.env.NODE_ENV === "development") {
    logger.info('开发模式，等待Vite启动...');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // 后台常驻：macOS 隐藏 Dock 图标，做成纯菜单栏应用（只在托盘可见，胶囊按触发键才出现）
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
    logger.info('macOS Dock已隐藏（后台菜单栏模式）');
  }

  // 在启动时初始化FunASR管理器（不等待以避免阻塞）
  logger.info('开始初始化FunASR管理器...');
  funasrManager.initializeAtStartup().catch((err) => {
    logger.warn("FunASR在启动时不可用，这不是关键问题", err);
  });

  // 创建主窗口
  try {
    logger.info('创建主窗口...');
    await windowManager.createMainWindow();
    logger.info('主窗口创建成功');
  } catch (error) {
    logger.error("创建主窗口时出错:", error);
  }

  // 主窗口创建失败会让应用陷入"无窗口、无反馈"状态：弹出可见错误并退出（MAIN-1）。
  if (!windowManager.mainWindow) {
    try {
      dialog.showErrorBox(
        "WordTaker 启动失败",
        "无法创建主窗口，应用将退出。请重试或重新安装。"
      );
    } catch (e) {
      logger.error("显示主窗口错误对话框失败:", e);
    }
    app.quit();
    return;
  }

  // 控制面板窗口已废弃：新架构只用悬浮胶囊（主窗口），后台常驻仅靠托盘图标。

  // 设置托盘（应用后台常驻，设置/历史从托盘进入）
  logger.info('设置系统托盘...');
  trayManager.setWindows(windowManager.mainWindow, null);
  trayManager.setOpenSettings(() => windowManager.showSettingsWindow());
  trayManager.setOpenHistory(() => windowManager.showHistoryWindow());
  await trayManager.createTray();
  logger.info('系统托盘设置完成');

  // 设置全局录音触发键
  logger.info('设置录音触发键...');
  setupRecordingTrigger();

  // 设置「转英文」全局触发键
  logger.info('设置转英文触发键...');
  setupTranslateTrigger();
  // 触发器已挂载，标记应用完成初始化（允许 recorder-state 在录音时停用转英文触发器）
  appFullyInitialized = true;

  logger.info('应用启动完成');
}

// 单实例锁：保证同一时间只运行一个实例，避免重复启动
// （重复会造成快捷键重复注册、双托盘图标、两个 FunASR 进程抢端口等问题）
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // 已有实例在运行：本次启动直接退出
  logger.info("检测到已有实例在运行，本次启动退出");
  app.quit();
} else {
  // 用户再次尝试启动时，把已有窗口带到前台（后台常驻应用通常无常显窗口，尽力聚焦）
  app.on("second-instance", () => {
    try {
      // 后台常驻应用：再次启动时打开"设置"这种正常可聚焦窗口，
      // 绝不要去 show()/focus() 那个 focusable:false 的透明胶囊——对不可聚焦窗口
      // 强行 focus 在 macOS 上可能造成焦点/事件异常。
      windowManager.showSettingsWindow();
    } catch (error) {
      logger.error("处理 second-instance 失败:", error);
    }
  });
}

// 应用事件处理器
app.whenReady().then(() => {
  // 第二实例不会拿到锁：直接不启动（app.quit 已触发）
  if (!gotTheLock) return;
  startApp();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    windowManager.createMainWindow();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  // 强杀 FunASR Python 子进程，杜绝孤儿进程堆积拖垮系统
  try {
    funasrManager.killServerSync();
  } catch (error) {
    logger.error('关闭 FunASR 失败:', error);
  }
  try {
    rawStopTriggerManager.stop();
  } catch (_) { /* 忽略 */ }
  try {
    cancelTriggerManager.stop();
  } catch (_) { /* 忽略 */ }
  try {
    translateTriggerManager.stop();
  } catch (_) { /* 忽略 */ }
  try {
    triggerManager.shutdown();
  } catch (error) {
    logger.error('关闭 triggerManager 失败:', error);
  }
});

// 退出前再兜底杀一次(防止 will-quit 时机错过)
app.on("before-quit", () => {
  try { funasrManager.killServerSync(); } catch (e) { /* 忽略 */ }
});

// 导出管理器供其他模块使用
module.exports = {
  environmentManager,
  windowManager,
  databaseManager,
  clipboardManager,
  funasrManager,
  trayManager,
  hotkeyManager,
  logger
};