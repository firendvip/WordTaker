const { BrowserWindow } = require("electron");
const path = require("path");
const { execFile } = require("child_process");

// 取前台焦点窗口位置/尺寸的超时（毫秒）：osascript 偶发卡顿时也不能阻塞唤醒。
const FOCUS_QUERY_TIMEOUT_MS = 350;

// 胶囊距屏幕底部的偏移（像素）。
const BOTTOM_OFFSET_PX = 24;

class WindowManager {
  constructor(logger = null) {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.historyWindow = null;
    this.settingsWindow = null;
    this.logger = logger;
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
  // 再用 getDisplayNearestPoint 映射到对应显示器。带短超时并 kill 进程，绝不阻塞唤醒。
  // 任何失败/超时/无窗口/非 macOS → 回退到光标所在屏。返回 Promise<Display>。
  getFocusDisplay() {
    if (process.platform !== "darwin") {
      return Promise.resolve(this._cursorDisplay());
    }

    return new Promise((resolve) => {
      let settled = false;
      const fallback = () => {
        if (settled) return;
        settled = true;
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
              settled = true;
              resolve(screen.getDisplayNearestPoint({ x: cx, y: cy }));
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

  // 唤起：定位到「焦点窗口所在屏幕」底部并显示（不抢焦点）。
  // 焦点屏解析为异步（osascript），失败/超时回退光标屏；只在唤醒时定位，不跟随鼠标。
  async showRecorderAtBottom() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    let display;
    try {
      display = await this.getFocusDisplay();
    } catch (e) {
      display = undefined; // positionMainWindowBottomCenter 内再兜底光标屏
    }
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.positionMainWindowBottomCenter(display);
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