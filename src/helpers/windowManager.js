const { BrowserWindow } = require("electron");
const path = require("path");
const { execFile } = require("child_process");

// 取前台焦点窗口位置/尺寸的超时（毫秒）：放宽到 1500ms，避免 osascript 偶发卡顿被 SIGKILL
// 后误回退到光标屏（胶囊"跟随鼠标"）。超时/失败时优先复用上次成功的焦点屏。
const FOCUS_QUERY_TIMEOUT_MS = 1500;

// 胶囊距屏幕底部的偏移（像素）。
const BOTTOM_OFFSET_PX = 24;

// 「跟随焦点」时读取焦点输入框 AX 位置/尺寸的超时（毫秒）：比窗口查询更短，
// 让整条 show 链路控制在 ~800ms 内，超时直接走光标/底部兜底，绝不阻塞唤起。
const FOCUS_FIELD_TIMEOUT_MS = 700;

// 胶囊与焦点输入框（或鼠标点）之间的竖直间距（像素）。
const FIELD_GAP_PX = 8;

class WindowManager {
  constructor(logger = null) {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.historyWindow = null;
    this.settingsWindow = null;
    this.logger = logger;
    // 上次成功解析到的「焦点窗口所在屏」：osascript 超时/失败时复用它，
    // 而不是立刻回退到光标屏（否则胶囊会"跟随鼠标"）。
    this._lastFocusDisplay = null;
    // 上次成功解析到的「焦点输入框锚点」（屏幕坐标，左上原点 + 尺寸）：
    // 用于平滑偶发的单次 AX 解析失败（保持简单：仅做缓存，不强依赖）。
    this._lastFocusPoint = null;
    // 数据库管理器（由 main.js 注入同一实例）：读取 pill_follow_focus 等设置。
    this.databaseManager = null;
  }

  // 注入数据库管理器（与 main.js 使用同一实例）。胶囊定位需读 pill_follow_focus。
  setDatabaseManager(databaseManager) {
    this.databaseManager = databaseManager;
  }

  // 窗口创建/展示链路的错误统一记录（SF-3）：有 logger 用 logger，否则回退 console。
  _logError(message, error) {
    if (this.logger && this.logger.error) {
      this.logger.error(message, error);
    } else {
      console.error(message, error);
    }
  }

  // Windows 可见窗口（设置/历史/控制面板）的窗口与任务栏图标：仅 win32 返回彩色 .ico 路径。
  // 解析方式与托盘一致：开发期取项目内 assets/，打包后取 process.resourcesPath/assets。
  _winIconOption() {
    if (process.platform !== "win32") return {};
    const isDev = process.env.NODE_ENV === "development";
    const iconPath = isDev
      ? path.join(__dirname, "..", "..", "assets", "icon.ico")
      : path.join(process.resourcesPath, "assets", "icon.ico");
    return { icon: iconPath };
  }

  async createMainWindow() {
    if (this.mainWindow) {
      this.mainWindow.focus();
      return this.mainWindow;
    }

    // 紧凑"胶囊"录音条：frameless + 透明 + 置顶 + 不抢焦点（避免抢走目标输入框的焦点导致粘贴失败）
    this.mainWindow = new BrowserWindow({
      width: 180,
      height: 44,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      movable: true,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        autoplayPolicy: "no-user-gesture-required",
        preload: path.join(__dirname, "..", "..", "preload.js"),
      },
    });

    // 浮于其他窗口之上：用 "floating"（标准悬浮工具窗层级）。
    // 之前用 "screen-saver"(层级 1000，高于菜单栏) + visibleOnFullScreen，在 macOS 上
    // 与透明/不可聚焦窗口组合时可能干扰系统事件路由，导致整屏输入卡死。floating 更安全，
    // 同样能浮在普通窗口之上，且不会盖过菜单栏/抢系统事件。
    try {
      this.mainWindow.setAlwaysOnTop(true, "floating");
      this.mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (e) {
      // 某些平台不支持时忽略
    }

    const isDev = process.env.NODE_ENV === "development";

    if (isDev) {
      await this.mainWindow.loadURL("http://localhost:5173");
    } else {
      await this.mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
    }

    this.mainWindow.on("closed", () => {
      this.mainWindow = null;
    });

    return this.mainWindow;
  }

