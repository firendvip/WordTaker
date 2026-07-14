import React, { useState, useEffect, useRef, useCallback } from "react";
import "./index.css";
import { toast } from "sonner";
import { LoadingDots } from "./components/ui/loading-dots";
import { useHotkey } from "./hooks/useHotkey";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { useRecording } from "./hooks/useRecording";
import { useTextProcessing } from "./hooks/useTextProcessing";
import { useModelStatus } from "./hooks/useModelStatus";
import { usePermissions } from "./hooks/usePermissions";
import { Mic, MicOff, Settings, History, Copy, Download } from "lucide-react";
import RecorderPill from "./components/RecorderPill";
import { playWake, playEnd, warmupAudio } from "./utils/sounds";

// 动态导入设置页面组件
const SettingsPage = React.lazy(() => import('./settings.jsx').then(module => ({ default: module.SettingsPage })));

// 多猫并存：布局常量（与 useRecording 的 MAX_CATS/颜色池配套）。
const SLOT_W = 180;         // 每猫槽宽（= 胶囊窗口宽）
const SLOT_H = 88;          // 每猫槽高（cat 皮肤高，头顶特效完整可见）
const GAP = 10;             // 猫间竖直间距
const CAT0_Y_OFFSET = 24;   // 首猫相对光标点下移量（与 windowManager CURSOR_GAP_PX 对齐）

// 会话 phase → RecorderPill/CatSkin 的 micState。
function phaseToMicState(phase) {
  switch (phase) {
    case 'recording': return 'recording';
    case 'transcribing': return 'processing';
    case 'polishing':
    case 'pasting': return 'optimizing';
    default: return 'idle';
  }
}

// 顶层路由：在调用任何 hooks 之前就分流。设置页与录音页各自是独立组件，
// 各自无条件地在顶部调用自己的 hooks，杜绝"条件性调用 hooks"（HOOK-1）。
export default function App() {
  const urlParams = new URLSearchParams(window.location.search);
  const page = urlParams.get('page');

  if (page === 'settings') {
    return (
      <React.Suspense fallback={
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center">
          <div className="flex items-center space-x-3">
            <LoadingDots />
            <span className="text-gray-700 dark:text-gray-300">加载设置页面...</span>
          </div>
        </div>
      }>
        <SettingsPage />
      </React.Suspense>
    );
  }

  return <RecorderApp />;
}

