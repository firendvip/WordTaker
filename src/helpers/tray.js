const { Tray, Menu, nativeImage, app, shell } = require("electron");
const path = require("path");

class TrayManager {
  constructor(logger = null, databaseManager = null) {
    this.tray = null;
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.createControlPanelCallback = null;
    this.openSettings = null;
    this.openHistory = null;
    this.logger = logger;
    // 数据库管理器（用于读取 tray_icon_style 设置）；可后置注入
    this.databaseManager = databaseManager;
  }

  setDatabaseManager(databaseManager) {
    this.databaseManager = databaseManager;
  }

  // 读取托盘图标样式：'smile'（中笑镂空模板，默认）| 'color'（彩色猫头）
  getTrayIconStyle() {
    try {
      if (this.databaseManager && typeof this.databaseManager.getSetting === "function") {
        return this.databaseManager.getSetting("tray_icon_style", "smile");
      }
    } catch (error) {
      if (this.logger && this.logger.error) {
        this.logger.error("读取 tray_icon_style 失败，回退 smile:", error);
      }
    }
    return "smile";
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

  // 按当前设置构建托盘图标（macOS 支持 smile 模板 / color 彩色两种样式）
  buildTrayIcon() {
    const iconPath = this.getTrayIconPath();

    if (process.platform === "darwin") {
      // macOS 菜单栏：根据 tray_icon_style 选择
      //   'smile' → cat-tray-smile.png（单色模板，镂空眼/耳/微笑，setTemplateImage(true)，深浅菜单栏自适配）
      //   'color' → cat-tray-color.png（彩色猫头，setTemplateImage(false)，保留配色）
      const style = this.getTrayIconStyle();
      const isSmile = style !== "color"; // 默认 smile
      const catIconPath = isSmile ? this.getSmileTrayIconPath() : this.getCatTrayIconPath();
      const trayIcon = nativeImage.createFromPath(catIconPath);
      if (trayIcon.isEmpty()) {
        const msg = "托盘图标加载失败（图片为空）: " + catIconPath;
        if (this.logger && this.logger.error) {
          this.logger.error(msg);
        } else {
          console.error(msg);
        }
      }
      trayIcon.setTemplateImage(isSmile);
      return trayIcon;
    }

    if (process.platform === "win32" && iconPath && require("fs").existsSync(iconPath)) {
      // Windows 托盘：彩色 .ico，缩放到 16px 并关闭模板图（否则会被渲染成单色）
      const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
      trayIcon.setTemplateImage(false);
      return trayIcon;
    }

    if (iconPath && require("fs").existsSync(iconPath)) {
      return nativeImage.createFromPath(iconPath);
    }
    return nativeImage.createEmpty();
  }

  async createTray() {
    try {
      const trayIcon = this.buildTrayIcon();

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

  // 按当前 tray_icon_style 设置实时刷新托盘图标（设置变更后由主进程调用）。
  // 直接 setImage 而非销毁重建，保留已绑定的事件与上下文菜单，最稳。
  rebuildTray() {
    try {
      if (!this.tray) {
        // 托盘尚未创建则创建之；createTray 为 async，吞掉其拒绝避免未处理的 Promise rejection
        return this.createTray().catch((e) => ({
          success: false,
          error: String((e && e.message) || e),
        }));
      }
      const trayIcon = this.buildTrayIcon();
      this.tray.setImage(trayIcon);
      return { success: true, style: this.getTrayIconStyle() };
    } catch (error) {
      if (this.logger && this.logger.error) {
        this.logger.error("刷新托盘图标失败:", error);
      }
      return { success: false, error: String((error && error.message) || error) };
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

  // macOS 彩色猫头(C1) 托盘图标路径（@1x；同目录的 @2x 由 Electron 自动选用），dev/打包均可解析。
  // 资源随 assets/**/* 打进 app.asar，__dirname 在打包态为 .../app.asar/src/helpers，
  // 上跳两级即 .../app.asar/assets/cat-tray-color.png（nativeImage.createFromPath 可直读 asar），
  // dev 态 __dirname 为 .../ququ/src/helpers，同样上跳两级命中 .../ququ/assets/。故 dev/打包统一用 __dirname 相对路径。
  getCatTrayIconPath() {
    return path.join(__dirname, "..", "..", "assets", "cat-tray-color.png");
  }

  // macOS 「中笑」单色模板托盘图标路径（@1x；同目录 @2x 由 Electron 自动选用）。
  // 与 getCatTrayIconPath 同样的 __dirname 上跳两级解析，dev/打包统一可读（含 asar）。
  getSmileTrayIconPath() {
    return path.join(__dirname, "..", "..", "assets", "cat-tray-smile.png");
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