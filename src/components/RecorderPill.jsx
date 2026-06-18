import React from "react";
import {
  Check,
  Sparkles,
  History as HistoryIcon,
  Loader2,
  Download,
} from "lucide-react";

const BAR_COUNT = 9;

/**
 * 悬浮胶囊录音条（出现在光标附近）。
 * 纯展示组件：状态与回调由父级 App 注入。
 *
 * @param {{
 *   micState: 'idle'|'hover'|'recording'|'processing'|'optimizing',
 *   modelStatus: object,
 *   hotkeyLabel: string,
 *   disabled?: boolean,
 *   onToggle: () => void,
 *   onOpenSettings: () => void,
 *   onOpenHistory: () => void,
 *   onDownloadModels: () => void,
 * }} props
 */
export function RecorderPill({
  micState,
  modelStatus,
  hotkeyLabel,
  disabled,
  onToggle,
  onOpenSettings,
  onOpenHistory,
  onDownloadModels,
}) {
  const stage = modelStatus && modelStatus.stage;
  const isReady = modelStatus && modelStatus.isReady;
  const isRecording = micState === "recording";
  const isBusy = micState === "processing" || micState === "optimizing";
  const needDownload = stage === "need_download";
  const downloading = stage === "downloading";
  const modelLoading = stage === "loading" || (modelStatus && !isReady && !needDownload && !downloading);

  let statusText;
  if (needDownload) statusText = "需要下载语音模型";
  else if (downloading) statusText = `下载模型 ${modelStatus.downloadProgress || 0}%`;
  else if (modelLoading) statusText = "模型加载中…";
  else if (stage === "error") statusText = "模型出错";
  else if (isRecording) statusText = "正在录音，再按一下结束";
  else if (micState === "processing") statusText = "识别中…";
  else if (micState === "optimizing") statusText = "生成文案中…";
  else statusText = `按 ${hotkeyLabel || "左 Option"} 说话`;

  let badge;
  if (downloading || isBusy || modelLoading) {
    badge = <Loader2 className="w-3 h-3 animate-spin text-gray-900" />;
  } else if (needDownload) {
    badge = <Download className="w-3 h-3 text-gray-900" />;
  } else {
    badge = <Check className="w-3 h-3 text-gray-900" strokeWidth={3} />;
  }

  const handleBadge = () => {
    if (needDownload) {
      onDownloadModels && onDownloadModels();
      return;
    }
    if (!disabled) onToggle && onToggle();
  };

  const waveClass = isRecording ? "is-recording" : isBusy ? "is-busy" : "";

  return (
    <div className="pill-root">
      <div className="recorder-pill" title={statusText}>
        {/* 左：白色对勾徽章（点按开始/停止录音） */}
        <button
          type="button"
          onClick={handleBadge}
          className="pill-badge"
          aria-label={needDownload ? "下载模型" : isRecording ? "停止录音" : "开始录音"}
          disabled={disabled && !needDownload}
        >
          {badge}
        </button>

        {/* 中：声波 */}
        <div className={`pill-wave ${waveClass}`} aria-hidden="true">
          {Array.from({ length: BAR_COUNT }).map((_, i) => (
            <span key={i} className="pill-bar" style={{ animationDelay: `${i * 55}ms` }} />
          ))}
        </div>

        {/* 右：历史（悬停显示）+ 金色 ✨（打开设置） */}
        <div className="pill-actions">
          <button type="button" onClick={onOpenHistory} className="pill-ghost" aria-label="历史记录">
            <HistoryIcon className="w-3 h-3" />
          </button>
          <button type="button" onClick={onOpenSettings} className="pill-sparkle" aria-label="设置">
            <Sparkles className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default RecorderPill;
