const { app, globalShortcut, BrowserWindow, ipcMain, dialog, shell, crashReporter, systemPreferences, session, Notification, Menu } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

// ============================================================================
// 早期本地文件日志（在加载任何原生模块 better-sqlite3 / uiohook-napi 之前就绪）
// 设计约束：日志绝不能抛异常/阻塞启动——本应用历史上出现过全屏卡死事故，
// 所有写日志路径全部包在 try/catch 里，失败即静默降级，绝不影响主流程。
//
// 注意：Windows 0xc0000017 属于 PE 映像加载器层面的失败，发生在 Node/JS 运行之前，
// 可能导致 app.log 为空——这是预期内的。本日志只能捕获“已经进入 JS”的一切信息；
// 真正 pre-JS 的原生崩溃由下方 crashReporter 落 minidump 兜底。
// ============================================================================
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 单文件上限 ~2MB，超过则截断轮转，防止无界增长
let earlyLogFile = null;

function resolveEarlyLogDir() {
  // 首选 Electron userData；若此刻 app 尚不可用，回退到 APPDATA / 家目录。
  try {
    if (app && typeof app.getPath === "function") {
      return path.join(app.getPath("userData"), "logs");
    }
  } catch (_) { /* app 未就绪，走回退 */ }
  try {
    const base = process.env.APPDATA || os.homedir() || os.tmpdir();
    return path.join(base, "WordTaker", "logs");
  } catch (_) {
    return null;
  }
}

function rotateEarlyLogIfNeeded() {
  try {
    if (!earlyLogFile) return;
    const st = fs.statSync(earlyLogFile);
    if (st.size > MAX_LOG_BYTES) {
      // 简单轮转：保留上一份为 .1，再清空当前文件
      try { fs.renameSync(earlyLogFile, earlyLogFile + ".1"); } catch (_) {}
    }
  } catch (_) { /* 文件不存在或无法 stat，忽略 */ }
}

function earlyLog(message, extra) {
  try {
    if (!earlyLogFile) return;
    rotateEarlyLogIfNeeded();
    const ts = new Date().toISOString();
    let line = `[${ts}] ${message}`;
    if (extra !== undefined) {
      try { line += " " + (typeof extra === "string" ? extra : JSON.stringify(extra)); }
      catch (_) { line += " [unserializable]"; }
    }
    fs.appendFileSync(earlyLogFile, line + "\n");
  } catch (_) { /* 写日志绝不抛 */ }
}

function setupEarlyFileLogging() {
  try {
    const dir = resolveEarlyLogDir();
    if (!dir) return;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    earlyLogFile = path.join(dir, "app.log");

    let appVersion = "unknown";
    try { appVersion = app.getVersion(); } catch (_) {}
    let totalmem = 0, freemem = 0;
    try { totalmem = os.totalmem(); freemem = os.freemem(); } catch (_) {}

    earlyLog("========== WordTaker 启动 ==========", {
      appVersion,
      versions: process.versions,
      platform: process.platform,
      arch: process.arch,
      osRelease: (() => { try { return os.release(); } catch (_) { return "?"; } })(),
      totalmemMB: Math.round(totalmem / 1048576),
      freememMB: Math.round(freemem / 1048576),
      resourcesPath: process.resourcesPath,
      logFile: earlyLogFile
    });
  } catch (_) { /* 整个早期日志初始化失败也绝不影响启动 */ }
}

setupEarlyFileLogging();

// crashReporter：尽早启动，让“接近原生”的崩溃在本地落 minidump（不上传任何服务器）。
try {
  crashReporter.start({ submitURL: "", uploadToServer: false });
  let dumpDir = "unknown";
  try { dumpDir = app.getPath("crashDumps"); } catch (_) {}
  earlyLog("crashReporter 已启动（仅本地 minidump，不上传）", { crashDumps: dumpDir });
} catch (e) {
  earlyLog("crashReporter 启动失败", String(e && e.stack ? e.stack : e));
}

// Windows 渲染加固：禁用 GPU 硬件加速（必须在 app ready 之前调用，故放在模块加载早期）。
// 根因：部分 Windows 机器 DWM/显卡驱动对"透明+frameless"窗口的 GPU 合成不稳定
// （electron#2170 类 wontfix），合成失效时窗口以默认白底整块呈现 → 用户看到"白条"。
// 关闭硬件加速后透明窗口走软件合成，绕开驱动兼容性；本应用 UI 极轻，无性能影响。
// 仅 win32 生效，macOS 保持硬件加速不变。
if (process.platform === "win32") {
  try {
    app.disableHardwareAcceleration();
    earlyLog("win32：已禁用 GPU 硬件加速（透明胶囊白条防护）");
  } catch (e) {
    earlyLog("disableHardwareAcceleration 调用失败", String(e && e.stack ? e.stack : e));
  }
  // Windows 系统通知必须先设置 AppUserModelID（与 electron-builder appId 一致），
  // 否则打包版 new Notification().show() 静默不显示——「润色失败，已贴出原文」
  // 「云端额度不足」等所有提示在 Windows 上全被吞掉，用户看不到任何失败原因。
  try {
    app.setAppUserModelId("com.kittyecho.app");
    earlyLog("win32：AppUserModelID 已设置（系统通知可见性）");
  } catch (e) {
    earlyLog("setAppUserModelId 调用失败", String(e && e.stack ? e.stack : e));
  }
}

