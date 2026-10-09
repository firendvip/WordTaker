import { useEffect } from "react";

const AUTO_DISMISS_MS = 8000;

export default function QuotaExhaustedBubble({
  visible,
  onShown,
  onDismiss,
}) {
  useEffect(() => {
    if (!visible) return undefined;
    onShown?.();
    return undefined;
  }, [visible, onShown]);

  useEffect(() => {
    if (!visible) return undefined;
    const timer = window.setTimeout(() => onDismiss?.("timeout"), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [visible, onDismiss]);

  if (!visible) return null;

  return (
    <div
      className="quota-exhausted-bubble"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span>云端字数已用尽，可安装本地模型或充值继续使用。</span>
      <button
        type="button"
        className="quota-exhausted-bubble-close"
        aria-label="关闭云端字数提醒"
        onClick={() => onDismiss?.("dismissed")}
      >
        ×
      </button>
    </div>
  );
}
