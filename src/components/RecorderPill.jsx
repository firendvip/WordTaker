import React, { useState, useEffect, useMemo } from "react";
import {
  Check,
  Sparkles,
  History as HistoryIcon,
  Loader2,
  Download,
  AlertTriangle,
} from "lucide-react";

// 音符调色板与字形（说话/静音两种中部动画共用）
const NOTE_GLYPHS = ['♪','♫','♬','♩','♭'];
const NOTE_COLORS = ['#7DB4FF','#5FD8C4','#F7A8CB','#FFD36B','#B9A6FF','#9FE89A','#FFFFFF'];

// 说话时上升音符：最多 14 个，按音量裁切；预生成稳定池，下标 i 的视觉属性整段录音保持不变
const MAX_NOTES = 14;
// 音量阈值：高于此值视为"正在说话"→ 上升音符；否则 → 静止闪烁音符行
const SPEAK_THRESHOLD = 0.06;
// 静音/启动/处理中：一行闪烁的小音符（约 5 个）
const ROW_NOTE_COUNT = 5;

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
      <Loader2 size={15} className="animate-spin text-gray-900" />
    ) : (
      <Check size={15} className="text-gray-900" strokeWidth={3} />
    );
  } else if (modelFailed) {
    badge = <AlertTriangle size={15} className="text-gray-900" strokeWidth={2.5} />;
  } else if (downloading || isBusy || modelLoading) {
    badge = <Loader2 size={15} className="animate-spin text-gray-900" />;
  } else if (needDownload) {
    badge = <Download size={15} className="text-gray-900" />;
  } else {
    badge = <Check size={15} className="text-gray-900" strokeWidth={3} />;
  }

  const handleBadge = () => {
    if (needDownload) {
      onDownloadModels && onDownloadModels();
      return;
    }
    if (!disabled) onToggle && onToggle();
  };

  // 是否"正在说话"：录音中且平滑音量超过阈值 → 上升音符；否则 → 静止闪烁行
  const speaking = isRecording && (audioLevel || 0) > SPEAK_THRESHOLD;
  // 注：忙碌(processing/optimizing)状态暂复用静止闪烁行，不单独造动画

  // 音量越大、上升的音符越多（3..14）。乘 1.4 让中等音量也能铺满。
  const activeCount = Math.max(
    3,
    Math.min(MAX_NOTES, Math.round((audioLevel || 0) * MAX_NOTES * 1.4))
  );

  // 上升音符稳定池：以 isRecording 为 key 记忆，整段录音内下标 i 的字形/颜色/位置/尺寸/时长/相位/旋转不变。
  // 渲染前 activeCount 个，按下标 key → 数量变化时从尾部增减，已显示的音符不会跳变。
  const notePool = useMemo(() => {
    if (!isRecording) return [];
    return Array.from({ length: MAX_NOTES }).map(() => {
      const dur = 1.3 + Math.random() * 1.4;
      return {
        glyph: NOTE_GLYPHS[Math.floor(Math.random() * NOTE_GLYPHS.length)],
        color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)],
        left: Math.random() * 100, // 0..100% 跨容器（容器宽 ~118px，居中于胶囊）
        size: 12 + Math.random() * 7, // 12..19px
        dur,
        delay: -(Math.random() * dur), // 负延迟：起始即处于动画中段，避免整齐起跳
        rot: Math.random() * 44 - 22,
      };
    });
  }, [isRecording]);

  // 静止闪烁行：固定的小音符（颜色/字形稳定），错峰闪烁形成柔和波浪
  const rowNotes = useMemo(
    () =>
      Array.from({ length: ROW_NOTE_COUNT }).map((_, i) => ({
        glyph: NOTE_GLYPHS[i % NOTE_GLYPHS.length],
        color: NOTE_COLORS[i % NOTE_COLORS.length],
      })),
    []
  );

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
        ) : speaking ? (
          // 正在说话：底部升起、上浮渐隐的彩色音符，数量随音量增减
          <div className="pill-notes" aria-hidden="true">
            {notePool.slice(0, activeCount).map((n, i) => (
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
          // 静音 / 启动 / 处理中：一行错峰闪烁的小音符（无上下浮动）
          <div className="pill-note-row" aria-hidden="true">
            {rowNotes.map((n, i) => (
              <span
                key={i}
                className="pill-note-blink"
                style={{ color: n.color, animationDelay: `${i * 160}ms` }}
              >
                {n.glyph}
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