// 导入日志管理器
const LogManager = require("./src/helpers/logManager");

// 初始化日志管理器
const logger = new LogManager();

// 添加全局错误处理（同时写入早期 app.log，保证崩溃栈一定落盘）
process.on("uncaughtException", (error) => {
  earlyLog("uncaughtException", String(error && error.stack ? error.stack : error));
  logger.error("Uncaught Exception:", error);
  if (error.code === "EPIPE") {
    return;
  }
  logger.error("Error stack:", error.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  earlyLog("unhandledRejection", String(reason && reason.stack ? reason.stack : reason));
  logger.error("Unhandled Rejection at:", { promise, reason });
});

// 导入助手模块。原生模块（better-sqlite3 / uiohook-napi）经由这些 helper 间接 require，
// 若某个 .node 架构/ABI 不符或损坏会在此抛错——包在 try/catch 里先把“具体模块+错误”落盘，
// 再原样 rethrow，避免静默原生崩溃只留一个无信息的退出码。
let EnvironmentManager, WindowManager, DatabaseManager, ClipboardManager,
    FunASRManager, LLMManager, TrayManager, HotkeyManager, TriggerManager, IPCHandlers;
try {
  EnvironmentManager = require("./src/helpers/environment");
  WindowManager = require("./src/helpers/windowManager");
  earlyLog("即将加载 database.js（间接 require better-sqlite3 原生模块）");
  DatabaseManager = require("./src/helpers/database");
  earlyLog("database.js 加载成功（better-sqlite3 .node 可加载）");
  ClipboardManager = require("./src/helpers/clipboard");
  FunASRManager = require("./src/helpers/funasrManager");
  LLMManager = require("./src/helpers/llmManager");
  earlyLog("即将加载 tray/trigger（间接 require uiohook-napi 原生模块）");
  TrayManager = require("./src/helpers/tray");
  HotkeyManager = require("./src/helpers/hotkeyManager");
  TriggerManager = require("./src/helpers/triggerManager");
  earlyLog("uiohook-napi 相关模块加载成功");
  IPCHandlers = require("./src/helpers/ipcHandlers");
} catch (e) {
  earlyLog("原生/助手模块加载失败（很可能是某个 .node 架构/ABI 不符或损坏）",
    String(e && e.stack ? e.stack : e));
  throw e;
}

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
// 把同一个 databaseManager 实例注入 windowManager（胶囊"跟随焦点"开关需读 pill_follow_focus）
windowManager.setDatabaseManager(databaseManager);
const funasrManager = new FunASRManager(logger); // 传递logger实例
const llmManager = new LLMManager(logger); // 本地大模型润色管理器
const trayManager = new TrayManager();
const hotkeyManager = new HotkeyManager();
const triggerManager = new TriggerManager(logger);
// 第二个触发器：取消键若被设为裸修饰键（单/双击），则用它监听；否则走 globalShortcut（Esc/F 键）。
const cancelTriggerManager = new TriggerManager(logger);
// 第三个触发器：「转英文」全局键（默认单击左 Ctrl）。仅在非录音时生效，
// 录音期间让位给录音结束，二者由 isRecording 互斥。
const translateTriggerManager = new TriggerManager(logger);

// 录音状态（由 recorder-state 同步）：转英文键在录音中必须让位。
let isRecording = false;
// 会话忙碌：一次录音会话从「开始录音」直到胶囊真正隐藏的整个窗口，
// 覆盖 recording + processing(转写) + optimizing(润色)。处理阶段 isRecording 已为 false，
// 但 isBusy 仍为 true，用于阻止处理阶段误触转英文抢占/隐藏胶囊。
let isBusy = false;
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
    // taps 宽容为数值化后判定（历史数据可能存成字符串 "1"/"2"），避免合法值被误判非法
    const taps = Number(t.taps);
    if (taps !== 1 && taps !== 2) return fallback;
    return { type: 'modifier-tap', key: t.key, taps };
  }
  if (t.type === 'accelerator') {
    if (typeof t.accelerator !== 'string' || !t.accelerator) return fallback;
    return { type: 'accelerator', accelerator: t.accelerator };
  }
  return fallback;
}

// 录音触发注册失败时的兜底组合键候选（逐个尝试，取第一个能注册成功的）。
// 只有主触发注册失败才会用到——正常路径（mac uiohook / win uiohook / 自定义组合键成功）行为不变。
const FALLBACK_RECORDING_ACCELERATORS = ['Control+Alt+Space', 'Control+Shift+Space', 'Alt+Shift+Space'];
let recordingFallbackAccel = null; // 当前生效的兜底组合键（重载触发键时先注销，避免残留）
let recordingCurrentAccel = null;  // 当前生效的用户组合键（重载时先注销，避免旧键残留继续触发）
let recordingFire = null;          // 最近一次 setupRecordingTrigger 构造的触发回调（看门狗降级复用）

// 快捷键异常的用户可见提示：系统通知（Win/mac 均支持）。失败只落日志，绝不抛出。
function notifyHotkeyIssue(title, body) {
  try {
    new Notification({ title, body, silent: false }).show();
  } catch (e) {
    logger.warn('快捷键提示通知发送失败:', e?.message || e);
  }
}

