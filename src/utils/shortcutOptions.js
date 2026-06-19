// 快捷键下拉项：把"单击/双击 + 修饰键"组合成统一选项。
// 选项 value 编码为 "<Key>:<taps>"（如 "LeftOption:1"），便于解析回 { key, taps }。
//
// 与 main.js / triggerManager.js 的 VALID_KEYS 对应（修饰键名集合）。

// 修饰键基础项（label 随平台略有差异，由 buildModifierShortcutOptions 接收 isMac 决定）
const MODIFIER_KEYS = [
  { key: "LeftOption", mac: "左 Option ⌥", other: "左 Alt" },
  { key: "RightOption", mac: "右 Option ⌥", other: "右 Alt" },
  { key: "LeftCtrl", mac: "左 Control ⌃", other: "左 Ctrl" },
  { key: "RightCtrl", mac: "右 Control ⌃", other: "右 Ctrl" },
  { key: "LeftShift", mac: "左 Shift ⇧", other: "左 Shift" },
  { key: "RightShift", mac: "右 Shift ⇧", other: "右 Shift" },
  { key: "LeftMeta", mac: "左 Command ⌘", other: "左 Win" },
  { key: "RightMeta", mac: "右 Command ⌘", other: "右 Win" },
];

const TAP_LABELS = { 1: "单击", 2: "双击" };

/**
 * 生成"单击/双击 × 全部修饰键"的下拉项。
 * @param {boolean} isMac 是否 macOS（决定 Option/Command 还是 Alt/Win 文案）
 * @returns {{ value: string, label: string }[]} value 形如 "LeftOption:1"
 */
function buildModifierShortcutOptions(isMac) {
  const options = [];
  for (const taps of [1, 2]) {
    for (const mod of MODIFIER_KEYS) {
      const keyLabel = isMac ? mod.mac : mod.other;
      options.push({
        value: `${mod.key}:${taps}`,
        label: `${TAP_LABELS[taps]}${keyLabel}`,
      });
    }
  }
  return options;
}

/**
 * 把下拉 value 解析回 { key, taps }。
 * @param {string} value 形如 "LeftOption:1"
 * @returns {{ key: string, taps: number }}
 */
function parseModifierShortcutValue(value) {
  const [key, tapsStr] = String(value || "").split(":");
  const taps = Number(tapsStr) === 2 ? 2 : 1;
  return { key, taps };
}

/**
 * 由 { key, taps } 组装下拉 value。
 * @param {string} key 修饰键名
 * @param {number|string} taps 连击次数
 * @returns {string}
 */
function toModifierShortcutValue(key, taps) {
  return `${key}:${Number(taps) === 2 ? 2 : 1}`;
}

// 取消键选项：仅 Esc / F1 / F2 / F4 / F8 的"单击 / 双击"。
// value 编码为 "<Key>:<taps>"（如 "Escape:1"、"F1:2"），与 cancel_key + cancel_taps 对应。
// 这些键经 triggerManager 的 uiohook 触发器识别单/双击（globalShortcut 无法检测双击）。
const CANCEL_KEYS = [
  { key: "Escape", label: "Esc" },
  { key: "F1", label: "F1" },
  { key: "F2", label: "F2" },
  { key: "F4", label: "F4" },
  { key: "F8", label: "F8" },
];

const CANCEL_KEY_OPTIONS = CANCEL_KEYS.flatMap((k) =>
  [1, 2].map((taps) => ({
    value: `${k.key}:${taps}`,
    label: `${TAP_LABELS[taps]} ${k.label}`,
  }))
);

export {
  MODIFIER_KEYS,
  buildModifierShortcutOptions,
  parseModifierShortcutValue,
  toModifierShortcutValue,
  CANCEL_KEY_OPTIONS,
};
