const { BrowserWindow } = require("electron");
const path = require("path");

class WindowManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.historyWindow = null;
    this.settingsWindow = null;
  }

  async createMainWindow() {
    if (this.mainWindow) {
      this.mainWindow.focus();
      return this.mainWindow;
    }

    // 紧凑"胶囊"录音条：frameless + 透明 + 置顶 + 不抢焦点（避免抢走目标输入框的焦点导致粘贴失败）
    this.mainWindow = new BrowserWindow({
      width: 200,
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

  // 把胶囊录音条放到"鼠标光标所在屏幕"的底部居中（每次唤起都重新定位，忽略用户手动移动）
  positionMainWindowBottomCenter() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    try {
      const { screen } = require("electron");
      const pt = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(pt);
      const wa = display.workArea;
      const [w, h] = this.mainWindow.getSize();
      const x = Math.round(wa.x + (wa.width - w) / 2);
      const y = Math.round(wa.y + wa.height - h - 24); // 距屏幕底部 24px
      this.mainWindow.setPosition(x, y);
    } catch (error) {
      // 定位失败不影响录音
    }
  }

  // 唤起：定位到光标所在屏幕底部并显示（不抢焦点）
  showRecorderAtBottom() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.positionMainWindowBottomCenter();
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
      title: "历史记录",
      alwaysOnTop: true,
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
      title: "设置",
      alwaysOnTop: true,
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
      this.createControlPanelWindow().then(() => {
        this.controlPanelWindow.show();
      });
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
      this.createHistoryWindow().then(() => {
        this.historyWindow.show();
        this.historyWindow.focus();
        this.historyWindow.setAlwaysOnTop(true);
      });
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
      this.createSettingsWindow().then(() => {
        this.settingsWindow.show();
        this.settingsWindow.focus();
        this.settingsWindow.setAlwaysOnTop(true);
      });
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