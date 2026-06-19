import { useState, useRef, useCallback, useEffect } from 'react';
import { useModelStatus } from './useModelStatus';
import { shouldSkipPolish } from '../utils/skipPolish';

/**
 * 录音功能Hook
 * 提供录音、停止录音、音频处理等功能
 */
export const useRecording = ({ onTranscriptionCompleteRef, onAIOptimizationCompleteRef } = {}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [error, setError] = useState(null);
  const [audioData, setAudioData] = useState(null);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  
  // 添加防重复处理机制
  const processingRef = useRef({ isProcessingAudio: false, lastProcessTime: 0 });
  // 取消标记：为 true 时停止录音不进行识别（用于 Esc 取消）
  const cancelledRef = useRef(false);
  // 代次：每段音频处理自增；异步 LLM 完成时若代次已变，说明有更新的录音，作废本次粘贴
  const generationRef = useRef(0);
  // 本次是否走"不走 API"的结束（按了 raw 结束键）：true 则只贴原始识别、不调用大模型
  const rawOnlyRef = useRef(false);

  // 使用模型状态Hook
  const modelStatus = useModelStatus();

  // 开始录音
  const startRecording = useCallback(async () => {
    try {
      setError(null);
      cancelledRef.current = false;
      rawOnlyRef.current = false; // 每次新录音重置"不走 API"标记

      // 检查FunASR是否就绪
      if (!modelStatus.isReady) {
        if (modelStatus.isLoading) {
          throw new Error('FunASR服务器正在启动中，请稍候...');
        } else if (modelStatus.error) {
          throw new Error('FunASR服务器未就绪，请检查配置');
        } else {
          throw new Error('正在准备FunASR服务器，请稍候...');
        }
      }

      // 检查浏览器支持
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('您的浏览器不支持录音功能');
      }

      // 请求麦克风权限
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      streamRef.current = stream;
      audioChunksRef.current = [];

      // 创建MediaRecorder
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
      });

      mediaRecorderRef.current = mediaRecorder;

      // 设置事件处理器
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        setIsRecording(false);

        // 已取消（Esc）：丢弃音频，不识别、不粘贴
        if (cancelledRef.current) {
          audioChunksRef.current = [];
          setIsProcessing(false);
          return;
        }

        setIsProcessing(true);

        try {
          // 创建音频Blob
          const audioBlob = new Blob(audioChunksRef.current, {
            type: 'audio/webm;codecs=opus'
          });

          setAudioData(audioBlob);

          // 处理音频
          await processAudio(audioBlob);
        } catch (err) {
          setError(`音频处理失败: ${err.message}`);
        } finally {
          setIsProcessing(false);
        }
      };

      mediaRecorder.onerror = (event) => {
        setError(`录音错误: ${event.error?.message || '未知错误'}`);
        setIsRecording(false);
        setIsProcessing(false);
      };

      // 开始录音
      mediaRecorder.start(1000); // 每秒收集一次数据
      setIsRecording(true);

    } catch (err) {
      setError(`无法开始录音: ${err.message}`);
      setIsRecording(false);
    }
  }, [modelStatus.isReady, modelStatus.isLoading, modelStatus.error]);

  // 停止录音
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();

      // 停止所有音频轨道
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
    }
  }, [isRecording]);

  // "不走 API 的结束"：标记本句跳过大模型，然后正常停止录音（贴原始识别）
  const requestRawStop = useCallback(() => {
    rawOnlyRef.current = true;
    stopRecording();
  }, [stopRecording]);

  // 处理音频
  const processAudio = useCallback(async (audioBlob) => {
    // 并发守卫：上一段还在处理时忽略本次，避免重复识别/重复粘贴/重复入库
    if (processingRef.current.isProcessingAudio) {
      if (window.electronAPI && window.electronAPI.log) {
        window.electronAPI.log('warn', '上一段音频仍在处理中，忽略本次重复处理');
      }
      return;
    }
    processingRef.current.isProcessingAudio = true;
    // 本次处理的代次；后面异步粘贴前会校验它是否仍是最新
    const myGen = ++generationRef.current;
    // 在同步阶段定格"是否不走 API"，避免后续被新录音重置造成竞态
    const rawOnly = rawOnlyRef.current;

    const tlog = (msg) => {
      if (window.electronAPI && window.electronAPI.log) window.electronAPI.log('info', msg);
    };

    try {
      const _cT0 = Date.now();
      const wavBlob = await convertToWav(audioBlob);
      tlog(`[计时] WAV转换: ${Date.now() - _cT0}ms`);

      if (window.electronAPI) {
        const arrayBuffer = await wavBlob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        // 识别引擎：默认 SenseVoice（快），可在设置切回 Paraformer
        let engine = 'sensevoice';
        try { engine = await window.electronAPI.getSetting('asr_engine', 'sensevoice'); } catch (e) {}
        const _tT0 = Date.now();
        const transcriptionResult = await window.electronAPI.transcribeAudio(uint8Array, { engine });
        tlog(`[计时] 转写往返(WAV→识别, ${engine}): ${Date.now() - _tT0}ms`);

        if (transcriptionResult.success) {
          const raw_text = transcriptionResult.text;

          // 未识别到有效语音：不提交大模型、不粘贴、不入库，直接收起胶囊
          if (!raw_text || !raw_text.trim()) {
            tlog('[计时] 未识别到有效语音，跳过LLM与粘贴');
            if (window.electronAPI && window.electronAPI.hideRecorder) {
              try { await window.electronAPI.hideRecorder(); } catch (e) {}
            }
            return { success: true, text: '', skipped: true };
          }

          // 准备转录数据
          const transcriptionData = {
            raw_text: raw_text,
            text: raw_text, // 初始文本设为原始文本
            confidence: transcriptionResult.confidence || 0,
            language: transcriptionResult.language || 'zh-CN',
            duration: transcriptionResult.duration || 0,
            file_size: uint8Array.length,
          };

          // 立即显示初步结果
          if (onTranscriptionCompleteRef?.current) {
            onTranscriptionCompleteRef?.current({ ...transcriptionResult, enhanced_by_ai: false });
          }

          // 异步处理 LLM 与保存（只保存一次）
          setIsOptimizing(true);
          setTimeout(async () => {
            const log = (level, ...args) => {
              if (window.electronAPI && window.electronAPI.log) {
                window.electronAPI.log(level, ...args);
              }
            };
            try {
              // 一次性快照所有设置：把热路径上原本 4~5 次串行 getSetting(IPC+读库)往返
              // 压成一次 getAllSettings，单句不会中途改设置，快照足够安全且更快。
              const _settings =
                (window.electronAPI.getAllSettings ? await window.electronAPI.getAllSettings() : null) || {};
              const getS = (k, d) => (_settings[k] !== undefined ? _settings[k] : d);

              // 文案模式：识别后必走 LLM，贴"模型结果"；旧版优化模式作为兼容回退
              let copywriting = getS('copywriting_mode_enabled', true);
              let useAI = getS('enable_ai_optimization', true);
              // 按了"不走 API 的结束键"：本句强制跳过大模型，直接贴原始识别
              if (rawOnly) {
                copywriting = false;
                useAI = false;
                log('info', 'raw 结束键：跳过大模型，直接贴原始识别');
              } else {
                // 短句优化：很短且干净的识别结果直接贴原文，省去一次 LLM 往返
                const maxChars = Number(getS('skip_polish_max_chars', 6)) || 6;
                if (shouldSkipPolish(raw_text, maxChars)) {
                  copywriting = false;
                  useAI = false;
                  log('info', `短句(≤${maxChars}字且干净)：跳过润色，直接贴原文`);
                }
              }

              let finalData = { ...transcriptionData };
              let emit;

              // 先落库原文（解耦·不阻塞）：识别成功后立即派发入库 IPC（主进程会同步写库），
              // 即使后续 LLM/流式卡住或异常，历史也不会丢。关键是【不 await】——绝不让一次
              // 数据库写入的往返挡在"出字"前面。润色完成后再用返回的行 id 异步补写同一行。
              let savePromise = null;
              if (window.electronAPI) {
                savePromise = window.electronAPI
                  .saveTranscription(transcriptionData)
                  .catch((err) => {
                    log('error', '原文落库失败:', err);
                    return null;
                  });
              }

              if (copywriting) {
                // —— 流式优先：开启 Web 函数流式时，边生成边贴(粘贴在主进程完成) ——
                let streamed = false;
                try {
                  const streaming = getS('llm_streaming_enabled', false);
                  if (streaming && window.electronAPI.processTextStream) {
                    const _sT0 = Date.now();
                    const sres = await window.electronAPI.processTextStream(raw_text);
                    if (sres && (sres.success || sres.pastedAny)) {
                      log('info', `[计时] 流式文案: ${Date.now() - _sT0}ms`);
                      const t = sres.text || raw_text;
                      finalData.processed_text = t;
                      finalData.text = t;
                      // 主进程已增量贴出，这里不再重复粘贴
                      emit = { ...transcriptionResult, text: t, processed_text: t, enhanced_by_ai: true, paste: false };
                      streamed = true;
                    }
                  }
                } catch (err) {
                  log('error', '流式文案异常，回退非流式:', err);
                }

                if (!streamed) {
                // —— 文案模式（非流式主路径）——
                log('info', '开始生成文案(LLM):', raw_text.substring(0, 50) + '...');
                let result = null;
                try {
                  const _lT0 = Date.now();
                  result = await window.electronAPI.processText(raw_text, 'copywriting');
                  log('info', `[计时] DeepSeek文案: ${Date.now() - _lT0}ms`);
                } catch (err) {
                  log('error', '文案生成调用异常:', err);
                }

                if (result && result.success && result.text) {
                  finalData.processed_text = result.text;
                  finalData.text = result.text;
                  emit = {
                    ...transcriptionResult,
                    text: result.text,
                    processed_text: result.text,
                    enhanced_by_ai: true,
                    paste: true,
                  };
                } else {
                  // LLM 失败：
                  //  - 未配置 API Key → 视为"纯听写"，照常粘贴识别原文（保证开箱可用）
                  //  - 已配置但调用失败 → 由 llm_fallback_paste_raw 决定是否回退贴原文（默认是）
                  const fallback = getS('llm_fallback_paste_raw', true);
                  const errMsg = (result && result.error) || 'AI 文案生成失败';
                  const noKey = /API\s*密钥|API\s*Key|api[_\s]?key/i.test(errMsg);
                  log('error', '文案生成失败:', errMsg);
                  emit = {
                    ...transcriptionResult,
                    text: raw_text,
                    enhanced_by_ai: false,
                    paste: noKey ? true : !!fallback,
                    llm_failed: true,
                    no_key: noKey,
                    error: errMsg,
                  };
                }
                } // end if(!streamed)
              } else if (useAI) {
                // —— 兼容：旧版可选润色 ——
                let result = null;
                try {
                  result = await window.electronAPI.processText(raw_text, 'optimize');
                } catch (err) {
                  log('error', 'AI文本优化捕获到错误:', err);
                }
                if (result && result.success) {
                  const processed_text = result.text;
                  finalData.processed_text = processed_text;
                  const changed = processed_text && processed_text.trim() !== raw_text.trim();
                  if (changed) finalData.text = processed_text;
                  emit = {
                    ...transcriptionResult,
                    text: finalData.text,
                    processed_text,
                    enhanced_by_ai: !!changed,
                    paste: true,
                  };
                } else {
                  emit = { ...transcriptionResult, text: raw_text, enhanced_by_ai: false, paste: true };
                }
              } else {
                // —— 不优化：直接贴原文 ——
                emit = { ...transcriptionResult, text: raw_text, enhanced_by_ai: false, paste: true };
              }

              // 先出字（最高优先级）：尽快把结果贴到光标处，绝不被数据库写入挡住。
              // 若期间已有更新的录音，作废本次粘贴（入库仍保留），避免贴出过期内容。
              if (myGen !== generationRef.current) {
                log('info', '已被更新的录音取代，跳过本次粘贴');
              } else if (onAIOptimizationCompleteRef?.current) {
                onAIOptimizationCompleteRef?.current(emit);
              }

              // 出字之后再异步补写润色结果到同一行（原文已在前面落库）。不 await，不阻塞出字。
              // 早先落库失败(行 id 为空)时兜底重新插入完整记录，确保历史不丢。
              if (window.electronAPI) {
                Promise.resolve(savePromise)
                  .then((r) => {
                    const sid = r && r.lastInsertRowid != null ? r.lastInsertRowid : null;
                    if (sid != null && window.electronAPI.updateTranscription) {
                      return window.electronAPI.updateTranscription(sid, {
                        text: finalData.text,
                        processed_text: finalData.processed_text,
                      });
                    }
                    return window.electronAPI.saveTranscription(finalData);
                  })
                  .catch((err) => log('error', '补写转录失败:', err));
              }
            } catch (err) {
              log('error', '处理和保存转录时出错:', err);
              if (onAIOptimizationCompleteRef?.current) {
                onAIOptimizationCompleteRef?.current({
                  ...transcriptionResult,
                  text: raw_text,
                  enhanced_by_ai: false,
                  paste: false,
                  llm_failed: true,
                  error: err.message,
                });
              }
            } finally {
              setIsOptimizing(false);
            }
          }, 0);

          return { ...transcriptionResult, enhanced_by_ai: false };
        } else {
          throw new Error(transcriptionResult.error || '语音识别失败');
        }
      } else {
        // Web环境模拟
        const mockResult = { success: true, text: '模拟识别结果。', confidence: 0.95, duration: 3.5 };
        if (onTranscriptionCompleteRef?.current) onTranscriptionCompleteRef?.current(mockResult);
        return mockResult;
      }
    } catch (err) {
      throw new Error(`音频处理失败: ${err.message}`);
    } finally {
      processingRef.current.isProcessingAudio = false;
    }
  }, []);

  // 转换音频格式为WAV
  const convertToWav = useCallback(async (audioBlob) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = async () => {
        try {
          const arrayBuffer = reader.result;

          // 创建AudioContext
          const audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 16000
          });

          // 解码音频数据
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

          // 转换为WAV格式
          const wavBuffer = audioBufferToWav(audioBuffer);
          const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });

          // 关闭AudioContext释放资源
          audioContext.close();

          resolve(wavBlob);
        } catch (err) {
          reject(new Error(`音频格式转换失败: ${err.message}`));
        }
      };

      reader.onerror = () => {
        reject(new Error('读取音频文件失败'));
      };

      reader.readAsArrayBuffer(audioBlob);
    });
  }, []);

  // AudioBuffer转WAV格式
  const audioBufferToWav = (audioBuffer) => {
    const length = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;
    const numberOfChannels = audioBuffer.numberOfChannels;
    const bytesPerSample = 2;
    const blockAlign = numberOfChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = length * blockAlign;
    const bufferSize = 44 + dataSize;

    const buffer = new ArrayBuffer(bufferSize);
    const view = new DataView(buffer);

    // WAV文件头
    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, bufferSize - 8, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numberOfChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    // 音频数据
    let offset = 44;
    for (let i = 0; i < length; i++) {
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const sample = Math.max(-1, Math.min(1, audioBuffer.getChannelData(channel)[i]));
        view.setInt16(offset, sample * 0x7FFF, true);
        offset += 2;
      }
    }

    return buffer;
  };

  // 取消录音（Esc）：丢弃本次音频，不识别不粘贴
  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    if (mediaRecorderRef.current) {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        // 忽略
      }
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    setIsRecording(false);
    setIsProcessing(false);
    setError(null);
    audioChunksRef.current = [];
  }, []);

  // 获取录音权限状态
  const checkPermissions = useCallback(async () => {
    try {
      const result = await navigator.permissions.query({ name: 'microphone' });
      return result.state; // 'granted', 'denied', 'prompt'
    } catch (err) {
      if (window.electronAPI && window.electronAPI.log) {
        window.electronAPI.log('warn', '无法检查麦克风权限:', err);
      }
      return 'unknown';
    }
  }, []);


  return {
    isRecording,
    isProcessing,
    isOptimizing,
    error,
    audioData,
    startRecording,
    stopRecording,
    cancelRecording,
    requestRawStop,
    checkPermissions
  };
};