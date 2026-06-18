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

// 声波图标组件（空闲/悬停状态）
const SoundWaveIcon = ({ size = 16, isActive = false }) => {
  return (
    <div className="flex items-center justify-center gap-1">
      {[...Array(4)].map((_, i) => (
        <div
          key={i}
          className={`bg-slate-600 dark:bg-gray-300 rounded-full transition-all duration-150 shadow-sm ${
            isActive ? "wave-bar" : ""
          }`}
          style={{
            width: size * 0.15,
            height: isActive ? size * 0.8 : size * 0.4,
            animationDelay: isActive ? `${i * 0.1}s` : "0s",
          }}
        />
      ))}
    </div>
  );
};

// 加载指示器组件（FunASR启动中）
const LoadingIndicator = ({ size = 20 }) => {
  return (
    <div className="flex items-center justify-center gap-0.5">
      {[...Array(3)].map((_, i) => (
        <div
          key={i}
          className="w-1 bg-gray-500 rounded-full"
          style={{
            height: size * 0.6,
            animation: `loading-dots 1.4s ease-in-out infinite`,
            animationDelay: `${i * 0.2}s`,
          }}
        />
      ))}
    </div>
  );
};

// 语音波形指示器组件（处理状态）
const VoiceWaveIndicator = ({ isListening }) => {
  return (
    <div className="flex items-center justify-center gap-0.5">
      {[...Array(4)].map((_, i) => (
        <div
          key={i}
          className={`w-0.5 bg-white rounded-full transition-all duration-150 drop-shadow-sm ${
            isListening ? "animate-pulse h-5" : "h-2"
          }`}
          style={{
            animationDelay: isListening ? `${i * 0.1}s` : "0s",
            animationDuration: isListening ? `${0.6 + i * 0.1}s` : "0s",
          }}
        />
      ))}
    </div>
  );
};

// 增强的工具提示组件
const Tooltip = ({ children, content, position = "top" }) => {
  const [isVisible, setIsVisible] = useState(false);

  const getPositionClasses = () => {
    if (position === "bottom") {
      return {
        tooltip: "absolute top-full left-1/2 transform -translate-x-1/2 mt-2 px-2 py-1 text-white bg-gradient-to-r from-neutral-800 to-neutral-700 rounded-md whitespace-nowrap z-50 transition-opacity duration-150",
        arrow: "absolute bottom-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-2 border-r-2 border-b-2 border-transparent border-b-neutral-800"
      };
    }
    // 默认为顶部
    return {
      tooltip: "absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 text-white bg-gradient-to-r from-neutral-800 to-neutral-700 rounded-md whitespace-nowrap z-50 transition-opacity duration-150",
      arrow: "absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-2 border-r-2 border-t-2 border-transparent border-t-neutral-800"
    };
  };

  const { tooltip, arrow } = getPositionClasses();

  return (
    <div className="relative inline-block">
      <div
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
      >
        {children}
      </div>
      {isVisible && (
        <div
          className={tooltip}
          style={{ fontSize: "10px" }}
        >
          {content}
          <div className={arrow}></div>
        </div>
      )}
    </div>
  );
};

