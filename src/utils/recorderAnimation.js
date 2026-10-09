export const VOICE_INK_IDLE_HEIGHT_PX = 4;

const VOICE_INK_BAR_COUNT = 15;
const VOICE_INK_CENTER_INDEX = (VOICE_INK_BAR_COUNT - 1) / 2;
const SILENT_RECORDING_FLOOR = 0.18;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * VoiceInk 单帧柱高。
 *
 * 录音时保留一层与输入音量无关的低幅呼吸，避免静音、麦克风首帧或
 * AudioContext 降级时 rAF 虽持续运行、柱高却永远停在 4px。
 */
export function voiceInkBarHeight({
  index = 0,
  timeSeconds = 0,
  level = 0,
  isRecording = false,
  reducedMotion = false,
} = {}) {
  if (!isRecording) return VOICE_INK_IDLE_HEIGHT_PX;

  const safeIndex = clamp(Number(index) || 0, 0, VOICE_INK_BAR_COUNT - 1);
  const safeLevel = clamp(Number(level) || 0, 0, 1);
  const distanceFromCenter = Math.abs(safeIndex - VOICE_INK_CENTER_INDEX);
  const centerBoost = 1 - (distanceFromCenter / VOICE_INK_CENTER_INDEX) * 0.4;
  const amplitude = Math.max(SILENT_RECORDING_FLOOR, Math.pow(safeLevel, 0.7));

  if (reducedMotion) {
    return VOICE_INK_IDLE_HEIGHT_PX + amplitude * centerBoost * 8;
  }

  const wave = Math.sin((Number(timeSeconds) || 0) * 8 + safeIndex * 0.4) * 0.5 + 0.5;
  const animatedWave = 0.3 + wave * 0.7;
  return VOICE_INK_IDLE_HEIGHT_PX + amplitude * animatedWave * centerBoost * 14;
}

/**
 * 小猫皮肤的可视运动状态。
 *
 * 录音本身就是需要持续反馈的状态；声音电平只控制音符等附加效果，不能再决定
 * 小猫是否移动，否则低声、静音首帧或分析器降级时会看起来“没有录音动画”。
 */
export function resolveCatMotion({
  isRecording = false,
  isBusy = false,
  reducedMotion = false,
} = {}) {
  if (reducedMotion && (isRecording || isBusy)) return "static";
  if (isBusy) return "process";
  if (isRecording) return "walk";
  return "rest";
}

/**
 * 小猫窗口一经唤醒就必须有可见内容，不能等待异步麦克风初始化完成。
 *
 * Alt/Option 事件会先显示透明窗口，再由渲染层异步申请麦克风；这段间隙如果
 * 小猫只跟随 recording/busy 状态，用户看到的就是一个完全透明的“空窗口”。
 */
export function shouldShowCat({
  recorderWindowVisible = false,
  micState = "idle",
} = {}) {
  return (
    recorderWindowVisible ||
    micState === "recording" ||
    micState === "processing" ||
    micState === "optimizing"
  );
}

export function catHorizontalPosition({ center = 0, amplitude = 0, phase = 0 } = {}) {
  const safeCenter = Number(center) || 0;
  const safeAmplitude = Math.max(0, Number(amplitude) || 0);
  const safePhase = Number(phase) || 0;
  return safeCenter + safeAmplitude * Math.sin(safePhase);
}

/**
 * 主胶囊使用本地录音状态；控制面板只展示主进程广播的共享会话状态，
 * 避免它自己的空闲 hook 把正在录音的主窗口覆盖成 false。
 */
export function resolveRecorderMicState({
  isControlPanel = false,
  localIsRecording = false,
  sharedIsRecording = false,
  sharedIsBusy = false,
  isProcessing = false,
  isOptimizing = false,
  isHovered = false,
} = {}) {
  const isRecording = isControlPanel ? sharedIsRecording : localIsRecording;
  const isProcessingNow = isControlPanel ? sharedIsBusy : isProcessing;
  if (isRecording) return "recording";
  if (isProcessingNow) return "processing";
  if (isOptimizing) return "optimizing";
  if (isHovered) return "hover";
  return "idle";
}
