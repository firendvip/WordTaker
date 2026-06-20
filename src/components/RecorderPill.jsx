import React, { useState, useEffect } from "react";
import {
  Check,
  Sparkles,
  History as HistoryIcon,
  Loader2,
  Download,
  AlertTriangle,
} from "lucide-react";

// 静音 / 录音：胶囊中部一行轻柔“呼吸”的彩色音符（音量越大整行越淡）
const ROW_GLYPHS = ['♪','♫','♬','♩','♫','♪','♬'];
const ROW_COLORS = ['#7DB4FF','#5FD8C4','#F7A8CB','#FFD36B','#B9A6FF','#9FE89A','#F7A8CB'];

// 忙碌(processing/optimizing)：一行错峰上下弹跳的彩色音符（行进波，像钢琴键）
const BOUNCE_NOTES = [
  { glyph: '♪', color: '#7DB4FF', size: 11 },
  { glyph: '♫', color: '#5FD8C4', size: 13 },
  { glyph: '♬', color: '#F7A8CB', size: 11 },
  { glyph: '♩', color: '#FFD36B', size: 13 },
  { glyph: '♫', color: '#B9A6FF', size: 11 },
];

/**
 * 悬浮胶囊录音条（出现在光标附近）。
 * 纯展示组件：状态与回调由父级 App 注入。
 *
 * @param {{
 *   micState: 'idle'|'hover'|'recording'|'processing'|'optimizing',
 *   audioLevel?: number,
 *   audioBands?: number[],
 *   modelStatus: object,
 *   hotkeyLabel: string,
 *   translateState?: 'idle'|'translating'|'done'|'error',
 *   disabled?: boolean,
 *   onToggle: () => void,
 *   onOpenSettings: () => void,
 *   onOpenHistory: () => void,
 *   onDownloadModels: () => void,
 * }} props
 */
export function RecorderPill({
  micState,
  audioLevel = 0,
  audioBands = [],
  modelStatus,
  hotkeyLabel,
  translateState = "idle",
  disabled,
  onToggle,
  onOpenSettings,
  onOpenHistory,
  onDownloadModels,
}) {
  // 假进度条：快速冲到前段，再减速逼近 ~90%，完成时直接补满到 100%
  const [translateProgress, setTranslateProgress] = useState(0);
  useEffect(() => {
    if (translateState === "translating") {
      setTranslateProgress(10);
      const id = setInterval(() => {
        setTranslateProgress((p) => (p < 90 ? p + Math.max(0.6, (90 - p) * 0.07) : p));
      }, 50);
      return () => clearInterval(id);
    }
    if (translateState === "done") setTranslateProgress(100);
    if (translateState === "idle" || translateState === "error") setTranslateProgress(0);
  }, [translateState]);

  const isTranslating = translateState === "translating";
  const isTranslateActive = isTranslating || translateState === "done";
  const stage = modelStatus && modelStatus.stage;
  const isReady = modelStatus && modelStatus.isReady;
  const modelFailed = Boolean(modelStatus && modelStatus.modelFailed);
  const modelError = (modelStatus && modelStatus.modelError) || null;
  const isRecording = micState === "recording";
  const isBusy = micState === "processing" || micState === "optimizing";
  const needDownload = stage === "need_download";
  const downloading = stage === "downloading";
  // 失败时不再视为“加载中”，避免无限旋转
  const modelLoading = !modelFailed && (stage === "loading" || (modelStatus && !isReady && !needDownload && !downloading));

  let statusText;
  if (modelFailed) statusText = modelError || "语音引擎未启动，请重启应用";
  else if (needDownload) statusText = "需要下载语音模型";
  else if (downloading) statusText = `下载模型 ${modelStatus.downloadProgress || 0}%`;
  else if (modelLoading) statusText = "模型加载中…";
  else if (stage === "error") statusText = "模型出错";
  else if (isRecording) statusText = "正在录音，再按一下结束";
  else if (micState === "processing") statusText = "识别中…";
  else if (micState === "optimizing") statusText = "生成文案中…";
  else statusText = `按 ${hotkeyLabel || "左 Option"} 说话`;

  let badge;
  if (isTranslateActive) {
    badge = isTranslating ? (
      <Loader2 size={10} className="animate-spin text-gray-900" />
    ) : (
      <Check size={10} className="text-gray-900" strokeWidth={3} />
    );
  } else if (modelFailed) {
    badge = <AlertTriangle size={10} className="text-gray-900" strokeWidth={2.5} />;
  } else if (downloading || isBusy || modelLoading) {
    badge = <Loader2 size={10} className="animate-spin text-gray-900" />;
  } else if (needDownload) {
    badge = <Download size={10} className="text-gray-900" />;
  } else {
    badge = <Check size={10} className="text-gray-900" strokeWidth={3} />;
  }

  const handleBadge = () => {
    if (needDownload) {
      onDownloadModels && onDownloadModels();
      return;
    }
    if (!disabled) onToggle && onToggle();
  };

  return (
    <div className="pill-root">
      <div className={`recorder-pill${modelFailed ? " is-error" : ""}`} title={statusText}>
        {/* 左：白色对勾徽章（点按开始/停止录音） */}
        <button
          type="button"
          onClick={handleBadge}
          className="pill-badge"
          aria-label={needDownload ? "下载模型" : isRecording ? "停止录音" : "开始录音"}
          disabled={disabled && !needDownload}
        >
          {isRecording && (<>
            <span className="pill-badge-ring" aria-hidden="true" />
            <span className="pill-badge-ring" style={{ animationDelay: '0.9s' }} aria-hidden="true" />
          </>)}
          {badge}
        </button>

        {/* 中：翻译时显示进度条，否则显示声波 */}
        {isTranslateActive ? (
          <div className="pill-translate">
            <span className="pill-translate-label">转换为英文…</span>
            <div className="pill-progress" aria-hidden="true">
              <div
                className="pill-progress-fill"
                style={{ width: translateProgress + "%" }}
              />
            </div>
          </div>
        ) : isBusy ? (
          // 忙碌：一行错峰上下弹跳的彩色音符（行进波）
          <div className="pill-note-row pill-note-bounce-row" aria-hidden="true">
            {BOUNCE_NOTES.map((n, i) => (
              <span
                key={i}
                className="pill-note-bounce"
                style={{ color: n.color, fontSize: `${n.size}px`, animationDelay: `${(i * 0.12).toFixed(2)}s` }}
              >
                {n.glyph}
              </span>
            ))}
          </div>
        ) : (
          // 录音 / 空闲：一行轻柔呼吸的彩色音符；说话时整行随音量渐隐，静音时渐显
          <div className="pill-breathe-row" aria-hidden="true"
               style={{ opacity: isRecording ? Math.max(0, 1 - Math.min(1,(audioLevel||0)*2.2)) : 1 }}>
            {ROW_GLYPHS.map((g, i) => (
              <span key={i} className="pill-breathe-note"
                    style={{ color: ROW_COLORS[i % ROW_COLORS.length], animationDelay: `${(i*0.18).toFixed(2)}s` }}>
                {g}
              </span>
            ))}
          </div>
        )}

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
