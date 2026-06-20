import React, { useState, useEffect, useMemo } from "react";
import {
  Check,
  Sparkles,
  History as HistoryIcon,
  Loader2,
  Download,
  AlertTriangle,
} from "lucide-react";

const BAR_COUNT = 13; // 与 useRecording 的 BAND_COUNT 保持一致
const SILENT_FLOOR = 0.3; // 静止时柱子读作较长的竖线

// 录音中：胶囊中部漂浮的彩色音符（纯 CSS 动画，不依赖音量输入）
const NOTE_GLYPHS = ['♪','♫','♬','♩','♭'];
const NOTE_COLORS = ['#7DB4FF','#5FD8C4','#F7A8CB','#FFD36B','#B9A6FF','#9FE89A','#FFFFFF'];
const NOTE_COUNT = 10;

/**
 * 悬浮胶囊录音条（出现在光标附近）。
 * 纯展示组件：状态与回调由父级 App 注入。
 *
 * @param {{
 *   micState: 'idle'|'hover'|'recording'|'processing'|'optimizing',
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
      <Loader2 className="w-3 h-3 animate-spin text-gray-900" />
    ) : (
      <Check className="w-3 h-3 text-gray-900" strokeWidth={3} />
    );
  } else if (modelFailed) {
    badge = <AlertTriangle className="w-3 h-3 text-gray-900" strokeWidth={2.5} />;
  } else if (downloading || isBusy || modelLoading) {
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

  const waveClass = isBusy ? "is-busy" : "";

  // 录音开始时重新生成随机音符配置（位置/颜色/字形/时长随机）
  const notes = useMemo(() => {
    if (!isRecording) return [];
    return Array.from({ length: NOTE_COUNT }).map(() => {
      const dur = 1.3 + Math.random() * 1.4;
      return {
        glyph: NOTE_GLYPHS[Math.floor(Math.random() * NOTE_GLYPHS.length)],
        color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)],
        left: 5 + Math.random() * 90,
        size: 12 + Math.random() * 7,
        dur,
        delay: -(Math.random() * dur),
        rot: Math.random() * 44 - 22,
      };
    });
  }, [isRecording]);

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
        ) : isRecording ? (
          <div className="pill-notes" aria-hidden="true">
            {notes.map((n, i) => (
              <span
                key={i}
                className="pill-note"
                style={{
                  left: `${n.left}%`,
                  color: n.color,
                  fontSize: `${n.size}px`,
                  '--r': `${n.rot}deg`,
                  animation: `pill-note-float ${n.dur.toFixed(2)}s ease-in-out ${n.delay.toFixed(2)}s infinite`,
                }}
              >
                {n.glyph}
              </span>
            ))}
          </div>
        ) : (
          <div className={`pill-wave ${waveClass}`} aria-hidden="true">
            {Array.from({ length: BAR_COUNT }).map((_, i) => (
              // 非录音 / 处理中：沿用 CSS 关键帧动画（按 animationDelay 错峰）
              <span key={i} className="pill-bar" style={{ animationDelay: `${i * 55}ms` }} />
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
