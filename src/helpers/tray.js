const { Tray, Menu, nativeImage, app, shell } = require("electron");
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
        // macOS 菜单栏：单色 template 猫头剪影（透明底 PNG，挖空眼睛；@2x 同目录时 Electron 自动选用）。
        // 文件名以 Template 结尾 + setTemplateImage(true)，macOS 自动按明暗菜单栏反色，深浅都可见。
        const catIconPath = this.getCatTrayIconPath();
        trayIcon = nativeImage.createFromPath(catIconPath);
        if (trayIcon.isEmpty()) {
          const msg = "托盘图标加载失败（图片为空）: " + catIconPath;
          if (this.logger && this.logger.error) {
            this.logger.error(msg);
          } else {
            console.error(msg);
          }
        }
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

  // macOS 单色 template 猫头托盘图标路径（@1x；同目录的 @2x 由 Electron 自动选用），dev/打包均可解析。
  // 资源随 assets/**/* 打进 app.asar，__dirname 在打包态为 .../app.asar/src/helpers，
  // 上跳两级即 .../app.asar/assets/cat-trayTemplate.png（nativeImage.createFromPath 可直读 asar），
  // dev 态 __dirname 为 .../ququ/src/helpers，同样上跳两级命中 .../ququ/assets/。故 dev/打包统一用 __dirname 相对路径。
  getCatTrayIconPath() {
    return path.join(__dirname, "..", "..", "assets", "cat-trayTemplate.png");
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
        label: "打开日志文件夹",
        click: () => {
          // 打开 userData/logs（早期 app.log 与崩溃日志所在目录），方便排查启动崩溃。
          try {
            const logDir = path.join(app.getPath("userData"), "logs");
            shell.openPath(logDir);
          } catch (error) {
            if (this.logger && this.logger.error) {
              this.logger.error("打开日志文件夹失败:", error);
            }
          }
        }
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          app.quit();
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