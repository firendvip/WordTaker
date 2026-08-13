const TAP_LISTENER_KEYS = new Set([
  "Escape",
  "F1",
  "F2",
  "F4",
  "F8",
]);

function resolveCancelShortcut({ key = "Escape", taps = 1 } = {}) {
  const normalizedTaps = Number(taps) === 2 ? 2 : 1;
  if (normalizedTaps === 1) {
    return { type: "accelerator", accelerator: key || "Escape" };
  }
  if (TAP_LISTENER_KEYS.has(key)) {
    return { type: "tap-listener", key, taps: normalizedTaps };
  }
  return { type: "accelerator", accelerator: key || "Escape" };
}

module.exports = { resolveCancelShortcut };