// 降级可见性：把当前生效的录音键写进托盘 tooltip（悬停即见，比一次性通知更难被错过）。
// 托盘尚未创建（启动早期降级）时此处为 no-op，startApp 里创建托盘后会补一次。
function updateTrayHotkeyTooltip(text) {
  try {
    if (trayManager && trayManager.tray && !trayManager.tray.isDestroyed()) {
      trayManager.tray.setToolTip(`弦外小猫 · ${text}`);
    }
  } catch (e) {
    logger.warn('更新托盘 tooltip 失败:', e?.message || e);
  }
}

// 主触发（uiohook 裸修饰键 / 自定义组合键）注册失败时的降级：
// 依次尝试兜底组合键，成功 → 系统通知告知新键位；全部失败 → 系统通知引导去设置改键。
// 绝不静默失效。
function registerFallbackRecordingHotkey(fire, reason) {
  for (const accel of FALLBACK_RECORDING_ACCELERATORS) {
    try {
      if (hotkeyManager.registerHotkey(accel, fire)) {
        recordingFallbackAccel = accel;
        logger.warn(`录音触发键已降级为兜底组合键 ${accel}（当前生效键=${accel}）`, { reason });
        updateTrayHotkeyTooltip(`录音快捷键已临时改为 ${accel}`);
        notifyHotkeyIssue(
          '弦外小猫：快捷键已自动切换',
          `原快捷键不可用（${reason}），已临时改用 ${accel} 唤起录音。可到「设置 → 快捷键」改回喜欢的键。`
        );
        return true;
      }
    } catch (e) {
      logger.warn('注册兜底快捷键失败', { accel, error: e?.message || e });
    }
  }
  logger.error('所有兜底快捷键均注册失败，录音快捷键当前不可用', { reason });
  updateTrayHotkeyTooltip('录音快捷键不可用，请到「设置 → 快捷键」更换');
  notifyHotkeyIssue(
    '弦外小猫：快捷键不可用',
    `快捷键注册失败（${reason}），请到「设置 → 快捷键」更换其它按键。`
  );
  return false;
}

// 设置录音触发（默认：mac 单击左 Option / Windows 双击左 Alt；裸修饰键经 uiohook 监听）
function setupRecordingTrigger() {
  try {
    const platformDefault = process.platform === 'win32'
      ? { type: 'modifier-tap', key: 'LeftAlt', taps: 2 }
      : { type: 'modifier-tap', key: 'LeftOption', taps: 1 };
    const stored = databaseManager.getSetting('recording_trigger', null);
    // 修复误判：validateRecordingTrigger 校验通过时返回的是"重建的新对象"，
    // 旧代码用 `trigger !== stored`（对象恒不等）判定非法 → 合法存值也被警告。
    // 现改为：校验用 null 哨兵，返回 null 才是真非法/缺失。
    let trigger = validateRecordingTrigger(stored, null);
    if (!trigger) {
      if (stored != null) {
        logger.warn('recording_trigger 非法，已回退默认', { stored });
      }
      trigger = platformDefault;
    }

    const fire = () => {
      // 仅在"开始录音"的那一次触发去定位+显示胶囊。
      // 修复回归：之前每次触发（含"结束键"那一次）都会重新 showRecorderAtBottom，
      // 结束键那一拍会把正在被隐藏的胶囊重新定位（可能落到别的显示器/屏幕外）并重显，
      // 与隐藏竞态 → 表现为"唤醒后胶囊自己消失"。结束/取消时不再重定位胶囊。
      if (!isRecording) {
        // 定位到焦点输入框下方（跟随焦点）或屏幕底部居中，再显示（不抢焦点）。
        windowManager.showRecorderAtBottom();
      }
      const win = windowManager.mainWindow;
      if (win && !win.isDestroyed()) {
        win.webContents.send('hotkey-triggered', { trigger });
        logger.info('录音触发 → 已发送 hotkey-triggered', trigger);
      }
    };
    recordingFire = fire; // 供 uiohook 看门狗降级时复用（不重复构造触发逻辑）

    // 先清掉旧的触发（便于设置变更后重载）；上次的兜底组合键/用户组合键也一并注销，避免残留双触发。
    triggerManager.stop();
    if (recordingFallbackAccel) {
      try { hotkeyManager.unregisterHotkey(recordingFallbackAccel); } catch (_) { /* 忽略 */ }
      recordingFallbackAccel = null;
    }
    if (recordingCurrentAccel) {
      try { hotkeyManager.unregisterHotkey(recordingCurrentAccel); } catch (_) { /* 忽略 */ }
      recordingCurrentAccel = null;
    }

    if (trigger.type === 'accelerator' && trigger.accelerator) {
      // 普通组合键走 Electron globalShortcut；被其他应用占用时降级到兜底键并通知，绝不静默失效。
      const ok = hotkeyManager.registerHotkey(trigger.accelerator, fire);
      if (ok) {
        recordingCurrentAccel = trigger.accelerator;
        logger.info('录音触发使用组合键', trigger.accelerator);
      } else {
        logger.error('[trigger] 组合键注册失败（可能被其他应用占用）:', trigger.accelerator);
        registerFallbackRecordingHotkey(fire, `组合键 ${trigger.accelerator} 被占用`);
      }
    } else {
      // 裸修饰键走 uiohook；uiohook 启动失败（权限/钩子异常）时降级到组合键并通知。
      const ok = triggerManager.start(trigger, fire);
      if (!ok) {
        logger.error('[trigger] uiohook 启动失败，尝试降级到兜底组合键');
        registerFallbackRecordingHotkey(fire, '系统级按键监听启动失败');
      }
    }
  } catch (error) {
    logger.error('设置录音触发失败:', error);
  }
}