  // 光标所在屏幕的 Display（任何失败/非 mac 场景的兜底）。
  _cursorDisplay() {
    const { screen } = require("electron");
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  // 取「前台焦点窗口」所在的 Display（macOS）。
  // 用 osascript 读取最前台进程的 front window 的 {position, size}，算出窗口中心点，
  // 再用 getDisplayNearestPoint 映射到对应显示器。带超时并 kill 进程，绝不阻塞唤醒。
  // 成功 → 缓存到 this._lastFocusDisplay 并返回。
  // 超时/解析失败/无窗口 → 复用上次成功的焦点屏（this._lastFocusDisplay），
  //   仅当从未取到过焦点屏时才回退光标屏（避免胶囊"跟随鼠标"）。
  // 非 macOS → 直接用光标屏。返回 Promise<Display>。
  getFocusDisplay() {
    if (process.platform !== "darwin") {
      return Promise.resolve(this._cursorDisplay());
    }

    return new Promise((resolve) => {
      let settled = false;
      // 超时/失败回退：优先复用上次成功的焦点屏；从未成功才退到光标屏。
      const fallback = () => {
        if (settled) return;
        settled = true;
        if (this._lastFocusDisplay) {
          return resolve(this._lastFocusDisplay);
        }
        try {
          resolve(this._cursorDisplay());
        } catch (e) {
          // screen 不可用时 resolve undefined，由调用方再兜底
          resolve(undefined);
        }
      };

      try {
        const { screen } = require("electron");
        const script =
          'tell application "System Events" to tell (first application process whose frontmost is true) to get {position, size} of front window';
        const child = execFile(
          "osascript",
          ["-e", script],
          { timeout: FOCUS_QUERY_TIMEOUT_MS, killSignal: "SIGKILL" },
          (error, stdout) => {
            if (settled) return;
            if (error) return fallback();
            try {
              // stdout 形如 "x, y, w, h"
              const nums = String(stdout)
                .trim()
                .split(",")
                .map((s) => Number(s.trim()));
              if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) {
                return fallback();
              }
              const [x, y, w, h] = nums;
              const cx = x + w / 2;
              const cy = y + h / 2;
              const focusDisplay = screen.getDisplayNearestPoint({ x: cx, y: cy });
              settled = true;
              // 缓存本次成功的焦点屏，供后续超时/失败时复用。
              this._lastFocusDisplay = focusDisplay;
              resolve(focusDisplay);
            } catch (e) {
              fallback();
            }
          }
        );
        child.on("error", fallback);
      } catch (e) {
        fallback();
      }
    });
  }

