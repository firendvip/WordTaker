const { uIOhook, UiohookKey } = require("uiohook-napi");

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

    this.config = { ...DEFAULTS, ...(config || {}) };
    this.targetKeycode = KEYCODE_BY_NAME[this.config.key];
    if (this.targetKeycode == null) {
      this._log("error", "triggerManager: 未知的触发键", this.config.key);
      return false;
    }
    this.onTrigger = onTrigger;

    try {
      uIOhook.on("keydown", this._boundKeydown);
      uIOhook.on("keyup", this._boundKeyup);
      if (!TriggerManager._hookRunning) {
        uIOhook.start();
        TriggerManager._hookRunning = true;
      }
      this.started = true;
      this._log("info", "triggerManager 已启动", {
        key: this.config.key,
        keycode: this.targetKeycode,
        taps: this.config.taps,
      });
      return true;
    } catch (error) {
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
// 合法触发键名集合（供主进程校验 recording_trigger）
TriggerManager.VALID_KEYS = new Set(Object.keys(KEYCODE_BY_NAME));

module.exports = TriggerManager;