// ============================================================================
// uiohook 事件流看门狗（仅 win32）——治「已启动却零触发」的静默失聪
// 证据链：v1.18.0 Win11 真机日志有 "triggerManager 已启动" 但 13 分钟无一条
// "triggerManager 触发"。uIOhook.start() 成功只代表钩子线程起来了；Windows 的
// WH_KEYBOARD_LL 钩子可能随后被系统静默摘除（回调超时/登录期负载/会话异常），
// 原生层与 JS 层的 running 标志都不会翻转，没有任何错误可捕获。
// 检测法：powerMonitor.getSystemIdleTime()（走 GetLastInputInfo，完全独立于 uiohook）
// 表明用户正在输入（idle ≤ 5s），而 uiohook 已 ≥ 60s 收不到任何事件（含鼠标移动）
// → 判定钩子失聪。第一次先原地重启钩子；下一轮复查仍失聪 → 降级到兜底组合键
// （globalShortcut，独立机制，不受 LL 钩子影响）+ 系统通知 + 托盘 tooltip。
// 误报防护：正常时 uiohook 连鼠标移动都收得到，「用户活跃但 60 秒零事件」在钩子
// 存活时几乎不可能；即便极端误报，重启钩子也无害，降级还会先复查一轮。
// ============================================================================
let uiohookWatchdogTimer = null;
let uiohookRestartAttempted = false;
const UIOHOOK_WATCHDOG_INTERVAL_MS = 30000; // 检查周期
const UIOHOOK_DEAD_SILENCE_MS = 60000;      // 判定失聪的静默阈值
const UIOHOOK_ACTIVE_IDLE_SEC = 5;          // "用户正在活动"的系统空闲上限

function startUiohookWatchdog() {
  if (process.platform !== 'win32') return; // mac 权限缺失在 start() 即抛错，另有降级路径
  if (uiohookWatchdogTimer) return;
  const { powerMonitor } = require('electron');
  uiohookWatchdogTimer = setInterval(() => {
    try {
      // 录音触发未走 uiohook（组合键模式/已降级）→ 无需监护
      if (!triggerManager.started) return;
      const silenceMs = Date.now() - TriggerManager.hookLastInputAt();
      if (silenceMs < UIOHOOK_DEAD_SILENCE_MS) {
        uiohookRestartAttempted = false; // 事件流健康/已恢复，允许未来再次自救
        return;
      }
      if (powerMonitor.getSystemIdleTime() > UIOHOOK_ACTIVE_IDLE_SEC) return; // 用户没在动，静默正常
      // 用户明明在输入，钩子却长时间零事件 → 失聪
      if (!uiohookRestartAttempted) {
        uiohookRestartAttempted = true;
        logger.error(`uiohook 事件流疑似中断（用户活跃但 ${Math.round(silenceMs / 1000)}s 无钩子事件），尝试重启钩子`);
        TriggerManager.tryRestartHook(logger);
        return; // 下一轮复查重启效果
      }
      // 重启无效：停止监护，降级到 globalShortcut 兜底键（可见通知 + 托盘提示）
      logger.error('uiohook 重启后事件流仍中断，录音键降级到兜底组合键');
      clearInterval(uiohookWatchdogTimer);
      uiohookWatchdogTimer = null;
      triggerManager.stop();
      if (typeof recordingFire === 'function') {
        registerFallbackRecordingHotkey(recordingFire, '系统级按键监听失效（事件流中断）');
      }
    } catch (e) {
      logger.warn('uiohook 看门狗检查异常（忽略本轮）:', e?.message || e);
    }
  }, UIOHOOK_WATCHDOG_INTERVAL_MS);
  logger.info('uiohook 事件流看门狗已启动（win32）');
}

// 设置变更后重载触发键（自定义快捷键时调用）
ipcMain.handle('reload-recording-trigger', () => {
  setupRecordingTrigger();
  return { success: true };
});

// ===== 唤醒键自定义：主进程侧校验 + 冲突检测 + 应用（渲染层只发候选键） =====
// Electron accelerator 的纯修饰符 token（无效组合 = 只有修饰键 / 空）
const ACCEL_MODIFIER_TOKENS = new Set([
  'command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl',
  'alt', 'option', 'altgr', 'shift', 'super', 'meta',
]);

function acceleratorHasBaseKey(accel) {
  const parts = String(accel).split('+').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.some((p) => !ACCEL_MODIFIER_TOKENS.has(p.toLowerCase()));
}

function recordingTriggersEqual(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'modifier-tap') return a.key === b.key && Number(a.taps) === Number(b.taps);
  if (a.type === 'accelerator') return String(a.accelerator).toLowerCase() === String(b.accelerator).toLowerCase();
  return false;
}

