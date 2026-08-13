const { uIOhook, UiohookKey } = require("uiohook-napi");
const { systemPreferences } = require("electron");

/**
 * 触发管理器（裸修饰键全局触发）
 *
 * Electron 的 globalShortcut 无法绑定"单独的修饰键"（Alt/Option/Ctrl/Shift），
 * 因此用 uiohook-napi 在系统层监听键盘，识别"单击/双击某修饰键"作为录音开关。
 *
 * 默认：mac = 单击左 Option，Windows = 双击左 Alt。
 * macOS 下需要"辅助功能"权限（与自动粘贴所需的权限相同）。
 */

// 触发键名 → uiohook keycode（左右可区分）
const KEYCODE_BY_NAME = {
  LeftOption: UiohookKey.Alt,        // 56
  RightOption: UiohookKey.AltRight,  // 3640
  LeftAlt: UiohookKey.Alt,
  RightAlt: UiohookKey.AltRight,
  LeftCtrl: UiohookKey.Ctrl,
  RightCtrl: UiohookKey.CtrlRight,
  LeftShift: UiohookKey.Shift,
  RightShift: UiohookKey.ShiftRight,
  LeftMeta: UiohookKey.Meta,         // 左 Command
  RightMeta: UiohookKey.MetaRight,
  // 取消键专用：Esc / 功能键（支持单/双击）。
  // 注意：底层 uiohook 为"只监听不拦截"模式，因此这些键会被观察到用于触发取消，
  // 但不会被消费——它们仍会照常送达当前聚焦的应用（可接受）。
  Escape: UiohookKey.Escape,
  F1: UiohookKey.F1,
  F2: UiohookKey.F2,
  F4: UiohookKey.F4,
  F8: UiohookKey.F8,
};

const DEFAULTS = {
  taps: 1,             // 需要的连击次数
  tapWindowMs: 450,    // 连击的时间窗口
  maxHoldMs: 700,      // 单次"轻点"的最长按住时长（放宽，避免自然点按被判为长按而漏触发）
  minFireIntervalMs: 350, // 两次触发之间的最小间隔，避免抖动
};

class TriggerManager {
  constructor(logger = null) {
    this.logger = logger;
    this.started = false;
    this.startFailureReason = null;
    this.onTrigger = null;
    this.config = null;
    this.targetKeycode = null;

    // 轻点检测状态
    this._targetDown = false;
    this._downAt = 0;
    this._otherKeyDuringHold = false;
    this._tapCount = 0;
    this._lastTapAt = 0;
    this._lastFireAt = 0;

    this._boundKeydown = this._onKeydown.bind(this);
    this._boundKeyup = this._onKeyup.bind(this);
  }

  _log(level, ...args) {
    if (this.logger && this.logger[level]) this.logger[level](...args);
  }

  /**
   * 启动监听。
   * @param {{type:string, key:string, taps?:number}} config
   * @param {Function} onTrigger 触发时回调
   * @returns {boolean} 是否成功
   */
  start(config, onTrigger) {
    this.stop();
    this.startFailureReason = null;

    this.config = { ...DEFAULTS, ...(config || {}) };
    this.targetKeycode = KEYCODE_BY_NAME[this.config.key];
    if (this.targetKeycode == null) {
      this.startFailureReason = "invalid-key";
      this._log("error", "triggerManager: 未知的触发键", this.config.key);
      return false;
    }
    this.onTrigger = onTrigger;

    // uiohook-napi 的 macOS 原生层会用 prompt=true 检查 AX 权限，直接调用 start()
    // 可能触发系统授权窗。必须先用 Electron 的非提示式检查拦住未信任身份；检测异常
    // 也 fail closed，确保任何情况下都不会因应用启动/重挂触发器而主动弹权限窗。
    if (process.platform === "darwin") {
      try {
        if (!systemPreferences.isTrustedAccessibilityClient(false)) {
          this.startFailureReason = "accessibility-untrusted";
          this._log("warn", "macOS 辅助功能未授权，静默停用系统级按键监听", {
            reason: this.startFailureReason,
            key: this.config.key,
            taps: this.config.taps,
          });
          return false;
        }
      } catch (error) {
        this.startFailureReason = "accessibility-check-failed";
        this._log("warn", "macOS 辅助功能状态检测失败，静默停用系统级按键监听", {
          reason: this.startFailureReason,
          error: error?.message || String(error),
        });
        return false;
      }
    }

    try {
      uIOhook.on("keydown", this._boundKeydown);
      uIOhook.on("keyup", this._boundKeyup);
      // 事件流健康度：挂一个全局 input 监听记录"最后一次收到任何 uiohook 事件"的时间。
      // 用途：Windows 上 LL 钩子可能在 start() 成功后被系统静默摘除（无任何错误、
      // running 标志不翻转），主进程看门狗用该时间戳 + powerMonitor 空闲时间判定钩子失聪。
      if (!TriggerManager._healthListenerAttached) {
        uIOhook.on("input", TriggerManager._onAnyInput);
        TriggerManager._healthListenerAttached = true;
      }
      if (!TriggerManager._hookRunning) {
        uIOhook.start();
        TriggerManager._hookRunning = true;
        TriggerManager._lastInputAt = Date.now();
      }
      this.started = true;
      this._log("info", "triggerManager 已启动", {
        key: this.config.key,
        keycode: this.targetKeycode,
        taps: this.config.taps,
      });
      return true;
    } catch (error) {
      this.startFailureReason = "hook-start-failed";
      // start 抛错时把已挂的监听清掉，避免"未启动却挂着监听"的悬挂状态
      this.stop();
      this._log("error", "triggerManager 启动失败（可能缺少辅助功能权限）", error);
      return false;
    }
  }