// 文本显示区域组件
const TextDisplay = ({ originalText, processedText, isProcessing, onCopy, onExport, onPaste }) => {
  if (!originalText && !processedText) {
    return null; // 当没有文本时不显示任何内容，避免重复
  }

  return (
    <div className="space-y-4">
      {/* 原始识别文本 - 简化设计，单行显示 */}
      {originalText && (
        <div className="bg-slate-100/80 dark:bg-gray-800/80 rounded-lg p-3 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="chinese-content text-gray-800 dark:text-gray-200 flex-1 truncate pr-2">
              {originalText}
            </p>
            <button
              onClick={() => onCopy(originalText)}
              className="p-1.5 hover:bg-slate-200/70 dark:hover:bg-gray-700/70 rounded-md transition-colors flex-shrink-0"
              title="复制识别文本"
            >
              <Copy className="w-4 h-4 text-slate-600 dark:text-gray-400" />
            </button>
          </div>
        </div>
      )}

      {/* AI处理后文本 */}
      {(processedText || isProcessing) && (
        <div className="bg-gradient-to-br from-emerald-50 to-emerald-100 dark:from-emerald-900/20 dark:to-emerald-800/20 rounded-xl p-5 border-l-4 border-emerald-400 dark:border-emerald-500 shadow-lg border border-emerald-200/50 dark:border-emerald-700/50">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-semibold chinese-title text-emerald-700 dark:text-emerald-400">AI优化后</h3>
            <div className="flex space-x-2">
              {processedText && (
                <>
                  <button
                    onClick={() => onPaste(processedText)}
                    className="p-2 hover:bg-emerald-200/70 dark:hover:bg-emerald-700/30 rounded-lg transition-colors shadow-sm"
                    title="粘贴优化文本"
                  >
                    <svg className="w-5 h-5 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                  </button>
                  <button
                    onClick={() => onCopy(processedText)}
                    className="p-2 hover:bg-emerald-200/70 dark:hover:bg-emerald-700/30 rounded-lg transition-colors shadow-sm"
                    title="复制优化文本"
                  >
                    <Copy className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                  </button>
                  <button
                    onClick={() => onExport(processedText)}
                    className="p-2 hover:bg-emerald-200/70 dark:hover:bg-emerald-700/30 rounded-lg transition-colors shadow-sm"
                    title="导出文本"
                  >
                    <Download className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                  </button>
                </>
              )}
            </div>
          </div>
          {isProcessing ? (
            <div className="flex items-center space-x-3 text-emerald-700 dark:text-emerald-400">
              <LoadingDots />
              <span className="status-text">AI正在优化文本...</span>
            </div>
          ) : (
            <p className="chinese-content leading-loose fade-in text-gray-800 dark:text-gray-200">
              {processedText}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default function App() {
  // 检查URL参数来决定渲染哪个页面
  const urlParams = new URLSearchParams(window.location.search);
  const page = urlParams.get('page');
  
  // 如果是设置页面，直接渲染设置组件
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

  const [isHovered, setIsHovered] = useState(false);
  const [originalText, setOriginalText] = useState("");
  const [processedText, setProcessedText] = useState("");
  const [showTextArea, setShowTextArea] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

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
  
  const {
    isRecording,
    isProcessing: isRecordingProcessing,
    isOptimizing,
    startRecording,
    stopRecording,
    cancelRecording,
    requestRawStop,
    error: recordingError
  } = useRecording();
  
  const {
    processText,
    isProcessing: isTextProcessing,
    error: textProcessingError
  } = useTextProcessing();

  // 防重复粘贴的引用
  const lastPasteRef = useRef({ text: '', timestamp: 0 });
  const PASTE_DEBOUNCE_TIME = 1000; // 1秒内相同文本不重复粘贴

  // 安全粘贴函数
  const safePaste = useCallback(async (text) => {
    const now = Date.now();
    const lastPaste = lastPasteRef.current;
    
    // 防重复粘贴：如果是相同文本且在防抖时间内，则跳过
    if (lastPaste.text === text && (now - lastPaste.timestamp) < PASTE_DEBOUNCE_TIME) {
      console.log("🚫 跳过重复粘贴，文本:", text.substring(0, 50) + "...");
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
      console.error("粘贴文本失败:", error);
    }
  }, []);

  // 处理录音完成（FunASR识别完成）
  const handleRecordingComplete = useCallback(async (transcriptionResult) => {
    console.log("🎤 handleRecordingComplete 被调用:", transcriptionResult);
    if (transcriptionResult.success && transcriptionResult.text) {
      console.log("✅ 转录成功，文本:", transcriptionResult.text);
      // 立即显示FunASR识别的原始文本
      setOriginalText(transcriptionResult.text);
      setShowTextArea(true);
      
      // 清空之前的处理结果，等待AI优化
      setProcessedText("");

      // 不立即粘贴，等待AI处理完成后再粘贴；不弹任何提示
      // 注意：不在这里保存到数据库，由 useRecording.js 统一处理保存逻辑
    } else {
      console.log("转录失败或无文本:", transcriptionResult);
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
            console.warn("写入剪贴板失败:", e);
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
  }, [isRecording]);

  // 唤起/结束提示音（录音开始 → 唤起音；录音结束 → 结束音）
  useEffect(() => {
    const prev = prevRecordingRef.current;
    if (!prev && isRecording) {
      playWake(soundCfgRef.current.scheme, soundCfgRef.current.volume);
    } else if (prev && !isRecording) {
      playEnd(soundCfgRef.current.scheme, soundCfgRef.current.volume);
    }
    prevRecordingRef.current = isRecording;
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

  // 设置转录完成回调
  useEffect(() => {
    console.log('设置回调函数');
    window.onTranscriptionComplete = handleRecordingComplete;
    window.onAIOptimizationComplete = handleAIOptimizationComplete;
    
    // 验证回调函数是否正确设置
    console.log('回调函数设置完成:', {
      onTranscriptionComplete: typeof window.onTranscriptionComplete,
      onAIOptimizationComplete: typeof window.onAIOptimizationComplete
    });
    
    return () => {
      console.log('清理回调函数');
      window.onTranscriptionComplete = null;
      window.onAIOptimizationComplete = null;
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
      console.error("复制文本失败:", error);
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
      console.error('下载模型失败:', error);
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
      startRecording();
    } else if (isRecording) {
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
      console.log('控制面板窗口，跳过热键注册');
      return;
    }

    // 录音触发键现由主进程统一管理：
    //  - 裸修饰键（如单击左 Option / 双击 Alt）经 uiohook 监听
    //  - 普通组合键经 Electron globalShortcut
    // 渲染层只需监听 'hotkey-triggered' 事件并 toggle 录音，避免重复注册造成冲突。
    console.log('录音触发键由主进程管理，渲染层仅监听 hotkey-triggered');
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
        console.log('收到热键触发事件:', data);
        console.log('当前录音状态:', isRecording, '处理状态:', isRecordingProcessing);
        toggleRecording();
      });

      // 监听旧的toggle事件（保持兼容性）
      const unsubscribeToggle = window.electronAPI.onToggleDictation(() => {
        console.log('收到旧版toggle事件');
        console.log('当前录音状态:', isRecording, '处理状态:', isRecordingProcessing);
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
      modelStatus={modelStatus}
      hotkeyLabel={triggerLabel}
      disabled={micProps.disabled}
      onToggle={toggleRecording}
      onOpenSettings={handleOpenSettings}
      onOpenHistory={handleOpenHistory}
      onDownloadModels={handleDownloadModels}
    />
  );
}