// 应用内冲突：与「转英文」触发键 / 「取消」键重复则拒绝。返回冲突描述或 null。
function findWakeTriggerInternalConflict(trigger) {
  try {
    const tt = databaseManager.getSetting('translate_trigger', null);
    if (tt && recordingTriggersEqual(trigger, tt)) return '该快捷键已被「转英文」功能使用';
    const cancelKey = databaseManager.getSetting('cancel_key', 'Escape');
    const cancelTaps = Number(databaseManager.getSetting('cancel_taps', 1)) === 2 ? 2 : 1;
    if (trigger.type === 'modifier-tap' && trigger.key === cancelKey && Number(trigger.taps) === cancelTaps) {
      return '该快捷键已被「取消」功能使用';
    }
    if (trigger.type === 'accelerator' && String(trigger.accelerator).toLowerCase() === String(cancelKey).toLowerCase()) {
      return '该按键已被「取消」功能使用';
    }
  } catch (e) {
    logger.warn('唤醒键应用内冲突检测异常（忽略，继续）:', e?.message || e);
  }
  return null;
}

// 校验并应用唤醒快捷键：无效组合/应用内冲突/被其它软件占用 → 拒绝并保持原设置生效。
ipcMain.handle('apply-recording-trigger', (event, candidate) => {
  try {
    const trigger = validateRecordingTrigger(candidate, null);
    if (!trigger) return { success: false, error: '无效的快捷键组合' };
    if (trigger.type === 'accelerator' && !acceleratorHasBaseKey(trigger.accelerator)) {
      return { success: false, error: '快捷键不能只有修饰键，请加上一个普通按键' };
    }

    const prevStored = databaseManager.getSetting('recording_trigger', null);
    // 与当前设置相同 → 无需变更（也避免试注册撞上自己已注册的键）
    if (recordingTriggersEqual(trigger, validateRecordingTrigger(prevStored, null))) {
      return { success: true, trigger, unchanged: true };
    }

    const conflict = findWakeTriggerInternalConflict(trigger);
    if (conflict) return { success: false, error: conflict };

    // 系统级冲突：组合键先试注册（成功立即释放）。失败 = 被其它软件占用 → 拒绝，原键保持生效。
    // 例外：该键恰是当前生效的兜底键/用户键（本应用自己持有），放行交给 setupRecordingTrigger 正常接管。
    if (trigger.type === 'accelerator'
        && trigger.accelerator !== recordingFallbackAccel
        && trigger.accelerator !== recordingCurrentAccel) {
      let probeOk = false;
      try {
        probeOk = globalShortcut.register(trigger.accelerator, () => {});
      } finally {
        if (probeOk) {
          try { globalShortcut.unregister(trigger.accelerator); } catch (_) { /* 忽略 */ }
        }
      }
      if (!probeOk) {
        logger.warn('唤醒键试注册失败（被占用），保持原设置', { accelerator: trigger.accelerator });
        return { success: false, error: `快捷键 ${trigger.accelerator} 已被系统或其他软件占用，请换一个` };
      }
    }

    // 持久化并重载；重载后验证是否真正生效，失败则回滚到旧设置（旧键继续生效）。
    databaseManager.setSetting('recording_trigger', trigger);
    setupRecordingTrigger();
    const applied = trigger.type === 'accelerator'
      ? hotkeyManager.isHotkeyRegistered(trigger.accelerator)
      : triggerManager.started;
    if (!applied) {
      if (prevStored != null) databaseManager.setSetting('recording_trigger', prevStored);
      setupRecordingTrigger();
      logger.error('唤醒键应用失败，已回滚原设置', { trigger });
      return { success: false, error: '快捷键注册失败（可能缺少辅助功能权限或被占用），已保持原设置' };
    }
    logger.info('唤醒键已更新并生效', trigger);
    return { success: true, trigger };
  } catch (error) {
    logger.error('apply-recording-trigger 异常:', error);
    return { success: false, error: '快捷键设置失败：' + (error?.message || String(error)) };
  }
});

