const { BrowserWindow, app } = require("electron");
const path = require("path");
const { execFile } = require("child_process");

// 取前台焦点窗口位置/尺寸的超时（毫秒）：放宽到 1500ms，避免 osascript 偶发卡顿被 SIGKILL
// 后误回退到光标屏（胶囊"跟随鼠标"）。超时/失败时优先复用上次成功的焦点屏。
const FOCUS_QUERY_TIMEOUT_MS = 1500;

// 胶囊距屏幕底部的偏移（像素）。
const BOTTOM_OFFSET_PX = 24;

// 胶囊窗口宽度（固定）。
const PILL_WIDTH_PX = 180;
// 默认胶囊高度（music / voiceink / 默认胶囊皮肤）。
const PILL_HEIGHT_DEFAULT_PX = 44;
// 小黑猫皮肤（cat / catfx）高度：留出头顶空间让音符/ZZZ 完整可见。
const PILL_HEIGHT_CAT_PX = 88;

// 给定皮肤对应的窗口高度。
function pillHeightForSkin(skin) {
  return skin === "catfx" || skin === "cat" ? PILL_HEIGHT_CAT_PX : PILL_HEIGHT_DEFAULT_PX;
}

// 「跟随焦点」时读取焦点输入框 AX 位置/尺寸的超时（毫秒）：比窗口查询更短，
// 让整条 show 链路控制在 ~800ms 内，超时直接走光标/底部兜底，绝不阻塞唤起。
const FOCUS_FIELD_TIMEOUT_MS = 900;

// 胶囊与焦点输入框之间的竖直间距（像素）：略大的下移量，让胶囊明显落在输入框下方。
const FIELD_GAP_PX = 14;

// 光标定位模式：胶囊顶边与鼠标点之间的竖直间距（像素）。比 FIELD_GAP_PX 略大，
// 让胶囊清晰落在鼠标指针下方、不与指针箭头重叠。
const CURSOR_GAP_PX = 24;

// AX 尺寸的合理上限（像素）：超过即视为垃圾值，按解析失败处理。
const MAX_AX_DIMENSION_PX = 20000;