  // 把胶囊录音条放到指定屏幕（默认光标所在屏）的底部居中。
  // 每次唤起都重新定位，忽略用户手动移动。
  positionMainWindowBottomCenter(display) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    try {
      const target = display || this._cursorDisplay();
      const wa = target.workArea;
      const [w, h] = this.mainWindow.getSize();
      const x = Math.round(wa.x + (wa.width - w) / 2);
      const y = Math.round(wa.y + wa.height - h - BOTTOM_OFFSET_PX); // 距屏幕底部 24px
      this.mainWindow.setPosition(x, y);
    } catch (error) {
      // 定位失败不影响录音
    }
  }

  // 纯函数：把窗口矩形夹紧到 workArea 内（四边都不出界）。返回一个全新的矩形对象，不改入参。
  // rect / workArea 形如 { x, y, width, height }。
  clampRectToWorkArea(rect, workArea) {
    const maxX = workArea.x + workArea.width - rect.width;
    const maxY = workArea.y + workArea.height - rect.height;
    // 先保证不超过右/下边界，再保证不低于左/上边界（窗口比工作区大时优先贴左上）。
    const x = Math.round(Math.min(Math.max(rect.x, workArea.x), Math.max(workArea.x, maxX)));
    const y = Math.round(Math.min(Math.max(rect.y, workArea.y), Math.max(workArea.y, maxY)));
    return { x, y, width: rect.width, height: rect.height };
  }

  // 读取「跟随焦点」开关：默认 true。DB 不可用/异常时按 true 处理（与设置默认一致）。
  _isFollowFocusEnabled() {
    try {
      const dbm = this.databaseManager;
      if (!dbm || typeof dbm.getSetting !== "function") return true;
      return dbm.getSetting("pill_follow_focus", true) !== false;
    } catch (e) {
      return true;
    }
  }

  // STEP 1（macOS）：读「当前焦点输入框」的 AX 位置/尺寸，把胶囊放到输入框正下方居中。
  // 成功返回 true 并已 setBounds + 缓存锚点；任何失败（含 AX 权限被拒/0 尺寸）返回 false，由上层走下一兜底。
  // 时间盒 FOCUS_FIELD_TIMEOUT_MS，killSignal SIGKILL，绝不抛出、绝不阻塞唤起。
  _positionByFocusedField() {
    if (process.platform !== "darwin") return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      try {
        const { screen } = require("electron");
        const script = [
          'tell application "System Events"',
          "  set fp to first application process whose frontmost is true",
          '  set el to value of attribute "AXFocusedUIElement" of fp',
          '  set p to value of attribute "AXPosition" of el',
          '  set s to value of attribute "AXSize" of el',
          '  return ((item 1 of p) as integer) & "," & ((item 2 of p) as integer) & "," & ((item 1 of s) as integer) & "," & ((item 2 of s) as integer)',
          "end tell",
        ].join("\n");
        const child = execFile(
          "osascript",
          ["-e", script],
          { timeout: FOCUS_FIELD_TIMEOUT_MS, killSignal: "SIGKILL" },
          (error, stdout) => {
            if (settled) return;
            if (error) return done(false);
            try {
              if (!this.mainWindow || this.mainWindow.isDestroyed()) return done(false);
              const nums = String(stdout)
                .trim()
                .split(",")
                .map((s) => Number(s.trim()));
              // 校验 4 个有限数 + 宽度>0（防 AX 返回垃圾/0 尺寸元素）。
              if (nums.length < 4 || nums.some((n) => !Number.isFinite(n)) || nums[2] <= 0) {
                return done(false);
              }
              const [fx, fy, fw, fh] = nums;
              const anchorX = fx + fw / 2; // 输入框水平中心
              const anchorY = fy + fh; // 输入框底边
              const display = screen.getDisplayNearestPoint({ x: Math.round(anchorX), y: Math.round(anchorY) });
              const [w, h] = this.mainWindow.getSize();
              const rect = {
                x: Math.round(anchorX - w / 2),
                y: Math.round(anchorY + FIELD_GAP_PX),
                width: w,
                height: h,
              };
              const clamped = this.clampRectToWorkArea(rect, display.workArea);
              this.mainWindow.setBounds(clamped);
              // 缓存成功锚点，供平滑偶发单次失败用。
              this._lastFocusPoint = { x: anchorX, y: anchorY };
              done(true);
            } catch (e) {
              done(false);
            }
          }
        );
        child.on("error", () => done(false));
      } catch (e) {
        done(false);
      }
    });
  }

  // STEP 2：光标兜底（也是 Windows 在「跟随」开启时的主路径，AX 仅 macOS）。
  // 把胶囊放到鼠标点正下方居中，夹紧到光标屏 workArea。成功 true，失败 false。
  _positionByCursor() {
    try {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;
      const { screen } = require("electron");
      const pt = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(pt);
      const [w, h] = this.mainWindow.getSize();
      const rect = {
        x: Math.round(pt.x - w / 2),
        y: Math.round(pt.y + FIELD_GAP_PX),
        width: w,
        height: h,
      };
      const clamped = this.clampRectToWorkArea(rect, display.workArea);
      this.mainWindow.setBounds(clamped);
      return true;
    } catch (e) {
      return false;
    }
  }

  // 唤起前的胶囊定位（不含 show）。绝不抛出：任何异常最终回退到「焦点屏底部居中」。
  // 关闭跟随：保持原行为（焦点屏底部居中）。
  // 开启跟随：焦点输入框 → 鼠标点 → 焦点屏底部居中，逐级兜底。
  async positionPillForRecording() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    const follow = this._isFollowFocusEnabled();

    // 关闭跟随：严格保持原 off-path 行为，不做任何改动。
    if (!follow) {
      const display = await this.getFocusDisplay();
      this.positionMainWindowBottomCenter(display);
      return;
    }

    // 开启跟随：整段解析包在 try/catch，任何异常 → 底部居中兜底。
    try {
      // STEP 1：焦点输入框（macOS）。
      const placedByField = await this._positionByFocusedField();
      if (placedByField) return;

      // STEP 2：光标兜底（含 Windows 跟随路径）。
      if (this._positionByCursor()) return;

      // STEP 3：原行为——焦点屏底部居中。
      this.positionMainWindowBottomCenter(await this.getFocusDisplay());
    } catch (e) {
      try {
        this.positionMainWindowBottomCenter(await this.getFocusDisplay());
      } catch (_) {
        // 最终兜底也失败时静默：定位失败不影响录音。
      }
    }
  }

  // 唤起：先定位（跟随焦点/光标，或固定底部居中），再显示（不抢焦点）。
  // 定位链路全部时间盒 + try/catch，绝不阻塞或卡死整屏。
  async showRecorderAtBottom() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    try {
      await this.positionPillForRecording();
    } catch (e) {
      // positionPillForRecording 内部已兜底，这里再保险一层。
    }
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    try {
      this.mainWindow.showInactive();
    } catch (e) {
      // 忽略
    }
  }

  // 隐藏胶囊
  hideMainWindow() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.hide();
      } catch (e) {
        // 忽略
      }
    }
  }

  async createControlPanelWindow() {
    if (this.controlPanelWindow) {
      this.controlPanelWindow.focus();
      return this.controlPanelWindow;
    }

    this.controlPanelWindow = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      ...this._winIconOption(),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "..", "..", "preload.js"),
      },
    });

    const isDev = process.env.NODE_ENV === "development";

    if (isDev) {
      await this.controlPanelWindow.loadURL("http://localhost:5173?panel=control");
    } else {
      await this.controlPanelWindow.loadFile(
        path.join(__dirname, "..", "dist", "index.html"),
        { query: { panel: "control" } }
      );
    }

    this.controlPanelWindow.on("closed", () => {
      this.controlPanelWindow = null;
    });

    return this.controlPanelWindow;
  }

  async createHistoryWindow() {
    if (this.historyWindow) {
      this.historyWindow.focus();
      return this.historyWindow;
    }

    this.historyWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      show: false,
      title: "",
      alwaysOnTop: true,
      ...this._winIconOption(),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "..", "..", "preload.js"),
      },
    });

    const isDev = process.env.NODE_ENV === "development";

    if (isDev) {
      await this.historyWindow.loadURL("http://localhost:5173/history.html");
    } else {
      await this.historyWindow.loadFile(
        path.join(__dirname, "..", "dist", "history.html")
      );
    }

    this.historyWindow.on("closed", () => {
      this.historyWindow = null;
    });

    return this.historyWindow;
  }

  async createSettingsWindow() {
    if (this.settingsWindow) {
      this.settingsWindow.focus();
      return this.settingsWindow;
    }

    this.settingsWindow = new BrowserWindow({
      width: 700,
      height: 600,
      show: false,
      title: "",
      alwaysOnTop: true,
      ...this._winIconOption(),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "..", "..", "preload.js"),
      },
    });

    const isDev = process.env.NODE_ENV === "development";

    if (isDev) {
      await this.settingsWindow.loadURL("http://localhost:5173?page=settings");
    } else {
      await this.settingsWindow.loadFile(
        path.join(__dirname, "..", "dist", "settings.html")
      );
    }

    this.settingsWindow.on("closed", () => {
      this.settingsWindow = null;
    });

    return this.settingsWindow;
  }

  showControlPanel() {
    if (this.controlPanelWindow) {
      this.controlPanelWindow.show();
      this.controlPanelWindow.focus();
    } else {
      this.createControlPanelWindow()
        .then(() => {
          this.controlPanelWindow.show();
        })
        .catch((error) => this._logError("创建控制面板窗口失败:", error));
    }
  }

  hideControlPanel() {
    if (this.controlPanelWindow) {
      this.controlPanelWindow.hide();
    }
  }

  showHistoryWindow() {
    if (this.historyWindow) {
      this.historyWindow.show();
      this.historyWindow.focus();
      this.historyWindow.setAlwaysOnTop(true);
    } else {
      this.createHistoryWindow()
        .then(() => {
          this.historyWindow.show();
          this.historyWindow.focus();
          this.historyWindow.setAlwaysOnTop(true);
        })
        .catch((error) => this._logError("创建历史窗口失败:", error));
    }
  }

  hideHistoryWindow() {
    if (this.historyWindow) {
      this.historyWindow.hide();
    }
  }

  closeHistoryWindow() {
    if (this.historyWindow) {
      this.historyWindow.close();
    }
  }

  showSettingsWindow() {
    if (this.settingsWindow) {
      this.settingsWindow.show();
      this.settingsWindow.focus();
      this.settingsWindow.setAlwaysOnTop(true);
    } else {
      this.createSettingsWindow()
        .then(() => {
          this.settingsWindow.show();
          this.settingsWindow.focus();
          this.settingsWindow.setAlwaysOnTop(true);
        })
        .catch((error) => this._logError("创建设置窗口失败:", error));
    }
  }

  hideSettingsWindow() {
    if (this.settingsWindow) {
      this.settingsWindow.hide();
    }
  }

  closeSettingsWindow() {
    if (this.settingsWindow) {
      this.settingsWindow.close();
    }
  }

  closeAllWindows() {
    if (this.mainWindow) {
      this.mainWindow.close();
    }
    if (this.controlPanelWindow) {
      this.controlPanelWindow.close();
    }
    if (this.historyWindow) {
      this.historyWindow.close();
    }
    if (this.settingsWindow) {
      this.settingsWindow.close();
    }
  }
}

module.exports = WindowManager;