// 「转英文」热键处理：捕获选中文本 → 翻译为地道英文 → 粘贴回去。
// 录音中或上一次仍在进行时直接跳过。全程在主进程编排，串行防风暴。
async function handleTranslateHotkey() {
  const sendTranslateStatus = (phase, extra = {}) => {
    try {
      const w = windowManager.mainWindow;
      if (w && !w.isDestroyed()) w.webContents.send('translate-status', { phase, ...extra });
    } catch (_) {}
  };
  const hidePillLater = (ms) => setTimeout(() => { try { windowManager.hideMainWindow(); } catch (_) {} }, ms);
  logger.info('转英文快捷键触发');
  if (isRecording || isBusy) return; // 录音会话中(含处理/润色阶段)不触发转英文
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

// 判断「转英文」触发器是否为关闭状态：type==='none' 或 falsy/无效值一律视为关闭。
function isTranslateTriggerDisabled(t) {
  if (!t || typeof t !== 'object') return true;
  if (t.type === 'none') return true;
  // 仅 modifier-tap / accelerator 两种有效类型；其余（含空对象）视为关闭。
  if (t.type === 'modifier-tap' || t.type === 'accelerator') return false;
  return true;
}

// 设置「转英文」触发键（默认关闭；有效值时按 modifier-tap/accelerator 挂载）。
function setupTranslateTrigger() {
  try {
    // 关闭态默认：新装默认 { type: 'none' }（见 database.js 播种默认值）。
    const stored = databaseManager.getSetting('translate_trigger', { type: 'none' });

    // 关闭态（type:'none'/null/空/无效）：不注册触发器，并确保先停掉之前可能注册的。
    if (isTranslateTriggerDisabled(stored)) {
      translateTriggerManager.stop();
      logger.info('转英文触发器已关闭（translate_trigger 为无/无效）');
      return;
    }

    const fallback = { type: 'modifier-tap', key: 'LeftCtrl', taps: 2 };
    // 复用录音触发键的校验：非法字段一律回退默认。
    // 同 recording_trigger 的误判修复：用 null 哨兵判定，而非对象身份比较（恒不等）。
    let trigger = validateRecordingTrigger(stored, null);
    if (!trigger) {
      logger.warn('translate_trigger 非法，已回退默认', { stored });
      trigger = fallback;
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
    // 切皮肤时同步调整窗口高度：cat/catfx 需要更高窗口承载头顶特效。
    windowManager.setPillHeightForSkin(skin);
    const w = windowManager.mainWindow;
    if (w && !w.isDestroyed()) w.webContents.send('pill-skin-changed', { skin });
    return { success: true, skin };
  } catch (e) {
    return { success: false, error: String(e && e.message || e) };
  }
});

// 开机启动：读取设置并应用到系统登录项（老用户库里无该键时按 true 处理）。
// 仅打包版真正调用 setLoginItemSettings——dev 模式会把 Electron 开发二进制注册成登录项，绝不允许；dev 下只存值不注册。
function applyLaunchAtLogin() {
  const enabled = databaseManager.getSetting('launch_at_login', true) !== false;
  if (!app.isPackaged) {
    logger.info('开发模式：跳过登录项注册（仅保存设置）', { enabled });
    return enabled;
  }
  app.setLoginItemSettings({ openAtLogin: enabled });
  logger.info('已应用开机启动设置', { enabled });
  return enabled;
}

// 设置里切换「开机启动」后立即应用（渲染层 setSetting 持久化后调用）
ipcMain.handle('reload-launch-at-login', () => {
  try {
    const enabled = applyLaunchAtLogin();
    return { success: true, enabled };
  } catch (e) {
    return { success: false, error: String((e && e.message) || e) };
  }
});

// 托盘图标样式变更后实时刷新托盘（设置-皮肤下方「托盘图标」切换时调用）
ipcMain.handle('reload-tray-icon', () => {
  try {
    const style = databaseManager.getSetting('tray_icon_style', 'smile');
    if (trayManager && typeof trayManager.rebuildTray === 'function') {
      trayManager.rebuildTray();
    }
    return { success: true, style };
  } catch (e) {
    return { success: false, error: String((e && e.message) || e) };
  }
});

// 隐藏胶囊（粘贴完成 / 取消后由渲染层调用）
ipcMain.handle('hide-recorder', () => {
  windowManager.hideMainWindow();
  // 会话正常结束点（pipeline 完成/失败/取消的 finally 中由渲染层调用）：
  // 统一交给 endSession() 释放 Esc、重挂转英文（幂等，不会与 fireCancel 重复执行）。
  endSession();
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
  // Esc 取消即会话结束：幂等收口（与 hide-recorder 两路只生效一次）。
  endSession();
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

// 会话真正结束（胶囊隐藏）时调用一次：幂等。把会话级清理统一收口在此，
// 避免 hide-recorder 与 fireCancel 两路重复执行 unregisterCancelKey / setupTranslateTrigger。
// 含义：处理阶段(转写/润色)期间不会被调用，从而保持转英文停用 + 取消键注册，
// 杜绝处理阶段误触转英文/取消导致胶囊被抢占或隐藏。
function endSession() {
  if (!isBusy) return; // 幂等：已结束则直接返回
  isBusy = false;
  unregisterCancelKey();
  // 会话结束后重新挂回转英文触发器。
  try {
    setupTranslateTrigger();
  } catch (_) { /* 忽略 */ }
}

// 渲染层在录音开始/结束时通知主进程，用于按需注册/注销 Esc 取消键
ipcMain.on('recorder-state', (event, recording) => {
  // 记录录音状态：转英文键在录音中让位（见 handleTranslateHotkey）。
  isRecording = !!recording;
  if (recording) {
    // 会话开始：覆盖 recording + 后续处理/润色阶段，直到胶囊隐藏才结束。
    // 每次新录音都重置 isBusy=true，确保 isBusy 不会因上次异常而卡死。
    isBusy = true;
    recordStartedAt = Date.now();
    registerCancelKey();
    // 录音期间转英文键必须让位：停掉转英文触发器，避免裸修饰键被双重监听。
    // 仅在应用完成初始化（触发器已挂载）后才停用，避免早期/边缘的 recorder-state(true) 误调用。
    if (appFullyInitialized) {
      try { translateTriggerManager.stop(); } catch (_) {}
    }
  } else {
    // 录音停止≠会话结束：此时进入处理(转写/润色)阶段，胶囊仍在渲染层显示。
    // 只把 isRecording 置 false；不在此 unregisterCancelKey、不在此重挂转英文。
    // 会话级清理统一交由 endSession()（在 hide-recorder / fireCancel 处调用）。
  }
});

// 初始化数据库：损坏/锁定等同步异常会在任何窗口出现前崩主进程，
// 这里捕获后弹出可见错误对话框并干净退出，避免静默崩溃（DB-1）。
const dataDirectory = environmentManager.ensureDataDirectory();
try {
  earlyLog("初始化 better-sqlite3 数据库", { dataDirectory });
  databaseManager.initialize(dataDirectory);
  earlyLog("数据库初始化成功");
} catch (error) {
  earlyLog("数据库初始化失败（better-sqlite3 运行期错误）",
    String(error && error.stack ? error.stack : error));
  logger.error("数据库初始化失败:", error);
  try {
    dialog.showErrorBox(
      "弦外小猫 启动失败",
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
  llmManager,
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

// ============================================================================
// macOS 麦克风权限（打包版关键修复）
// 打包版（hardenedRuntime + 新 bundle id）此前从不主动申请系统麦克风权限，
// 仅靠渲染层 getUserMedia，导致从未触发系统 TCC 授权框 → 静默无音。
// 这里在主进程侧：①记录当前麦克风授权状态 ②主动调用 askForMediaAccess 弹系统授权框。
// 全程 try/catch，绝不因权限流程崩主进程。
// ============================================================================
async function ensureMicrophoneAccess() {
  if (process.platform !== 'darwin') return;
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    logger.info('麦克风权限当前状态', { status });
    earlyLog('麦克风权限当前状态', { status });
    // 无论状态如何都尝试申请：未决定(not-determined)会弹系统框；已授权/已拒绝则立即返回。
    const granted = await systemPreferences.askForMediaAccess('microphone');
    logger.info('askForMediaAccess(microphone) 结果', { granted });
    earlyLog('askForMediaAccess(microphone) 结果', { granted });
  } catch (e) {
    logger.error('申请麦克风权限失败（不影响启动）:', e);
    earlyLog('申请麦克风权限失败', String(e && e.stack ? e.stack : e));
  }
}

// 为所有窗口的默认 session 放行 media/microphone 权限请求（渲染层 getUserMedia 需要）。
// 仅放行麦克风/媒体相关权限，其余权限保持默认（拒绝），不放开无关权限。
function setupMediaPermissionHandlers() {
  const isMediaPermission = (permission) =>
    permission === 'media' || permission === 'microphone' || permission === 'audioCapture';
  try {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      if (isMediaPermission(permission)) {
        callback(true);
        return;
      }
      // 其余权限保持原有/默认行为：拒绝（不放开无关权限）。
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      return isMediaPermission(permission);
    });
    logger.info('已为 defaultSession 设置媒体/麦克风权限处理器');
  } catch (e) {
    logger.error('设置媒体权限处理器失败（不影响启动）:', e);
    earlyLog('设置媒体权限处理器失败', String(e && e.stack ? e.stack : e));
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

  // Windows/Linux 完全去掉应用菜单栏（REQ-2）：设置/历史/控制面板窗口不再出现 File/Edit/View。
  // Windows 上 Ctrl+C/V 等编辑快捷键由 Chromium/系统原生处理，不依赖菜单，置空无副作用；
  // macOS 绝不能动应用菜单（Cmd+C/V 依赖它），故仅非 darwin 生效。
  if (process.platform !== "darwin") {
    try {
      Menu.setApplicationMenu(null);
    } catch (e) {
      logger.error("移除应用菜单失败:", e);
    }
  }

  // 清理上次异常退出残留的临时音频
  cleanupOrphanTempAudio();

  // 应用「开机启动」设置（默认开；打包版才真正注册登录项）
  try {
    applyLaunchAtLogin();
  } catch (error) {
    logger.error('应用开机启动设置失败:', error);
  }

  // ⚡ 唤醒键即时生效：在任何重活（开发模式等待 Vite、FunASR 启动、窗口/托盘创建）之前
  // 就先注册全局热键并 uIOhook.start()。原生钩子需要约 0.5–2s 预热，越早启动越早接管，
  // 否则启动头几秒的按键会落空（根因：此前在窗口/托盘创建之后才注册）。
  // 依赖说明：databaseManager 已在模块加载阶段同步 initialize（见上方 567 行），
  // 故此处 getSetting 安全；fire 回调对 mainWindow 为空已做空判，早按不显示胶囊但按键不丢。
  try {
    logger.info('⚡ 提前注册全局录音/转英文触发键（启动即生效）...');
    setupRecordingTrigger();
    setupTranslateTrigger();
    // 触发器已挂载：允许 recorder-state 在录音时停用转英文触发器
    appFullyInitialized = true;
    logger.info('⚡ 全局触发键已提前就绪');
  } catch (error) {
    logger.error('提前注册全局触发键失败（稍后窗口就绪后行为不变）:', error);
  }

  // win32：启动 uiohook 事件流看门狗（检测"已启动却零触发"的钩子静默失聪并自救/降级）
  try {
    startUiohookWatchdog();
  } catch (error) {
    logger.error('启动 uiohook 看门狗失败（不影响其余功能）:', error);
  }

  // 打包版麦克风修复：放行渲染层 getUserMedia 的权限请求，并主动触发系统麦克风授权框。
  setupMediaPermissionHandlers();
  // 不 await：授权框弹出/用户点选不阻塞后续启动流程。
  ensureMicrophoneAccess();

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

  // 本地 LLM 预热：若当前润色引擎为本地且模型就绪，后台预加载该引擎（不阻塞启动）。
  // 失败不影响启动；真正润色时会再按需拉起并暴露错误。
  (async () => {
    try {
      const engine = await databaseManager.getSetting('polish_engine', 'cloud');
      if (typeof engine === 'string' && engine.startsWith('local-') && llmManager.isModelReady(engine)) {
        logger.info('后台预热本地 LLM 引擎', { engine });
        llmManager.ensureEngine(engine).catch((e) => logger.warn('本地 LLM 预热失败', e?.message || e));
      }
    } catch (e) {
      logger.warn('本地 LLM 预热跳过', e?.message || e);
    }
  })();

  // Windows：空闲时预热常驻 SendKeys worker（拉起隐藏 PowerShell + ping），
  // 首次粘贴不吃冷启动延迟；失败不影响启动，首次粘贴时会自动重试懒启动。
  if (process.platform === "win32") {
    setTimeout(() => {
      try {
        clipboardManager.prewarmWindowsWorker();
      } catch (e) {
        logger.warn('SendKeys worker 预热失败', e?.message || e);
      }
    }, 2500);
  }

  // 安装后静默下载本地 4B 模型：默认引擎为云端AI，用户可立即使用；4B 在后台自动补齐。
  // 已就绪 / 正在下载则跳过；失败一律吞掉并 log，绝不崩主进程；断点续传由 llmManager 内部处理。
  (async () => {
    try {
      const engine = 'local-4b';
      if (llmManager.isModelReady(engine)) return;
      const status = llmManager.getModelsStatus && llmManager.getModelsStatus()[engine];
      if (status && status.downloading) return;
      logger.info('后台静默下载本地 4B 模型…');
      const r = await llmManager.downloadModel(engine, (progress) => {
        // 复用现有进度事件，供模型 tab 显示；不主动弹窗打扰。
        try {
          const win = windowManager.mainWindow;
          if (win && !win.isDestroyed()) win.webContents.send('local-model-download-progress', progress);
        } catch (e) { /* 忽略 */ }
      });
      if (r && r.success) logger.info('本地 4B 模型下载完成');
      else logger.warn('本地 4B 模型后台下载未完成', r && r.error);
    } catch (e) {
      logger.warn('本地 4B 模型后台下载异常（已忽略，不影响使用）', e?.message || e);
    }
  })();

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
        "弦外小猫 启动失败",
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
  // 注入数据库管理器，托盘据此读取 tray_icon_style（中笑/彩色）
  if (typeof trayManager.setDatabaseManager === "function") {
    trayManager.setDatabaseManager(databaseManager);
  }
  await trayManager.createTray();
  // 若启动早期已发生快捷键降级（当时托盘还不存在），此刻补写托盘 tooltip，保证降级可见
  if (recordingFallbackAccel) {
    updateTrayHotkeyTooltip(`录音快捷键已临时改为 ${recordingFallbackAccel}`);
  }
  // 注入提醒回调：aiService 需要提醒时让托盘闪烁+点击弹通知（额度降级/阶梯提醒）
  if (ipcHandlers && ipcHandlers.aiService && typeof ipcHandlers.aiService.setNotifier === 'function') {
    ipcHandlers.aiService.setNotifier((payload) => trayManager.startAttention(payload));
  }
  logger.info('系统托盘设置完成');

  // 全局录音/转英文触发键已在 startApp 顶部提前注册（启动即生效），此处不再重复注册。

  // 安装后首次启动：自动打开「设置-权限」页一次，引导用户授予权限。
  // 仅首启触发（onboarding_completed=false 时）；弹出后立即把标志持久化为 true，确保下次启动不再自动弹。
  try {
    const onboardingDone = databaseManager.getSetting('onboarding_completed', false);
    if (onboardingDone !== true) {
      logger.info('首次启动：自动打开设置-权限页');
      windowManager.showSettingsWindow('permissions');
      // 先持久化标志，避免「弹窗成功但写入失败 → 每次都弹」的回归。
      databaseManager.setSetting('onboarding_completed', true);
    }
  } catch (error) {
    logger.error('首启引导（自动打开权限页）失败:', error);
  }

  // 启动静默检查更新（免签名）：延迟数秒、不阻塞启动、失败静默。
  // 有新版则发系统通知提示（不强制、不打扰）；关于页可手动「检查更新」并下载安装。
  setTimeout(() => {
    (async () => {
      try {
        const updater = require('./src/helpers/updater');
        const res = await updater.checkForUpdate({ logger });
        if (res && res.hasUpdate) {
          logger.info('检测到新版本', { latest: res.latest, current: res.current });
          try {
            const title = res.mandatory
              ? `弦外小猫有重要更新 v${res.latest}`
              : `弦外小猫有新版本 v${res.latest}`;
            const body = res.mandatory
              ? '建议尽快更新。可在「设置 → 关于」点击「立即更新」。'
              : '可在「设置 → 关于」点击「检查更新」查看并升级。';
            new Notification({ title, body, silent: false }).show();
          } catch (e) {
            logger.warn('更新通知发送失败:', e?.message || e);
          }
        }
      } catch (e) {
        logger.warn('启动静默检查更新失败（已忽略）:', e?.message || e);
      }
    })();
  }, 8000);

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
  // 强杀本地 LLM 子进程，杜绝孤儿
  try {
    llmManager.killServerSync();
  } catch (error) {
    logger.error('关闭本地 LLM 失败:', error);
  }
  // 关闭 Windows 常驻 SendKeys worker（mac/linux 为空操作），绝不留孤儿 PowerShell
  try {
    clipboardManager.killWinWorker();
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
  try { llmManager.killServerSync(); } catch (e) { /* 忽略 */ }
  try { clipboardManager.killWinWorker(); } catch (e) { /* 忽略 */ }
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