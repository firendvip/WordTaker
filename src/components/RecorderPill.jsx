import React, { useState, useEffect, useRef } from "react";
import {
  Check,
  Sparkles,
  History as HistoryIcon,
  Loader2,
  Download,
  AlertTriangle,
} from "lucide-react";
import CatSkin from "./CatSkin";
import CatSkinFx from "./CatSkinFx";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { voiceInkBarHeight } from "../utils/recorderAnimation";

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
  pillSkin = "music",
  catAwake = false,
  showPolishBubble = false,
  polishCharCount = 0,
  showQuotaExhaustedBubble = false,
  onQuotaBubbleShown,
  onQuotaBubbleDismiss,
  disabled,
  onToggle,
  onOpenSettings,
  onOpenHistory,
  onDownloadModels,
}) {
  const reducedMotion = usePrefersReducedMotion();
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

  // VoiceInk 15-bar 可视化：用 ref 直接写 DOM 高度，避免每帧 setState
  const vkBarsRef = useRef([]);          // array of 15 span refs
  const vkLevelRef = useRef(0);
  const breatheRowRef = useRef(null);    // music 皮肤呼吸音符行容器（rAF 写入 --amp）
  const pillRootRef = useRef(null);      // 胶囊根容器：用于「出现」时的轻微淡入
  useEffect(() => { vkLevelRef.current = audioLevel || 0; }, [audioLevel]);

  // 出现：窗口每次显示（document 从隐藏变可见）时，给胶囊加一次轻微 opacity 淡入。
  // 去掉了原生窗口「由小变大」的观感（尺寸本就瞬间到位），只保留 ~150ms 纯淡入；
  // 不触碰消失/结束路径。窗口是复用的（隐藏/显示而非重挂载），故用 visibilitychange 触发。
  useEffect(() => {
    const play = () => {
      const el = pillRootRef.current;
      if (!el || document.hidden) return;
      el.classList.remove("pill-appear");
      // 强制回流，确保连续两次显示都能重新触发动画
      void el.offsetWidth;
      el.classList.add("pill-appear");
    };
    // 首次挂载即淡入一次
    play();
    document.addEventListener("visibilitychange", play);
    return () => document.removeEventListener("visibilitychange", play);
  }, []);
  // music 皮肤音符上下晃动：用 rAF 缓动写入 --amp，突发/断续声音时幅度平滑过渡不抖
  const isRecordingForMusic = micState === "recording";
  useEffect(() => {
    if (pillSkin === 'voiceink') return;     // music skin only
    if (!isRecordingForMusic) return;
    let raf, cancelled = false, amp = 0;
    const tick = () => {
      if (cancelled) return;
      const target = Math.min(4, (vkLevelRef.current || 0) * 8);
      amp += (target - amp) * 0.08;
      const el = breatheRowRef.current;
      if (el) el.style.setProperty('--amp', amp.toFixed(2) + 'px');
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelled = true; if (raf) cancelAnimationFrame(raf); if (breatheRowRef.current) breatheRowRef.current.style.setProperty('--amp','0px'); };
  }, [pillSkin, isRecordingForMusic]);
  const isRecordingForVoiceInk = micState === "recording";
  useEffect(() => {
    if (pillSkin !== 'voiceink') return;

    const renderBars = (timeSeconds) => {
      for (let i = 0; i < 15; i++) {
        const el = vkBarsRef.current[i];
        if (!el) continue;
        const height = voiceInkBarHeight({
          index: i,
          timeSeconds,
          level: vkLevelRef.current,
          isRecording: isRecordingForVoiceInk,
          reducedMotion,
        });
        el.style.height = `${height.toFixed(1)}px`;
      }
    };

    // 停止录音立即归零；减少动态效果时保留静态录音轮廓，不启动持续帧循环。
    renderBars(0);
    if (!isRecordingForVoiceInk || reducedMotion) return;

    let raf;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      renderBars(performance.now() / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelled = true; if (raf) cancelAnimationFrame(raf); };
  }, [pillSkin, isRecordingForVoiceInk, reducedMotion]);

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

  // 小黑猫皮肤：仅渲染透明小黑猫（无胶囊/徽章/星标/按钮）
  if (pillSkin === "catfx") {
    return (
      <CatSkinFx
        micState={micState}
        audioLevel={audioLevel}
        isBusy={isBusy}
        awake={catAwake}
        reducedMotion={reducedMotion}
        showPolishBubble={showPolishBubble}
        polishCharCount={polishCharCount}
        showQuotaExhaustedBubble={showQuotaExhaustedBubble}
        onQuotaBubbleShown={onQuotaBubbleShown}
        onQuotaBubbleDismiss={onQuotaBubbleDismiss}
      />
    );
  }
  if (pillSkin === "cat") {
    return (
      <CatSkin
        micState={micState}
        isBusy={isBusy}
        awake={catAwake}
        reducedMotion={reducedMotion}
        showQuotaExhaustedBubble={showQuotaExhaustedBubble}
        onQuotaBubbleShown={onQuotaBubbleShown}
        onQuotaBubbleDismiss={onQuotaBubbleDismiss}
      />
    );
  }

  return (
    <div className="pill-root" ref={pillRootRef}>
      <div className={`recorder-pill${modelFailed ? " is-error" : ""}`} title={statusText}>
        {/* 左：白色对勾徽章（点按开始/停止录音） */}
        <button
          type="button"
          onClick={handleBadge}
          className="pill-badge"
          aria-label={needDownload ? "下载模型" : isRecording ? "停止录音" : "开始录音"}
          disabled={disabled && !needDownload}
        >
          {isRecording && pillSkin !== "voiceink" && (<>
            <span className="pill-badge-ring" aria-hidden="true" />
            <span className="pill-badge-ring" style={{ animationDelay: '0.9s' }} aria-hidden="true" />
          </>)}
          {badge}
        </button>

        {/* 中：翻译时显示进度条，否则显示声波 */}
        {showPolishBubble ? (
          // 长润色：有字数（开启流式）显示「已生成 N 字」；无字数（关闭流式=整体粘贴）显示不确定态「生成中…」
          <div className="pill-translate">
            <span className="pill-translate-label">
              {polishCharCount > 0 ? `已生成 ${polishCharCount} 字` : "生成中…"}
            </span>
            <div className="pill-progress" aria-hidden="true">
              <div
                className={"pill-progress-fill" + (polishCharCount > 0 ? "" : " pill-progress-indet")}
                style={polishCharCount > 0 ? { width: Math.min(95, polishCharCount * 1.2) + "%" } : undefined}
              />
            </div>
          </div>
        ) : isTranslateActive ? (
          <div className="pill-translate">
            <span className="pill-translate-label">转换为英文…</span>
            <div className="pill-progress" aria-hidden="true">
              <div
                className="pill-progress-fill"
                style={{ width: translateProgress + "%" }}
              />
            </div>
          </div>
        ) : pillSkin === "voiceink" && isBusy ? (
          // VoiceInk 皮肤忙碌中：转写中 + 假进度条
          <div className="pill-transcribe" aria-hidden="true">
            <span className="pill-transcribe-label">转写中</span>
            <div className="pill-transcribe-bar"><div className="pill-transcribe-fill" /></div>
          </div>
        ) : pillSkin === "voiceink" ? (
          // VoiceInk 皮肤：15 条音频可视化（高度由 rAF 直接写 DOM）
          <div
            className="pill-vk"
            aria-hidden="true"
            style={{ opacity: isRecording ? 0.85 : 0.5 }}
          >
            {Array.from({ length: 15 }).map((_, i) => (
              <span
                key={i}
                ref={(el) => (vkBarsRef.current[i] = el)}
                className="pill-vk-bar"
                style={{ height: "4px" }}
              />
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
          // 录音 / 空闲：一行轻柔呼吸的彩色音符；说话时整行随音量渐隐，静音时渐显
          <div className="pill-breathe-row" aria-hidden="true"
               ref={breatheRowRef}
               style={{ opacity: 1 }}>
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