  stop() {
    try {
      uIOhook.removeListener("keydown", this._boundKeydown);
      uIOhook.removeListener("keyup", this._boundKeyup);
    } catch (_) {
      // ignore
    }
    this.started = false;
    this._resetTapState();
  }

  /** 进程退出时调用，彻底停止底层 hook 线程 */
  shutdown() {
    this.stop();
    try {
      if (TriggerManager._hookRunning) {
        uIOhook.stop();
        TriggerManager._hookRunning = false;
      }
    } catch (_) {
      // ignore
    }
  }

  _resetTapState() {
    this._targetDown = false;
    this._otherKeyDuringHold = false;
    this._tapCount = 0;
  }

  _onKeydown(e) {
    if (e.keycode === this.targetKeycode) {
      // 仅在首次按下时记录（忽略系统自动重复）
      if (!this._targetDown) {
        this._targetDown = true;
        this._downAt = Date.now();
        this._otherKeyDuringHold = false;
      }
    } else {
      // 持有目标键期间按了别的键 → 说明是修饰键组合用法，不算"轻点"
      if (this._targetDown) this._otherKeyDuringHold = true;
      // 任意其他键也会打断连击序列
      this._tapCount = 0;
    }
  }

  _onKeyup(e) {
    if (e.keycode !== this.targetKeycode) return;

    const wasDown = this._targetDown;
    this._targetDown = false;
    if (!wasDown) return;

    const heldMs = Date.now() - this._downAt;
    const clean = !this._otherKeyDuringHold && heldMs <= this.config.maxHoldMs;
    if (!clean) {
      this._tapCount = 0;
      return;
    }

    const now = Date.now();
    if (this._tapCount > 0 && now - this._lastTapAt <= this.config.tapWindowMs) {
      this._tapCount += 1;
    } else {
      this._tapCount = 1;
    }
    this._lastTapAt = now;

    if (this._tapCount >= this.config.taps) {
      this._tapCount = 0;
      this._fire();
    }
  }

  _fire() {
    const now = Date.now();
    if (now - this._lastFireAt < this.config.minFireIntervalMs) {
      return; // 触发冷却，避免抖动
    }
    this._lastFireAt = now;
    this._log("info", "triggerManager 触发", { key: this.config.key });
    try {
      if (typeof this.onTrigger === "function") this.onTrigger();
    } catch (error) {
      this._log("error", "triggerManager 触发回调出错", error);
    }
  }
}

TriggerManager._hookRunning = false;
// ===== 钩子事件流健康度（供主进程看门狗使用）=====
TriggerManager._healthListenerAttached = false;
TriggerManager._lastInputAt = 0;
TriggerManager._onAnyInput = function () {
  TriggerManager._lastInputAt = Date.now();
};
// 最后一次收到任何 uiohook 事件的时间戳（0 = 钩子从未启动）
TriggerManager.hookLastInputAt = function () {
  return TriggerManager._lastInputAt;
};
// 尝试重启底层钩子（钩子失聪时的第一级自救）。实例监听挂在 uIOhook 单例
// EventEmitter 上，重启后自动继续生效，无需各 TriggerManager 重新 start。
// 注意：若原生层认为钩子仍在运行（线程死但标志未翻转），stop 会抛错、start 会静默
// 无操作——此时返回 true 但事件流可能仍死，由看门狗下一轮复查后走降级。
TriggerManager.tryRestartHook = function (logger) {
  const log = (level, ...args) => {
    try { if (logger && logger[level]) logger[level](...args); } catch (_) { /* 忽略 */ }
  };
  try {
    uIOhook.stop();
  } catch (e) {
    log("warn", "uIOhook.stop() 失败（钩子线程可能已死）", e?.message || e);
  }
  TriggerManager._hookRunning = false;
  try {
    uIOhook.start();
    TriggerManager._hookRunning = true;
    TriggerManager._lastInputAt = Date.now();
    log("warn", "uIOhook 已重启（事件流恢复情况由看门狗复查）");
    return true;
  } catch (e) {
    log("error", "uIOhook 重启失败", e?.message || e);
    return false;
  }
};
TriggerManager.isAccessibilityBlocked = function (manager) {
  return manager?.startFailureReason === "accessibility-untrusted" ||
    manager?.startFailureReason === "accessibility-check-failed";
};
// 合法触发键名集合（供主进程校验 recording_trigger）
TriggerManager.VALID_KEYS = new Set(Object.keys(KEYCODE_BY_NAME));

module.exports = TriggerManager;
