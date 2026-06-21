const { Tray, Menu, nativeImage } = require("electron");
const path = require("path");

class TrayManager {
  constructor(logger = null) {
    this.tray = null;
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.createControlPanelCallback = null;
    this.openSettings = null;
    this.openHistory = null;
    this.logger = logger;
  }

  setWindows(mainWindow, controlPanelWindow) {
    this.mainWindow = mainWindow;
    this.controlPanelWindow = controlPanelWindow;
  }

  setCreateControlPanelCallback(callback) {
    this.createControlPanelCallback = callback;
  }

  setOpenSettings(callback) {
    this.openSettings = callback;
  }

  setOpenHistory(callback) {
    this.openHistory = callback;
  }

  async createTray() {
    try {
      // 创建托盘图标
      const iconPath = this.getTrayIconPath();
      let trayIcon;
      
      if (process.platform === "darwin") {
        // macOS 菜单栏：代码生成透明底的单色波形模板图标（避免 SVG 渲染丢失透明度）
        trayIcon = this.buildWaveformTrayIcon();
        trayIcon.setTemplateImage(true);
      } else if (process.platform === "win32" && iconPath && require("fs").existsSync(iconPath)) {
        // Windows 托盘：彩色 .ico，缩放到 16px 并关闭模板图（否则会被渲染成单色）
        trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
        trayIcon.setTemplateImage(false);
      } else if (iconPath && require("fs").existsSync(iconPath)) {
        trayIcon = nativeImage.createFromPath(iconPath);
      } else {
        trayIcon = nativeImage.createEmpty();
      }

      this.tray = new Tray(trayIcon);
      this.tray.setToolTip("中文语音转文字");

      // 创建上下文菜单
      this.updateContextMenu();

      // 左/右键都弹出菜单（应用在后台常驻，平时不显示任何窗口）
      this.tray.on("click", () => {
        this.tray.popUpContextMenu();
      });
      this.tray.on("right-click", () => {
        this.tray.popUpContextMenu();
      });

    } catch (error) {
      if (this.logger && this.logger.error) {
        this.logger.error("创建托盘失败:", error);
      }
    }
  }

  // 生成透明底的极简波形托盘图标（模板图，菜单栏自动适配明暗）
  // 用 @2x 高清画布（44px）+ scaleFactor 2，使其在菜单栏按 22pt 显示——清晰且不过大。
  buildWaveformTrayIcon() {
    const S = 44;            // 物理像素画布（@2x）
    const buf = Buffer.alloc(S * S * 4, 0); // 全透明
    const bw = 6;            // 条宽（加粗，提升菜单栏可见度）
    const gap = 4;           // 条间距（收紧，整体更醒目）
    const heights = [20, 34, 28, 18]; // 4 条更高更实，菜单栏里更容易看到
    const totalW = heights.length * bw + (heights.length - 1) * gap;
    let x = Math.round((S - totalW) / 2);
    for (const h of heights) {
      const y0 = Math.round((S - h) / 2);
      for (let y = y0; y < y0 + h; y++) {
        for (let xx = x; xx < x + bw; xx++) {
          const i = (y * S + xx) * 4;
          buf[i + 3] = 255; // 仅 alpha（模板图）
        }
      }
      x += bw + gap;
    }
    return nativeImage.createFromBitmap(buf, { width: S, height: S, scaleFactor: 2 });
  }

  getTrayIconPath() {
    const isDev = process.env.NODE_ENV === "development";
    // macOS 菜单栏用单色模板图标（仅波形条、透明底）；Windows 用彩色 .ico；其它平台用 PNG 应用图标
    const iconFile = process.platform === "darwin"
      ? "trayTemplate.png"
      : process.platform === "win32"
        ? "icon.ico"
        : "icon.png";
    if (isDev) {
      return path.join(__dirname, "..", "..", "assets", iconFile);
    } else {
      return path.join(process.resourcesPath, "assets", iconFile);
    }
  }

  updateContextMenu() {
    if (!this.tray) return;

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "设置",
        click: () => {
          if (typeof this.openSettings === "function") this.openSettings();
        }
      },
      {
        label: "历史记录",
        click: () => {
          if (typeof this.openHistory === "function") this.openHistory();
        }
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          require("electron").app.quit();
        }
      }
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  setStatus(status) {
    if (!this.tray) return;

    switch (status) {
      case "recording":
        this.tray.setToolTip("正在录音...");
        break;
      case "processing":
        this.tray.setToolTip("正在处理...");
        break;
      case "ready":
      default:
        this.tray.setToolTip("中文语音转文字");
        break;
    }
  }
}

module.exports = TrayManager;