// 焦点框「荒谬尺寸」守卫：
//  - 高度 < 8px：曾出现 AXFocusedUIElement 返回 window 级元素 height≈1（如 224,117,72,1），
//    据此定位会把胶囊贴到一个伪矩形上 → 视为「无焦点框」回退。
//  - 高度 >= 屏幕高度的此比例：说明拿到的是整窗/整屏元素而非输入框，同样回退，
//    避免把胶囊推到另一块显示器或屏幕外（造成「胶囊唤醒后消失」的回归）。
const MIN_FIELD_HEIGHT_PX = 8;
const MAX_FIELD_HEIGHT_SCREEN_RATIO = 0.9;

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

  // 胶囊定位的一行调试日志：记录使用的分支（field/cursor/bottom）、解析到的输入框/锚点
  // 边界以及最终胶囊位置。有 logger 用 logger.info，否则回退 console.log。绝不抛出。
  _logPlacement(branch, bounds, pill) {
    try {
      const msg = `[pill] resolve branch=${branch} bounds=${JSON.stringify(bounds)} pill=${JSON.stringify(pill)}`;
      if (this.logger && typeof this.logger.info === "function") {
        this.logger.info(msg);
      } else {
        console.log(msg);
      }
    } catch (e) {
      // 日志失败不影响定位
    }
  }

  // 渲染进程崩溃/加载失败可见性（Windows 白屏排查关键）：给窗口挂上
  // render-process-gone / did-fail-load / unresponsive / preload-error 日志。
  // 以后再出现"白窗/白条"，app.log 里能直接看到是渲染进程崩了还是页面没加载成功。绝不抛出。
  _wireRendererDiagnostics(win, name) {
    try {
      const wc = win.webContents;
      // 胶囊(pill)是 frameless + transparent 窗：内容一旦为空就"看不见"，静默 reload 的空白期
      // 在透明窗上表现为"胶囊自己消失"。所以对 pill 做更保守的自动重载策略（见下）。
      const isPill = name === "pill";
      // 自动恢复：渲染进程崩溃/页面加载失败时自动 reload（每窗口生命周期最多 2 次，
      // 防止崩溃-重载死循环；超限后只留日志，窗口保持现状等人工处理）。
      const MAX_AUTO_RELOADS = 2;
      let autoReloadCount = 0;
      const tryAutoReload = (why) => {
        if (autoReloadCount >= MAX_AUTO_RELOADS) {
          // 达上限：保持已渲染内容与当前可见性，不再把窗口刷空（透明胶囊尤其不能刷成空白）
          this._logError(`[${name}] ${why}，已达自动重载上限(${MAX_AUTO_RELOADS})，保持已渲染内容不再重载`, null);
          return;
        }
        autoReloadCount += 1;
        const attempt = autoReloadCount;
        // 稍等片刻再 reload：给崩溃后的 webContents 一点恢复时间，也避免同步事件里重入
        setTimeout(() => {
          try {
            if (!win.isDestroyed() && !wc.isDestroyed()) {
              // 透明胶囊窗：记录 reload 前的可见性，reload 后保持可见（不因重载而隐藏），
              // 尽量缩短"透明+空内容=看起来自己消失"的观感。
              const wasVisible = isPill && win.isVisible();
              this._logError(`[${name}] ${why} → 自动重载渲染层（第 ${attempt}/${MAX_AUTO_RELOADS} 次）`, null);
              wc.reload();
              if (wasVisible && !win.isDestroyed() && !win.isVisible()) {
                try { win.showInactive(); } catch (_) { /* 保持可见兜底失败不致命 */ }
              }
            }
          } catch (e) {
            this._logError(`[${name}] 自动重载失败`, e);
          }
        }, 800);
      };
      wc.on("render-process-gone", (_e, details) => {
        this._logError(`[${name}] 渲染进程消失: ${JSON.stringify(details)}`, null);
        const reason = details && details.reason;
        // 区分"渲染进程真崩溃"与"GPU/DWM 合成回退/正常退出"：
        // clean-exit / killed 多发生在隐藏/关闭或合成回退时，并非渲染层真失败；
        // 此时若对透明胶囊静默 reload，只会把它刷成空白 → 表现为"没说话胶囊就消失"。
        if (isPill && (reason === "clean-exit" || reason === "killed")) {
          this._logError(`[pill] 胶囊窗合成回退/正常退出(${reason})，跳过静默reload（避免透明胶囊闪成空白）`, null);
          return;
        }
        tryAutoReload("渲染进程消失");
      });
      wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
        if (isMainFrame) {
          this._logError(`[${name}] 页面加载失败 code=${code} desc=${desc} url=${url}`, null);
          // -3 = ERR_ABORTED（导航被正常中断，如快速二次加载），不算真失败，不重载
          if (code !== -3) tryAutoReload(`页面加载失败(code=${code})`);
        }
      });
      wc.on("preload-error", (_e, preloadPath, error) => {
        this._logError(`[${name}] preload 出错: ${preloadPath}`, error);
      });
      win.on("unresponsive", () => {
        this._logError(`[${name}] 窗口无响应（Windows 上会变成带标题栏的白色幽灵窗口）`, null);
      });
    } catch (e) {
      // 诊断挂载失败不影响窗口创建
    }
  }

  // Windows 可见窗口（设置/历史/控制面板）的专属 BrowserWindow 选项，仅 win32 返回，mac 恒为空对象：
  //  - icon：标题栏/任务栏彩色多尺寸 .ico。用 app.isPackaged 判别路径（兼容 npm start 无 NODE_ENV）：
  //    未打包取项目内 assets/icon.ico；打包后取 process.resourcesPath/assets/icon.ico
  //    （由 package.json build.win.extraResources 复制到 asar 之外，Windows 加载 .ico 最稳）。
  //  - autoHideMenuBar：隐藏菜单栏兜底（主进程启动时已全局 Menu.setApplicationMenu(null)，REQ-2）。
  _winIconOption() {
    if (process.platform !== "win32") return {};
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, "assets", "icon.ico")
      : path.join(__dirname, "..", "..", "assets", "icon.ico");
    return { icon: iconPath, autoHideMenuBar: true };
  }

  async createMainWindow() {
    if (this.mainWindow) {
      this.mainWindow.focus();
      return this.mainWindow;
    }

    // 创建时按已保存皮肤决定初始高度：小黑猫皮肤需要更高窗口承载头顶特效。
    let initialSkin = "music";
    try {
      if (this.databaseManager && typeof this.databaseManager.getSetting === "function") {
        initialSkin = this.databaseManager.getSetting("pill_skin", "music") || "music";
      }
    } catch (e) {
      // 读取失败按默认皮肤处理
    }

    // 紧凑"胶囊"录音条：frameless + 透明 + 置顶 + 不抢焦点（避免抢走目标输入框的焦点导致粘贴失败）
    // backgroundColor 显式设全透明（#00000000）：BrowserWindow 默认背景是 #FFF，
    // Windows 上透明合成偶发失效（DWM/GPU 回退，electron#2170 wontfix）时会把默认白底
    // 涂满整窗 → 表现为"白色横条"。显式全透明底可消除该白底回退，mac 行为不变。
    this.mainWindow = new BrowserWindow({
      width: PILL_WIDTH_PX,
      height: pillHeightForSkin(initialSkin),
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
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

    this._wireRendererDiagnostics(this.mainWindow, "pill");

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
  // branchLabel：日志用的分支名。默认 "bottom"；跟随开启时 field 失败后的
  // 「前台窗口所在屏」兜底传 "front-screen"，便于日志区分走了哪级。
  positionMainWindowBottomCenter(display, branchLabel = "bottom") {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    try {
      const target = display || this._cursorDisplay();
      const wa = target.workArea;
      const [w, h] = this.mainWindow.getSize();
      const x = Math.round(wa.x + (wa.width - w) / 2);
      const y = Math.round(wa.y + wa.height - h - BOTTOM_OFFSET_PX); // 距屏幕底部 24px
      // 「同坐标跳过」守卫：目标 (x,y) 与当前窗口位置完全一致时不再 setPosition。
      // 这样「显示先行」在光标屏摆好后，异步补位若解析出同屏同槽位即为 no-op → 消除同屏闪动；
      // 仅当真跨到不同屏/不同槽位（坐标不同）才补位。
      const [curX, curY] = this.mainWindow.getPosition();
      if (curX === x && curY === y) return;
      this.mainWindow.setPosition(x, y);
      this._logPlacement(branchLabel, { x: wa.x, y: wa.y, w: wa.width, h: wa.height }, { x, y, width: w, height: h });
    } catch (error) {
      // 定位失败不影响录音
    }
  }

  // 按皮肤调整胶囊窗口高度：cat/catfx 用 88px（头顶特效完整可见），其它用 44px。
  // 改尺寸后重新底部居中定位，保持底边距屏底恒定（公式用当前高度，故底边不变）。
  setPillHeightForSkin(skin) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    try {
      const h = pillHeightForSkin(skin);
      const [, curH] = this.mainWindow.getSize();
      if (curH === h) return;
      this.mainWindow.setSize(PILL_WIDTH_PX, h);
      // 重新定位：复用底部居中逻辑，定位公式按当前高度计算，底边保持不变。
      this.positionMainWindowBottomCenter();
    } catch (error) {
      // 调整失败不影响录音
    }
  }

  // 多猫并存：把胶囊窗口设为渲染层算好的「猫堆叠 union bbox」。
  //  - 入参已在主进程 IPC 侧校验（数字、正尺寸、合理上限）。
  //  - 夹紧到 (x,y) 所在显示器的 workArea；窗口 hidden 时 showInactive（不抢焦点）。
  //  - resizable:false 不阻止 setBounds（仅禁用户拖拽），与既有 setPillHeightForSkin 的 setSize 同理。
  setRecorderBounds(rect) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    try {
      const { screen } = require("electron");
      const disp = screen.getDisplayNearestPoint({ x: Math.round(rect.x), y: Math.round(rect.y) });
      const clamped = this.clampRectToWorkArea(rect, disp.workArea);
      this.mainWindow.setBounds(clamped);
      // 始终 showInactive（幂等，不抢焦点）：渲染层只在「有猫」时调本方法，故此处必让窗口可见——
      // 即便 fire() 的 isVisible 守卫或某次 hide 竞态导致窗口处于「陈旧不可见/别屏」态，也能自愈显示到位。
      this.mainWindow.showInactive();
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

  // 读取「跟随焦点」开关：**默认 false**（默认走光标定位，瞬时零跳动）。
  // 仅当用户在设置里显式开启，才走「跟随输入框」的 AX 贴框模式（可能有轻微延迟/位移）。
  // DB 不可用/异常时按 false 处理（与设置默认一致）。
  _isFollowFocusEnabled() {
    try {
      const dbm = this.databaseManager;
      if (!dbm || typeof dbm.getSetting !== "function") return false;
      return dbm.getSetting("pill_follow_focus", false) === true;
    } catch (e) {
      return false;
    }
  }

  // 首帧「零跳动」摆位：直接用上次成功的输入框锚点（this._lastFocusPoint）把胶囊摆到输入框下方，
  // 同步、瞬时、不走 AX。仅当锚点有效**且与当前光标同屏**时才用——跨屏则视为过期/跟随了别的屏，
  // 返回 false 由上层回退「光标屏底部居中」，优先保证「首帧不跨屏跳」。稳态（同一输入框连唤）
  // 首帧即在正确位置，随后 STEP2 AX 精解析与之同位 → 被 field 的「同坐标 no-op」守卫拦下，零跳动。
  // 成功 setBounds 并 return true；无缓存/跨屏/异常 return false。绝不抛出。
  _positionByCachedFieldAnchor() {
    try {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;
      const anchor = this._lastFocusPoint;
      if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return false;
      const { screen } = require("electron");
      const cursorDisp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const anchorDisp = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) });
      // 缓存锚点与当前光标不在同屏 → 过期/跨屏，回退底部居中（消除跨屏跳动优先于沿用旧锚点）。
      if (!cursorDisp || !anchorDisp || cursorDisp.id !== anchorDisp.id) return false;
      const [w, h] = this.mainWindow.getSize();
      const rect = { x: Math.round(anchor.x - w / 2), y: Math.round(anchor.y), width: w, height: h };
      const clamped = this.clampRectToWorkArea(rect, anchorDisp.workArea);
      this.mainWindow.setBounds(clamped);
      this._logPlacement("field-cache", { x: anchor.x, y: anchor.y, w: 0, h: 0 }, clamped);
      return true;
    } catch (e) {
      return false;
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
        // 关键修复：在 AppleScript 里先把每个数 (as integer) as text，再用 & 拼接。
        // 否则 number & "," 会被当成「列表」，stdout 变成 "1280, ,, -333, ,, 720, ,, 1250"，
        // 解析后含 0，触发宽度<=0 守卫，STEP1 每次静默失败、胶囊永远回退到光标。
        const script = [
          'tell application "System Events"',
          "  set fp to first application process whose frontmost is true",
          '  set el to value of attribute "AXFocusedUIElement" of fp',
          '  set p to value of attribute "AXPosition" of el',
          '  set s to value of attribute "AXSize" of el',
          '  return (((item 1 of p) as integer) as text) & "," & (((item 2 of p) as integer) as text) & "," & (((item 1 of s) as integer) as text) & "," & (((item 2 of s) as integer) as text)',
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
              const raw = String(stdout).trim();
              // 含 "missing value"（AX 无焦点元素）直接判失败。
              if (/missing value/i.test(raw)) return done(false);
              // 健壮解析：提取前 4 个数字 token（容忍逗号两侧空格、浮点、负号）。
              const tokens = raw.match(/-?\d+(?:\.\d+)?/g) || [];
              const nums = tokens.slice(0, 4).map((t) => Number(t));
              // 校验：必须有 4 个有限数；宽高 > 0 且不荒谬（防 AX 返回垃圾/0 尺寸元素）。
              const valid =
                nums.length === 4 &&
                nums.every((n) => Number.isFinite(n)) &&
                nums[2] > 0 &&
                nums[3] > 0 &&
                nums[2] <= MAX_AX_DIMENSION_PX &&
                nums[3] <= MAX_AX_DIMENSION_PX;
              if (!valid) return done(false);
              const [fx, fy, fw, fh] = nums;
              const [w, h] = this.mainWindow.getSize();
              // 计算锚点所在显示器（用于荒谬尺寸守卫的屏高比较与最终夹紧）。
              const display = screen.getDisplayNearestPoint({ x: Math.round(fx + fw / 2), y: Math.round(fy + fh) });
              // 荒谬尺寸守卫：高度过小（window 级伪矩形 height≈1）或接近整屏（拿到整窗/整屏元素）
              // 都视为「无焦点框」回退——否则会把胶囊推到别的显示器或屏幕外（唤醒后消失的回归）。
              const screenH = (display && display.workArea && display.workArea.height) || 0;
              const tooShort = fh < MIN_FIELD_HEIGHT_PX;
              const tooTall = screenH > 0 && fh >= screenH * MAX_FIELD_HEIGHT_SCREEN_RATIO;
              if (tooShort || tooTall) return done(false);
              // 水平居中于输入框，竖直放在输入框下方 + 间距。
              const anchorX = fx + fw / 2; // 输入框水平中心
              const anchorY = fy + fh + FIELD_GAP_PX; // 输入框底边 + 下移间距
              const rect = {
                x: Math.round(fx + fw / 2 - w / 2),
                y: Math.round(anchorY),
                width: w,
                height: h,
              };
              const clamped = this.clampRectToWorkArea(rect, display.workArea);
              // 缓存成功锚点，供首帧摆位与平滑偶发单次失败用（无论是否 setBounds 都要刷新）。
              this._lastFocusPoint = { x: anchorX, y: anchorY };
              // 「同坐标 no-op」守卫：AX 精解析出的位置与当前（首帧缓存锚点摆好的）位置一致 →
              // 不再 setBounds，消除同一输入框连唤时的同位闪动。仅换了输入框/位置变化才真正补位。
              const [curX, curY] = this.mainWindow.getPosition();
              if (curX === clamped.x && curY === clamped.y) {
                this._logPlacement("field-noop", { x: fx, y: fy, w: fw, h: fh }, clamped);
                return done(true);
              }
              this.mainWindow.setBounds(clamped);
              this._logPlacement("field", { x: fx, y: fy, w: fw, h: fh }, clamped);
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

  // 光标定位（默认唤醒模式）：把胶囊放到鼠标点正下方、水平以光标居中，夹紧到光标屏 workArea。
  // 同步、瞬时、一次到位——首帧即终位、零跳动、多屏正确（光标在哪屏就在哪屏）。
  // 也是 Windows「跟随」路径与 macOS 跟随模式失败时的兜底。成功 true，失败 false。
  _positionByCursor() {
    try {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;
      const { screen } = require("electron");
      const pt = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(pt);
      const [w, h] = this.mainWindow.getSize();
      const rect = {
        x: Math.round(pt.x - w / 2),
        y: Math.round(pt.y + CURSOR_GAP_PX),
        width: w,
        height: h,
      };
      const clamped = this.clampRectToWorkArea(rect, display.workArea);
      this.mainWindow.setBounds(clamped);
      this._logPlacement("cursor", { x: pt.x, y: pt.y, w: 0, h: 0 }, clamped);
      return true;
    } catch (e) {
      return false;
    }
  }

  // 唤起前的胶囊定位（不含 show）。绝不抛出：任何异常最终回退到「焦点屏底部居中」。
  // 关闭跟随：保持原行为（焦点屏底部居中）。
  // 开启跟随：焦点输入框 → 前台窗口所在屏底部居中 → 鼠标点，逐级兜底。
  //   （原顺序是 field → 鼠标点：三屏场景下鼠标常在副屏、打字焦点在另一屏，
  //     AX 读不到输入框时胶囊就跟去了鼠标屏，用户感觉"不在焦点附近"。
  //     现在 field 失败先落到「前台窗口所在屏」——那才是正在打字的屏。）
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
      // STEP 1：焦点输入框（macOS）。成功路径保持不变。
      const placedByField = await this._positionByFocusedField();
      if (placedByField) return;

      // STEP 2（仅 macOS）：前台窗口所在屏底部居中（用户正在打字的屏），
      // 日志 branch=front-screen。Windows 无 AX/osascript，保持原「跟鼠标」路径不变。
      if (process.platform === "darwin") {
        try {
          const display = await this.getFocusDisplay();
          if (display) {
            this.positionMainWindowBottomCenter(display, "front-screen");
            return;
          }
        } catch (e) {
          // 取前台窗口屏失败 → 走下一级
        }
      }

      // STEP 3：鼠标光标兜底（最后一级；含 Windows 跟随路径）。
      if (this._positionByCursor()) return;

      // STEP 4：原行为——焦点屏底部居中。
      this.positionMainWindowBottomCenter(await this.getFocusDisplay());
    } catch (e) {
      try {
        this.positionMainWindowBottomCenter(await this.getFocusDisplay());
      } catch (_) {
        // 最终兜底也失败时静默：定位失败不影响录音。
      }
    }
  }

  // 唤起：显示先行、定位后补——避免被 osascript/AX 焦点屏解析（约 0.3-0.5s）阻塞首帧。
  //   1) 先用「无需异步」的最优猜测——**当前光标屏**（唤醒要输入时光标本就在焦点屏，同步瞬时取得），
  //      立即底部居中并 showInactive，让胶囊在焦点屏与提示音同步瞬间出现；
  //   2) 再异步走完整定位链路（跟随焦点/光标或固定底部居中）。绝大多数场景 STEP2 解析出的屏/坐标
  //      与首帧相同 → positionMainWindowBottomCenter 的「同坐标跳过」守卫使其不再 setPosition，无跳屏；
  //      仅当真跨到不同屏/不同槽位时才补一次位（窗口已可见，仅位移）。
  //   （不再优先 _lastFocusDisplay：那可能是上次残留的主屏，会导致首帧落错屏再闪到焦点屏。）
  showRecorderAtBottom() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const follow = this._isFollowFocusEnabled();
    // STEP 1：即时摆位 + 显示（不 await 任何异步解析）。
    try {
      if (follow) {
        // 跟随输入框（opt-in，默认关）：先用「缓存输入框锚点/光标」摆首帧，STEP2 再 AX 精确贴框。
        let placed = this._positionByCachedFieldAnchor();
        if (!placed) placed = this._positionByCursor();
        if (!placed) {
          this.positionMainWindowBottomCenter(this._cursorDisplay() || this._lastFocusDisplay, "instant");
        }
      } else {
        // 默认：光标附近，一次到位、零跳动（同步、不走 AX、无 STEP2 位移）。
        if (!this._positionByCursor()) {
          this.positionMainWindowBottomCenter(this._cursorDisplay() || this._lastFocusDisplay, "instant");
        }
      }
    } catch (e) {
      // 摆位失败不致命：仍先把胶囊显示出来。
    }
    try {
      this.mainWindow.showInactive();
    } catch (e) {
      // 忽略
    }
    // STEP 2：仅「跟随输入框」模式才异步 AX 贴框（非默认路径）；默认光标模式不触发，故零跳动。
    // 不 await、不抛出：positionPillForRecording 内部已逐级兜底。
    if (follow) {
      Promise.resolve()
        .then(() => this.positionPillForRecording())
        .catch(() => {
          // 定位失败不影响已显示的胶囊。
        });
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

    this._wireRendererDiagnostics(this.controlPanelWindow, "controlPanel");

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

    this._wireRendererDiagnostics(this.historyWindow, "history");

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

  // initialTab：可选的初始分类标识（如 "permissions"），经 URL query 传给 settings.jsx。
  // 仅在首次创建窗口时生效；窗口已存在则直接复用（聚焦），不改其当前分类。
  async createSettingsWindow(initialTab = null) {
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

    this._wireRendererDiagnostics(this.settingsWindow, "settings");

    const isDev = process.env.NODE_ENV === "development";
    // 仅允许已知的安全分类标识透传，避免把任意字符串注入 URL。
    const safeTab =
      typeof initialTab === "string" && /^[a-z]+$/.test(initialTab) ? initialTab : null;

    if (isDev) {
      const devUrl = safeTab
        ? `http://localhost:5173?page=settings&tab=${safeTab}`
        : "http://localhost:5173?page=settings";
      await this.settingsWindow.loadURL(devUrl);
    } else {
      const loadOptions = safeTab ? { query: { tab: safeTab } } : undefined;
      await this.settingsWindow.loadFile(
        path.join(__dirname, "..", "dist", "settings.html"),
        loadOptions
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

  // initialTab：仅在窗口尚未创建时透传给 settings.jsx 作为初始分类（如首启自动弹"权限"页）。
  // 窗口已存在则只是 show/focus，不改其当前分类。
  showSettingsWindow(initialTab = null) {
    if (this.settingsWindow) {
      this.settingsWindow.show();
      this.settingsWindow.focus();
      this.settingsWindow.setAlwaysOnTop(true);
    } else {
      this.createSettingsWindow(initialTab)
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