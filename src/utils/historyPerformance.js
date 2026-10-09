const POLISH_ENGINE_LABELS = {
  cloud: "云端AI",
  "local-4b": "本地模型",
};

export function formatPerformanceDuration(ms) {
  return (Math.floor(ms / 10) / 100).toFixed(2);
}

export function formatAiOptimizeLabel(item = {}) {
  const engineLabel = POLISH_ENGINE_LABELS[item.polish_engine];
  let label = engineLabel ? `AI优化·${engineLabel}` : "AI优化";

  const e2eMs = item.e2e_total_ms;
  const finalText = item.processed_text || item.raw_text || item.text || "";
  if (Number.isFinite(e2eMs) && e2eMs > 0 && finalText.length > 0) {
    const codePointCount = [...finalText].length;
    const charsPerSecond = Math.round(codePointCount / (e2eMs / 1000));
    label += ` ${charsPerSecond}字/秒，总耗时：${formatPerformanceDuration(e2eMs)}秒`;
  }

  const firstCharMs = item.polish_first_char_ms;
  if (Number.isFinite(firstCharMs) && firstCharMs >= 0) {
    label += `，流式上屏首字：${formatPerformanceDuration(firstCharMs)}秒`;
  }

  return label;
}
