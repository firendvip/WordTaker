import React, { useState, useEffect, useMemo, useRef } from "react";
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

// 静音/启动/处理中：一行闪烁的小音符（约 5 个）
const ROW_NOTE_COUNT = 5;

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
  // 音量镜像 ref：让 spawn 循环读取最新音量，而不依赖重新渲染
  const audioLevelRef = useRef(0);
  useEffect(() => { audioLevelRef.current = audioLevel || 0; }, [audioLevel]);

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

  // 录音中的“生成式”音符场：每个音符独立 spawn，完整播放一次 fade-in→上浮→fade-out，
  // 完全淡出后才移除。音量越大、生成越密、音符越大。
  const [liveNotes, setLiveNotes] = useState([]);
  useEffect(() => {
    if (!isRecording) { setLiveNotes([]); return; }
    let cancelled = false, id = 0, timer = null;
    const spawn = () => {
      const lvl = Math.min(1, (audioLevelRef.current || 0) * 1.4);
      const nid = ++id;
      const dur = 1.7 + Math.random() * 0.9;
      const size = 9 + lvl * 7 + Math.random() * 2;
      const note = {
        id: nid,
        glyph: NOTE_GLYPHS[Math.floor(Math.random()*NOTE_GLYPHS.length)],
        color: NOTE_COLORS[Math.floor(Math.random()*NOTE_COLORS.length)],
        left: 6 + Math.random() * 88,
        size: Math.min(17, size),
        dur,
        rot: Math.random() * 40 - 20,
      };
      setLiveNotes(n => [...n, note]);
      setTimeout(() => { if (!cancelled) setLiveNotes(n => n.filter(x => x.id !== nid)); }, dur * 1000 + 80);
    };
    const schedule = () => {
      const lvl = Math.min(1, (audioLevelRef.current || 0) * 1.4);
      const interval = 120 + (1 - lvl) * 800;
      timer = setTimeout(() => { if (cancelled) return; spawn(); schedule(); }, interval);
    };
    spawn();
    schedule();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
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
        ) : isRecording ? (
          // 录音中：生成式上浮音符场，每个音符独立完整淡入→上浮→淡出一次
          <div className="pill-notes" aria-hidden="true">
            {liveNotes.map(n => (
              <span
                key={n.id}
                className="pill-note"
                style={{
                  left: `${n.left}%`,
                  color: n.color,
                  fontSize: `${n.size}px`,
                  '--r': `${n.rot}deg`,
                  animation: `pill-note-float ${n.dur.toFixed(2)}s ease-out forwards`,
                }}
              >
                {n.glyph}
              </span>
            ))}
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
          // 空闲 / 启动（未录音）：一行错峰闪烁的小音符（无上下浮动）
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