// 录音主界面（悬浮胶囊）：所有录音相关 hooks 都在这里无条件、按固定顺序调用。
function RecorderApp() {
  const [isHovered, setIsHovered] = useState(false);
  const [originalText, setOriginalText] = useState("");
  const [processedText, setProcessedText] = useState("");
  const [showTextArea, setShowTextArea] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [translatePhase, setTranslatePhase] = useState('idle'); // idle | translating | done | error
  const [pillSkin, setPillSkin] = useState('music'); // music | voiceink
  const [polishActive, setPolishActive] = useState(false); // 长润色：是否正在生成
  const [polishCharCount, setPolishCharCount] = useState(0); // 长润色：累计已生成字符数

  // 读取胶囊皮肤初始值（沿用现有 getSetting 模式）
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (!window.electronAPI || !window.electronAPI.getSetting) return;
        const skin = await window.electronAPI.getSetting('pill_skin', 'music');
        if (active && skin) setPillSkin(skin);
      } catch (e) {
        // 读取失败时使用默认皮肤 music
      }
    })();
    return () => { active = false; };
  }, []);

  // 订阅皮肤实时变更
  useEffect(() => {
    if (!window.electronAPI || !window.electronAPI.onPillSkinChanged) return;
    const off = window.electronAPI.onPillSkinChanged((_e, data) => {
      if (data && data.skin) setPillSkin(data.skin);
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  // 触发键标签（真实触发由主进程的 recording_trigger 决定，如"左 Option"/"双击左 Alt"）
  const [triggerLabel, setTriggerLabel] = useState("左 Option");
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (!window.electronAPI) return;
        const t = await window.electronAPI.getSetting("recording_trigger", null);
        if (!active || !t || !t.key) return;
        const names = {
          LeftOption: "左 Option", RightOption: "右 Option",
          LeftAlt: "左 Alt", RightAlt: "右 Alt",
          LeftMeta: "左 ⌘", RightMeta: "右 ⌘",
          LeftCtrl: "左 Ctrl", LeftShift: "左 Shift",
        };
        const base = names[t.key] || t.key;
        setTriggerLabel(t.taps === 2 ? `双击 ${base}` : base);
      } catch (e) {
        // 读取失败时使用默认标签
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // 提示音设置（唤起/结束）
  const soundCfgRef = useRef({ scheme: "soft", volume: 0.3 });
  useEffect(() => {
    (async () => {
      try {
        if (!window.electronAPI) return;
        const scheme = await window.electronAPI.getSetting("sound_scheme", "soft");
        const volume = await window.electronAPI.getSetting("sound_volume", 0.3);
        soundCfgRef.current = { scheme, volume };
      } catch (e) {
        // 读取失败用默认
      }
    })();
    // 预热音频上下文，避免首次唤起提示音被丢弃
    warmupAudio();
  }, []);

  const { isDragging, handleMouseDown, handleMouseMove, handleMouseUp, handleClick } = useWindowDrag();
  const modelStatus = useModelStatus();
  
  // 录音完成/优化完成回调用 ref 传给 useRecording（替代旧的 window 全局回调，
  // 既避免全局变量泄漏，又用 ref 规避 stale closure；handler 定义在后面，运行时才被调用）。
  const onTranscriptionCompleteRef = useRef(null);
  const onAIOptimizationCompleteRef = useRef(null);

  const {
    isRecording,
    isProcessing: isRecordingProcessing,
    isOptimizing,
    audioLevel,
    audioBands,
    sessions,
    removeSession,
    startRecording,
    stopRecording,
    cancelRecording,
    error: recordingError
  } = useRecording({ onTranscriptionCompleteRef, onAIOptimizationCompleteRef });
  
  const {
    processText,
    isProcessing: isTextProcessing,
    error: textProcessingError
  } = useTextProcessing();

  // 防重复粘贴的引用
  const lastPasteRef = useRef({ text: '', timestamp: 0 });
  // 录音开始时间戳：忽略录音刚开始(<800ms)的二次 toggle（单击左 Option 偶发双触发），
  // 防止刚唤醒就 start→立即 stop→空音频→胶囊消失。
  const recordingStartRef = useRef(0);
  const PASTE_DEBOUNCE_TIME = 1000; // 1秒内相同文本不重复粘贴

  // 多猫并存：位置分配（旧猫原地不动，新猫下方堆叠，放不下翻上方）。
  // layoutRef: id→{x,y}（屏幕坐标，左上角）；workAreaRef: 本次 stack 的工作区（首猫时取，清空后重置）；
  // baseXRef: 全体猫共用的 x（=首猫 x）；cat0YRef: 首猫 y；hadCatsRef: 是否曾有猫（用于「空则隐藏」）。
  const layoutRef = useRef(new Map());
  const workAreaRef = useRef(null);
  const baseXRef = useRef(0);
  const cat0YRef = useRef(0);
  const hadCatsRef = useRef(false);
  // 渲染用的每猫窗口内相对坐标（仅在「猫集合(id)变化」时更新，避免每帧频谱刷新触发重排/几何 IPC）。
  const [catBoxes, setCatBoxes] = useState([]); // [{ id, left, top }]

  // 安全粘贴函数
  const safePaste = useCallback(async (text) => {
    const now = Date.now();
    const lastPaste = lastPasteRef.current;
    
    // 防重复粘贴：如果是相同文本且在防抖时间内，则跳过
    if (lastPaste.text === text && (now - lastPaste.timestamp) < PASTE_DEBOUNCE_TIME) {
      window.electronAPI?.log?.('info', "🚫 跳过重复粘贴，文本:", text.substring(0, 50) + "...");
      return;
    }
    
    // 更新最后粘贴记录
    lastPasteRef.current = { text, timestamp: now };
    
    try {
      if (window.electronAPI) {
        await window.electronAPI.pasteText(text);
      } else {
        await navigator.clipboard.writeText(text);
      }
    } catch (error) {
      // 粘贴失败：只写日志（主进程日志可见失败原因），不再弹系统通知打扰用户。
      // 文本仍留在剪贴板（pasteText 失败路径不会恢复原剪贴板），用户可随时手动粘贴。
      window.electronAPI?.log?.('error', "粘贴文本失败（已静默，文本留在剪贴板）:", error);
    }
  }, []);

  // 处理录音完成（FunASR识别完成）
  const handleRecordingComplete = useCallback(async (transcriptionResult) => {
    window.electronAPI?.log?.('info', "🎤 handleRecordingComplete 被调用:", transcriptionResult);
    if (transcriptionResult.success && transcriptionResult.text) {
      window.electronAPI?.log?.('info', "✅ 转录成功，文本:", transcriptionResult.text);
      // 立即显示FunASR识别的原始文本
      setOriginalText(transcriptionResult.text);
      setShowTextArea(true);
      
      // 清空之前的处理结果，等待AI优化
      setProcessedText("");

      // 不立即粘贴，等待AI处理完成后再粘贴；不弹任何提示
      // 注意：不在这里保存到数据库，由 useRecording.js 统一处理保存逻辑
    } else {
      window.electronAPI?.log?.('info', "转录失败或无文本:", transcriptionResult);
    }
  }, []);

  // 处理 LLM 处理完成（含文案模式）。按 result.paste 决定是否粘贴；全程不弹任何提示；完成后隐藏胶囊。
  const handleAIOptimizationComplete = useCallback(async (result) => {
    try {
      if (result && result.enhanced_by_ai && result.text) {
        setProcessedText(result.text);
      }
      if (result && result.llm_failed) {
        if (result.paste && result.text) {
          await safePaste(result.text);
        } else {
          // 不回退粘贴：仅把识别原文放进剪贴板（统一经主进程，避免与粘贴恢复抢剪贴板）
          try {
            if (window.electronAPI && window.electronAPI.writeClipboard) {
              await window.electronAPI.writeClipboard(result.text || "");
            } else {
              await navigator.clipboard.writeText(result.text || "");
            }
          } catch (e) {
            window.electronAPI?.log?.('warn', "写入剪贴板失败:", e);
          }
        }
      } else if (result && result.paste && result.text) {
        await safePaste(result.text);
      }
    } finally {
      // 多猫：粘贴完成后移除本猫 + 回收颜色（其它猫不受影响）。窗口隐藏由「sessions 空」的几何 effect
      // 统一驱动——最后一只猫消失时才 hideRecorder，故不再在此直接 hideRecorder。
      if (typeof result?.segId === 'number' && removeSession) {
        removeSession(result.segId);
      } else if (window.electronAPI && window.electronAPI.hideRecorder) {
        // 兜底：极端情况下无段号（不应发生），退回旧的隐藏行为，绝不留可见空窗。
        try { await window.electronAPI.hideRecorder(); } catch (e) { /* 忽略 */ }
      }
    }
  }, [safePaste, removeSession]);

  // 录音状态上报主进程（用于按需注册 Esc 取消键）
  useEffect(() => {
    if (window.electronAPI && window.electronAPI.setRecorderState) {
      window.electronAPI.setRecorderState(isRecording);
    }
    // 录音一开始就预热 LLM 连接，与说话时间重叠，省去后续请求的握手
    if (isRecording) {
      window.electronAPI?.prewarmLLM?.();
    }
  }, [isRecording]);

  // 唤起/结束提示音：按键瞬时反馈。
  // 旧实现挂在 isRecording 状态变化的 effect 上——开始音要等 getUserMedia+MediaRecorder
  // 启动完（数百毫秒）才响，且播放前还要 await 两次 IPC 读设置。
  // 现改为事件入口即刻播放：用缓存的音色/音量零等待出声（音频已在启动时
  // warmupAudio 预解码+resume），播完后台刷新设置缓存——设置改动最多晚一次触发生效。
  //
  // 只播一次守卫（修复 1.12.3 音色回归）：旧实现按 isRecording 的真实转换播音，
  // 触发键"偶发双触发"（见 recordingStartRef 注释）天然被去重；改到事件入口后，
  // 双触发时 isRecording 还没来得及变化，同一喵会被叠播两次（相隔几十毫秒），
  // 叠加相位干涉听感就是"喵声破掉/怪怪的"。cueStateRef 复刻旧转换语义：
  // 同方向的重复触发一律静默，保证每次开始/结束各只响一声。
  const cueStateRef = useRef(false); // true=已播唤起音、尚未播结束音
  const playCue = useCallback((isWake) => {
    if (cueStateRef.current === isWake) return; // 同方向重复（双触发/竞态）→ 不再叠播
    cueStateRef.current = isWake;
    const { scheme, volume } = soundCfgRef.current;
    if (isWake) playWake(scheme, volume);
    else playEnd(scheme, volume);
    // 后台刷新，不阻塞播放
    (async () => {
      try {
        if (window.electronAPI && window.electronAPI.getSetting) {
          const s = await window.electronAPI.getSetting("sound_scheme", scheme);
          const v = await window.electronAPI.getSetting("sound_volume", volume);
          soundCfgRef.current = { scheme: s, volume: v };
        }
      } catch (e) {
        // 读取失败则沿用缓存值
      }
    })();
  }, []);

  // 兜底：录音状态真实转换时补播提示音（与旧 effect 行为一致，经 cueStateRef 去重）。
  // 覆盖不经按键入口的结束路径——内存保护自动停止、MediaRecorder onerror 等，
  // 旧实现这些场景会响结束喵，事件入口版此前漏掉了。
  const prevRecordingRef = useRef(false);
  useEffect(() => {
    const prev = prevRecordingRef.current;
    prevRecordingRef.current = isRecording;
    if (!prev && isRecording) playCue(true); // 入口已播则被去重为静默
    else if (prev && !isRecording) playCue(false);
  }, [isRecording, playCue]);

  // 启动失败（getUserMedia 拒绝等）：唤起音已响但录音没开始，
  // 复位守卫，保证下一次唤起仍能出声（旧实现由 isRecording 驱动，天然无此问题）。
  useEffect(() => {
    if (recordingError && !isRecording) cueStateRef.current = false;
  }, [recordingError, isRecording]);

  // 监听 Esc 取消事件：取消录音并隐藏胶囊
  useEffect(() => {
    if (!window.electronAPI || !window.electronAPI.onCancelRecording) return;
    const off = window.electronAPI.onCancelRecording(() => {
      // 取消也即刻给声音反馈（沿用结束喵；旧实现由 isRecording 变化的 effect 播）
      if (isRecording) playCue(false);
      // 多猫：Esc 只取消「当前录音猫」（cancelRecording→onstop 移除该猫），其它猫不受影响。
      // 不再直接 hideRecorder——窗口隐藏交给「sessions 空」的几何 effect（仅最后一只消失时才隐藏）。
      cancelRecording();
    });
    return () => {
      if (typeof off === "function") off();
    };
  }, [cancelRecording, isRecording, playCue]);

  // 监听"转换为英文"状态：驱动胶囊的翻译进度 UI
  useEffect(() => {
    if (!window.electronAPI || !window.electronAPI.onTranslateStatus) return;
    const off = window.electronAPI.onTranslateStatus((_e, data) => {
      const phase = data && data.phase;
      if (phase === 'start') setTranslatePhase('translating');
      else if (phase === 'done') {
        setTranslatePhase('done');
        setTimeout(() => setTranslatePhase('idle'), 600);
      } else if (phase === 'error' || phase === 'cancel') {
        setTranslatePhase(phase === 'error' ? 'error' : 'idle');
        if (phase === 'error') setTimeout(() => setTranslatePhase('idle'), 900);
      }
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  // 监听长润色吐字进度：实时反映已生成字数，驱动小猫头顶进度气泡
  useEffect(() => {
    if (!window.electronAPI?.onPolishProgress) return;
    const off = window.electronAPI.onPolishProgress((data) => {
      const status = data && data.status;
      if (status === 'start') {
        setPolishActive(true);
        setPolishCharCount(0);
      } else if (status === 'delta') {
        setPolishCharCount(data.charCount || 0);
      } else if (status === 'done') {
        setPolishActive(false);
        setPolishCharCount(0);
      }
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  // 把最新的回调写入 ref，供 useRecording 在录音完成时调用（替代 window 全局回调）
  useEffect(() => {
    onTranscriptionCompleteRef.current = handleRecordingComplete;
    onAIOptimizationCompleteRef.current = handleAIOptimizationComplete;
    return () => {
      onTranscriptionCompleteRef.current = null;
      onAIOptimizationCompleteRef.current = null;
    };
  }, [handleRecordingComplete, handleAIOptimizationComplete]);

  // 多猫几何：仅在「猫集合(id 序列)」变化时重排 + 发送窗口 bounds（phase/频段刷新不触发，避免每帧 IPC）。
  const sessionIdsKey = sessions.map((s) => s.id).join(',');
  useEffect(() => {
    let cancelled = false;
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
    (async () => {
      // 无猫：清空布局；仅当之前有猫时才隐藏窗口（避免挂载即空、或 转英文/模型提示 等旧单胶囊场景被误隐藏）。
      if (sessions.length === 0) {
        layoutRef.current = new Map();
        workAreaRef.current = null;
        baseXRef.current = 0;
        cat0YRef.current = 0;
        setCatBoxes([]);
        if (hadCatsRef.current) {
          hadCatsRef.current = false;
          try { await window.electronAPI?.hideRecorder?.(); } catch (_) {}
        }
        return;
      }
      hadCatsRef.current = true;

      // 首猫：取锚点。anchor.{x,y} 已是首猫左上角（main 侧优先用窗口当前位置，尊重 pill_follow_focus，
      // 跟随输入框/跟随光标均已就位），此处直接 clamp 使用、不再二次偏移（避免把首猫拉回光标造成跳动）。
      if (!workAreaRef.current) {
        let anchor = null;
        try { anchor = await window.electronAPI?.getRecorderAnchor?.(); } catch (_) {}
        if (cancelled) return;
        const wa = (anchor && anchor.workArea) || { x: 0, y: 0, width: 1440, height: 900 };
        const ax = anchor && Number.isFinite(anchor.x) ? anchor.x : wa.x + wa.width / 2 - SLOT_W / 2;
        const ay = anchor && Number.isFinite(anchor.y) ? anchor.y : wa.y;
        workAreaRef.current = wa;
        baseXRef.current = Math.round(clamp(ax, wa.x, wa.x + wa.width - SLOT_W));
        cat0YRef.current = Math.round(clamp(ay, wa.y, wa.y + wa.height - SLOT_H));
      }

      const wa = workAreaRef.current;
      const baseX = baseXRef.current;
      const layout = layoutRef.current;

      // 为「尚无位置」的猫分配 y（按 id 升序=唤醒序）。旧猫位置不动。
      const pending = sessions.filter((s) => !layout.has(s.id)).sort((a, b) => a.id - b.id);
      for (const s of pending) {
        let y;
        if (layout.size === 0) {
          y = cat0YRef.current; // 首猫
        } else {
          const ys = [...layout.values()].map((p) => p.y);
          const below = Math.max(...ys) + SLOT_H + GAP;
          const above = Math.min(...ys) - GAP - SLOT_H;
          if (below + SLOT_H <= wa.y + wa.height) y = below;        // 下方放得下 → 堆下方
          else if (above >= wa.y) y = above;                        // 否则翻上方
          else y = clamp(below, wa.y, wa.y + wa.height - SLOT_H);   // 极端兜底（cap 10 一般不触发）
        }
        layout.set(s.id, { x: baseX, y });
      }

      // 清理已消失猫的位置（不移动其它猫）。
      const alive = new Set(sessions.map((s) => s.id));
      for (const id of [...layout.keys()]) if (!alive.has(id)) layout.delete(id);

      // union bounds：宽=SLOT_W，高=最低底边−最高顶边。
      const ys = [...layout.values()].map((p) => p.y);
      if (ys.length === 0) return;
      const minY = Math.min(...ys);
      const maxBottom = Math.max(...ys) + SLOT_H;
      const unionX = baseX;
      const unionY = minY;
      const height = maxBottom - minY;
      try {
        await window.electronAPI?.setRecorderBounds?.({ x: unionX, y: unionY, width: SLOT_W, height });
      } catch (_) {}
      if (cancelled) return;

      // 每猫窗口内相对坐标。
      const boxes = sessions.map((s) => {
        const p = layout.get(s.id);
        return { id: s.id, left: p.x - unionX, top: p.y - unionY };
      });
      setCatBoxes(boxes);
    })();
    return () => { cancelled = true; };
    // 依赖 sessionIdsKey：仅猫集合变化才重排；phase/bands 刷新不重跑几何。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionIdsKey]);

  // 处理复制文本
  const handleCopyText = async (text) => {
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.copyText(text);
        if (result.success) {
          toast.success("文本已复制到剪贴板");
        } else {
          throw new Error(result.error || "复制失败");
        }
      } else {
        await navigator.clipboard.writeText(text);
        toast.success("文本已复制到剪贴板");
      }
    } catch (error) {
      window.electronAPI?.log?.('error', "复制文本失败:", error);
      toast.error(`无法复制文本到剪贴板: ${error.message}`);
    }
  };


  // 处理导出文本
  const handleExportText = async (text) => {
    try {
      if (window.electronAPI) {
        await window.electronAPI.exportTranscriptions('txt');
        toast.success("文本已导出到文件");
      } else {
        // Web环境下载文件
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `语音转录_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      toast.error("无法导出文本文件");
    }
  };

  // 处理模型下载
  const handleDownloadModels = useCallback(async () => {
    try {
      // 显示开始下载的提示
      toast.info("📥 开始下载模型文件...");
      
      const result = await modelStatus.downloadModels();
      if (result.success) {
        toast.success("🎉 模型下载完成，正在加载...");
      } else {
        toast.error(`❌ 模型下载失败: ${result.error}`);
      }
    } catch (error) {
      window.electronAPI?.log?.('error', '下载模型失败:', error);
      toast.error(`❌ 模型下载失败: ${error.message}`);
    }
  }, [modelStatus]);

  // 切换录音状态
  const toggleRecording = useCallback(() => {
    // 唤醒键即时生效：只有"模型文件缺失/正在下载/致命错误"这种真的没法转写的情况才拦截。
    // 引擎只是"正在加载/未就绪"时，不再丢按键——立即开始录音（麦克风不依赖模型），
    // 音频会在停止时由主进程等引擎就绪后转写（见 funasrManager.transcribeAudio 排队逻辑）。
    if (modelStatus.stage === 'need_download') {
      toast.warning("📥 请先下载AI模型文件");
      return;
    }

    if (modelStatus.stage === 'downloading') {
      toast.warning("⬇️ 模型正在下载中，请稍候...");
      return;
    }

    if (modelStatus.stage === 'error') {
      toast.error(`❌ 模型错误: ${modelStatus.error}`);
      return;
    }

    if (!isRecording) {
      // 连说 / 尾段再唤醒：只要「当前没在录音」就允许开新段——即使上一段还在转写/润色/粘贴
      // (isRecordingProcessing)，新段也立即开录，旧段尾段在后台并行收尾（见 useRecording 按段隔离）。
      // 引擎还在加载：先给可见反馈，再照常开始录音并缓冲，绝不丢按键。
      if (!modelStatus.isReady) {
        toast.info("🤖 引擎加载中，已开始录音，将在就绪后自动转写…");
      }
      recordingStartRef.current = Date.now();
      // 开始喵先响再启动麦克风（不 await），保证按键瞬时反馈；
      // 若随后 getUserMedia 失败，声已响但会有现有的错误 toast 提示，可接受。
      playCue(true);
      startRecording();
    } else if (isRecording) {
      if (Date.now() - recordingStartRef.current < 800) {
        // ignore accidental immediate toggle (double-fire) so the pill doesn't vanish right after waking
        return;
      }
      // 结束喵同样在事件入口即刻响，再走停止/转写流程
      playCue(false);
      stopRecording();
    }
  }, [modelStatus, isRecording, isRecordingProcessing, startRecording, stopRecording, playCue]);

  // 使用热键Hook，不再使用F2双击功能
  const { hotkey, syncRecordingState, registerHotkey } = useHotkey();

  // 注册传统热键监听 - 只在主窗口注册，避免重复
  useEffect(() => {
    // 检查是否为控制面板窗口
    const urlParams = new URLSearchParams(window.location.search);
    const isControlPanel = urlParams.get('panel') === 'control';
    
    // 只有主窗口才注册热键
    if (isControlPanel) {
      window.electronAPI?.log?.('info', '控制面板窗口，跳过热键注册');
      return;
    }

    // 录音触发键现由主进程统一管理：
    //  - 裸修饰键（如单击左 Option / 双击 Alt）经 uiohook 监听
    //  - 普通组合键经 Electron globalShortcut
    // 渲染层只需监听 'hotkey-triggered' 事件并 toggle 录音，避免重复注册造成冲突。
    window.electronAPI?.log?.('info', '录音触发键由主进程管理，渲染层仅监听 hotkey-triggered');
  }, []);

  // 处理关闭窗口
  const handleClose = () => {
    if (window.electronAPI) {
      window.electronAPI.hideWindow();
    }
  };

  // 处理打开设置
  const handleOpenSettings = () => {
    if (window.electronAPI) {
      window.electronAPI.openSettingsWindow();
    } else {
      // Web环境下仍然使用模态框
      setShowSettings(true);
    }
  };

  // 处理打开历史记录
  const handleOpenHistory = () => {
    if (window.electronAPI) {
      window.electronAPI.openHistoryWindow();
    }
  };


  // 监听全局热键触发事件
  useEffect(() => {
    if (window.electronAPI) {
      // 监听传统热键触发
      const unsubscribeHotkey = window.electronAPI.onHotkeyTriggered((event, data) => {
        window.electronAPI?.log?.('info', '收到热键触发事件:', data);
        window.electronAPI?.log?.('info', '当前录音状态:', isRecording, '处理状态:', isRecordingProcessing);
        toggleRecording();
      });

      // 监听旧的toggle事件（保持兼容性）
      const unsubscribeToggle = window.electronAPI.onToggleDictation(() => {
        window.electronAPI?.log?.('info', '收到旧版toggle事件');
        window.electronAPI?.log?.('info', '当前录音状态:', isRecording, '处理状态:', isRecordingProcessing);
        toggleRecording();
      });

      return () => {
        if (unsubscribeHotkey) unsubscribeHotkey();
        if (unsubscribeToggle) unsubscribeToggle();
      };
    }
  }, [toggleRecording, isRecording, isRecordingProcessing]);

  // 同步录音状态到热键管理器
  useEffect(() => {
    if (syncRecordingState) {
      syncRecordingState(isRecording);
    }
  }, [isRecording, syncRecordingState]);

  // 监听键盘事件
  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };

    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, []);

  // 错误处理
  useEffect(() => {
    if (recordingError) {
      toast.error(recordingError);
    }
  }, [recordingError]);

  useEffect(() => {
    if (textProcessingError) {
      toast.error(textProcessingError);
    }
  }, [textProcessingError]);

  // 确定当前麦克风状态
  const getMicState = () => {
    if (isRecording) return "recording";
    if (isRecordingProcessing) return "processing";
    if (isOptimizing) return "optimizing";
    if (isHovered && !isRecording && !isRecordingProcessing && !isOptimizing) return "hover";
    return "idle";
  };

  const micState = getMicState();
  const isListening = isRecording || isRecordingProcessing;
  // 进入润色阶段即准备显示头顶进度气泡（开启/关闭流式均适用）。
  // 关闭流式=整体粘贴时也能显示"生成中…"的不确定提示（无字数）；
  // 开启流式时 onPolishProgress 会更新 polishCharCount，气泡显示"已生成 N 字"。
  const showPolishBubble = micState === 'optimizing';

  // 获取麦克风按钮属性
  const getMicButtonProps = () => {
    const baseClasses =
      "rounded-full w-16 h-16 flex items-center justify-center relative overflow-hidden border-2 border-white/80 transition-all duration-300 shadow-xl";

    // 统一的按钮样式，不再根据状态变色
    const buttonStyle = `${baseClasses} bg-gradient-to-br from-slate-100 to-slate-200 dark:from-gray-700 dark:to-gray-600 hover:from-slate-200 hover:to-slate-300 dark:hover:from-gray-600 dark:hover:to-gray-500 hover:shadow-2xl transform hover:scale-105`;

    // 如果模型未就绪，显示禁用状态（统一的灰色）
    if (!modelStatus.isReady) {
      return {
        className: `${baseClasses} bg-gradient-to-br from-gray-300 to-gray-400 dark:from-gray-600 dark:to-gray-700 cursor-not-allowed opacity-70`,
        tooltip: modelStatus.stage === 'need_download' ? "请先下载AI模型文件" :
                 modelStatus.stage === 'downloading' ? `模型下载中... ${modelStatus.downloadProgress || 0}%` :
                 modelStatus.stage === 'loading' ? "模型加载中，请稍候..." :
                 modelStatus.stage === 'error' ? `模型错误: ${modelStatus.error}` :
                 "模型未就绪，请稍候...",
        disabled: true
      };
    }

    switch (micState) {
      case "idle":
        return {
          className: `${buttonStyle} cursor-pointer`,
          tooltip: `按 [${hotkey}] 开始录音`,
          disabled: false
        };
      case "hover":
        return {
          className: `${buttonStyle} scale-105 shadow-2xl cursor-pointer`,
          tooltip: `按 [${hotkey}] 开始录音`,
          disabled: false
        };
      case "recording":
        return {
          className: `${buttonStyle} recording-pulse cursor-pointer`,
          tooltip: "正在录音...",
          disabled: false
        };
      case "processing":
        return {
          className: `${buttonStyle} cursor-not-allowed opacity-70`,
          tooltip: "正在识别语音...",
          disabled: true
        };
      case "optimizing":
        return {
          className: `${buttonStyle} cursor-not-allowed opacity-70`,
          tooltip: "AI正在优化文本...",
          disabled: true
        };
      default:
        return {
          className: `${buttonStyle} cursor-pointer`,
          tooltip: "点击开始录音",
          disabled: false
        };
    }
  };

  const micProps = getMicButtonProps();

  // 无猫：保留旧「单胶囊」渲染——用于 转英文进度 / 模型未就绪提示 / 唤醒未录音 等既有场景，
  // 几何仍由主进程 showRecorderAtBottom 管理，行为与多猫前完全一致（单猫回归零变化）。
  if (sessions.length === 0) {
    return (
      <RecorderPill
        micState={micState}
        audioLevel={audioLevel}
        audioBands={audioBands}
        modelStatus={modelStatus}
        hotkeyLabel={triggerLabel}
        translateState={translatePhase}
        pillSkin={pillSkin}
        showPolishBubble={showPolishBubble}
        polishCharCount={polishCharCount}
        disabled={micProps.disabled}
        onToggle={toggleRecording}
        onOpenSettings={handleOpenSettings}
        onOpenHistory={handleOpenHistory}
        onDownloadModels={handleDownloadModels}
      />
    );
  }

  // 多猫：遍历 sessions 渲染 N 只猫，每只按其窗口内相对坐标绝对定位。
  // 点击任意猫 = toggle 当前录音（与单猫一致）；颜色/phase 各猫独立。
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {sessions.map((s) => {
        // 首猫：窗口已由 showRecorderAtBottom 摆到光标下方(180×88)，其窗口内坐标即 (0,0)，
        // 故 box 未就绪时用 (0,0) 让首猫瞬间出现（单猫回归零延迟）；后续猫则等几何 effect 算好再渲染。
        const box =
          catBoxes.find((b) => b.id === s.id) ||
          (sessions.length === 1 ? { id: s.id, left: 0, top: 0 } : null);
        if (!box) return null; // 后续猫：几何 effect（异步取锚点）尚未就绪，暂不渲染，避免错位
        const isRec = s.phase === "recording";
        return (
          <div
            key={s.id}
            style={{ position: "absolute", left: box.left, top: box.top, width: SLOT_W, height: SLOT_H }}
          >
            <RecorderPill
              micState={phaseToMicState(s.phase)}
              audioLevel={isRec ? audioLevel : 0}
              audioBands={s.bands}
              color={s.color}
              modelStatus={modelStatus}
              hotkeyLabel={triggerLabel}
              translateState={translatePhase}
              pillSkin={pillSkin}
              showPolishBubble={s.phase === "polishing" || s.phase === "pasting"}
              polishCharCount={polishCharCount}
              disabled={micProps.disabled}
              onToggle={toggleRecording}
              onOpenSettings={handleOpenSettings}
              onOpenHistory={handleOpenHistory}
              onDownloadModels={handleDownloadModels}
            />
          </div>
        );
      })}
    </div>
  );
}