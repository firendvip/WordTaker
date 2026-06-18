const { app, globalShortcut, BrowserWindow, ipcMain } = require("electron");
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
const windowManager = new WindowManager();
const databaseManager = new DatabaseManager();
const clipboardManager = new ClipboardManager(logger); // 传递logger实例
const funasrManager = new FunASRManager(logger); // 传递logger实例
const trayManager = new TrayManager();
const hotkeyManager = new HotkeyManager();
const triggerManager = new TriggerManager(logger);
// 第二个触发器：录音期间监听"不走 API 的结束键"（默认左 Ctrl）。
// uiohook 是单例（TriggerManager._hookRunning 守卫），多个实例可共存、各自挂自己的监听。
const rawStopTriggerManager = new TriggerManager(logger);

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
        logger.warn('裸修饰键触发启动失败，请确认已授予“辅助功能”权限');
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

// 隐藏胶囊（粘贴完成 / 取消后由渲染层调用）
ipcMain.handle('hide-recorder', () => {
  windowManager.hideMainWindow();
  return { success: true };
});

// Esc（可自定义）取消录音：仅在录音期间注册全局快捷键，避免平时吞掉 Esc
let cancelKeyRegistered = null;
function registerCancelKey() {
  try {
    const key = databaseManager.getSetting('cancel_key', 'Escape') || 'Escape';
    if (cancelKeyRegistered === key) return;
    if (cancelKeyRegistered) globalShortcut.unregister(cancelKeyRegistered);
    const ok = globalShortcut.register(key, () => {
      const win = windowManager.mainWindow;
      if (win && !win.isDestroyed()) win.webContents.send('cancel-recording');
      windowManager.hideMainWindow();
    });
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
}

// "不走 API 的结束键"（裸修饰键，默认左 Ctrl）：仅录音期间监听，停止后注销。
// 触发时通知渲染层走"原始识别、不调用大模型"的结束路径。
function registerRawStopKey() {
  try {
    const key = databaseManager.getSetting('raw_stop_key', 'LeftCtrl') || 'LeftCtrl';
    if (!TriggerManager.VALID_KEYS.has(key)) {
      logger.warn('raw_stop_key 非法，跳过注册', { key });
      return;
    }
    // 与录音触发键相同则跳过，避免同一次按键被两个监听器同时当成结束
    const trig = databaseManager.getSetting('recording_trigger', null);
    if (trig && trig.type === 'modifier-tap' && trig.key === key) {
      logger.warn('raw_stop_key 与录音触发键相同，跳过注册', { key });
      return;
    }
    rawStopTriggerManager.start({ type: 'modifier-tap', key, taps: 1 }, () => {
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

// 渲染层在录音开始/结束时通知主进程，用于按需注册/注销 Esc 取消键 + raw 结束键
ipcMain.on('recorder-state', (event, recording) => {
  if (recording) {
    registerCancelKey();
    registerRawStopKey();
  } else {
    unregisterCancelKey();
    unregisterRawStopKey();
  }
});

// 初始化数据库
const dataDirectory = environmentManager.ensureDataDirectory();
databaseManager.initialize(dataDirectory);

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
      const win = BrowserWindow.getAllWindows().find((w) => w && !w.isDestroyed());
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
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
  try {
    rawStopTriggerManager.stop();
  } catch (_) { /* 忽略 */ }
  try {
    triggerManager.shutdown();
  } catch (error) {
    logger.error('关闭 triggerManager 失败:', error);
  }
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