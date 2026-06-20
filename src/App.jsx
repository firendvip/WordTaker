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
  const prevRecordingRef = useRef(false);
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
    startRecording,
    stopRecording,
    cancelRecording,
    requestRawStop,
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
      window.electronAPI?.log?.('error', "粘贴文本失败:", error);
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
      // 粘贴完成后隐藏胶囊（不再常驻前台）
      try {
        if (window.electronAPI && window.electronAPI.hideRecorder) {
          await window.electronAPI.hideRecorder();
        }
      } catch (e) {
        // 忽略
      }
    }
  }, [safePaste]);

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

  // 唤起/结束提示音：每次播放都从设置读取最新音色/音量，
  // 保证在设置里改完即时生效，而不是沿用启动时缓存的旧值。
  useEffect(() => {
    const prev = prevRecordingRef.current;
    prevRecordingRef.current = isRecording;
    const isWake = !prev && isRecording;
    const isEnd = prev && !isRecording;
    if (!isWake && !isEnd) return;
    (async () => {
      let { scheme, volume } = soundCfgRef.current;
      try {
        if (window.electronAPI && window.electronAPI.getSetting) {
          scheme = await window.electronAPI.getSetting("sound_scheme", scheme);
          volume = await window.electronAPI.getSetting("sound_volume", volume);
          soundCfgRef.current = { scheme, volume };
        }
      } catch (e) {
        // 读取失败则沿用缓存值
      }
      if (isWake) playWake(scheme, volume);
      else playEnd(scheme, volume);
    })();
  }, [isRecording]);

  // 监听 Esc 取消事件：取消录音并隐藏胶囊
  useEffect(() => {
    if (!window.electronAPI || !window.electronAPI.onCancelRecording) return;
    const off = window.electronAPI.onCancelRecording(() => {
      cancelRecording();
      if (window.electronAPI.hideRecorder) window.electronAPI.hideRecorder();
    });
    return () => {
      if (typeof off === "function") off();
    };
  }, [cancelRecording]);

  // 监听"不走 API 的结束键"：标记本句跳过大模型，再正常停止录音（贴原始识别）
  useEffect(() => {
    if (!window.electronAPI || !window.electronAPI.onRawStop) return;
    const off = window.electronAPI.onRawStop(() => {
      requestRawStop();
    });
    return () => {
      if (typeof off === "function") off();
    };
  }, [requestRawStop]);

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

  // 把最新的回调写入 ref，供 useRecording 在录音完成时调用（替代 window 全局回调）
  useEffect(() => {
    onTranscriptionCompleteRef.current = handleRecordingComplete;
    onAIOptimizationCompleteRef.current = handleAIOptimizationComplete;
    return () => {
      onTranscriptionCompleteRef.current = null;
      onAIOptimizationCompleteRef.current = null;
    };
  }, [handleRecordingComplete, handleAIOptimizationComplete]);

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
    // 检查模型状态
    if (modelStatus.stage === 'need_download') {
      toast.warning("📥 请先下载AI模型文件");
      return;
    }
    
    if (modelStatus.stage === 'downloading') {
      toast.warning("⬇️ 模型正在下载中，请稍候...");
      return;
    }
    
    if (modelStatus.stage === 'loading') {
      toast.warning("🤖 模型正在加载中，请稍候...");
      return;
    }
    
    if (modelStatus.stage === 'error') {
      toast.error(`❌ 模型错误: ${modelStatus.error}`);
      return;
    }
    
    if (!modelStatus.isReady) {
      toast.warning("⏳ 模型未就绪，请稍候...");
      return;
    }

    if (!isRecording && !isRecordingProcessing) {
      recordingStartRef.current = Date.now();
      startRecording();
    } else if (isRecording) {
      if (Date.now() - recordingStartRef.current < 800) {
        // ignore accidental immediate toggle (double-fire) so the pill doesn't vanish right after waking
        return;
      }
      stopRecording();
    }
  }, [modelStatus, isRecording, isRecordingProcessing, startRecording, stopRecording]);

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

  return (
    <RecorderPill
      micState={micState}
      audioLevel={audioLevel}
      audioBands={audioBands}
      modelStatus={modelStatus}
      hotkeyLabel={triggerLabel}
      translateState={translatePhase}
      pillSkin={pillSkin}
      disabled={micProps.disabled}
      onToggle={toggleRecording}
      onOpenSettings={handleOpenSettings}
      onOpenHistory={handleOpenHistory}
      onDownloadModels={handleDownloadModels}
    />
  );
}