import { useState, useRef, useCallback, useEffect } from 'react';
import { useModelStatus } from './useModelStatus';

// 频谱声波：把音频频谱拆成 BAND_COUNT 个独立频段，驱动胶囊里每根柱子各自起伏。
export const BAND_COUNT = 13;
const FFT_SIZE = 512;
const SMOOTHING_TIME_CONSTANT = 0.6;
const SPECTRUM_USABLE_RATIO = 0.7; // 只取较低的 ~70% 频段（语音能量主要集中在这里）
const BAND_GAIN = 1.6; // 归一化后的增益
const BAND_NOISE_GATE = 0.06; // 噪声门限：低于该值视为静音 → 该频段归零
const BAND_SMOOTH_OLD = 0.55; // 平滑：保留旧值比例
const BAND_SMOOTH_NEW = 0.45; // 平滑：吸收新值比例
const BAND_RENDER_FPS = 30; // 限制重渲染频率
const BAND_RENDER_INTERVAL_MS = 1000 / BAND_RENDER_FPS;

const createZeroBands = () => new Array(BAND_COUNT).fill(0);

// 唤醒后最小驻留时长守卫：录音器刚显示的极短时间内(与 main.js fireCancel 的 800ms 守卫对齐)，
// 不因 audioBlob.size===0 立即隐藏胶囊——Windows 唤醒时麦克风首帧偶发未就绪，会被误判为空录音，
// 导致"没说话胶囊就自己消失"。此窗口内的空录音只丢弃数据、保留胶囊，不触发 hideRecorder。
const MIN_RECORDER_RESIDENCE_MS = 800;

// 录音内存感知保护（WS6）：动态预测内存峰值，仅在临界时自动停止，尽量给久。
const MEM_CHECK_INTERVAL_MS = 5000; // 录音中每 ~5 秒检查一次预测峰值
const WAV_BYTES_PER_SEC = 16000 * 2; // 16kHz、16bit 单声道 WAV 每秒字节数
const CONVERT_PEAK_MULTIPLIER = 3; // 转换期峰值 ≈ 3 × WAV字节
const MEM_FRACTION_BUDGET = 0.6; // 安全预算上限：可用内存的 60%
const MEM_ABSOLUTE_BUDGET_BYTES = 1.2 * 1024 ** 3; // 与 1.2GB 取小

// 连说保序等待上限：等上一段收尾(润色+粘贴)完成的最长时间。超过则放行本段，最坏退回「可能乱序」
// 而非「永久不出字」——防止某段 LLM/网络/本地模型卡死时头阻塞后续所有连说段。
// 取值偏大以容忍本地模型首次加载(数十秒)，避免正常慢被误判为卡死而乱序。
const PASTE_ORDER_MAX_WAIT_MS = 30000;

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

  const [audioLevel, setAudioLevel] = useState(0);
  // 频谱声波：BAND_COUNT 个 0..1 的频段电平，每根柱子独立起伏
  const [audioBands, setAudioBands] = useState(createZeroBands);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const levelRafRef = useRef(null);
  // 内存感知保护（WS6）：录音开始时间戳 + 周期性内存检查定时器句柄
  const recordStartedAtRef = useRef(0);
  // 端到端埋点：录音结束（mediaRecorder 停止）的时刻（ms）。纯测量，用于历史「端到端字/秒」。
  const recEndTsRef = useRef(0);
  const memCheckTimerRef = useRef(null);

  // 取消标记：为 true 时停止录音不进行识别（用于 Esc 取消）
  const cancelledRef = useRef(false);
  // 连说 / 尾段再唤醒：每次录音 = 一个独立「段(session)」。用户结束一段后、胶囊消失前可再唤醒
  // 开新段，新段立即录音，旧段的收尾（转写→润色→粘贴）在后台并行完成、互不干扰。
  // segCounterRef 递增发号；latestSegIdRef 记录「当前/最新」段——共享 UI 状态(isProcessing/
  // isOptimizing)与隐藏胶囊只跟随最新段，旧段尾段流程静默收尾，不抢最新段的胶囊。
  // 段间出字顺序天然由主进程 转写/润色/粘贴 的 FIFO 队列保证（旧段先入队→先出字），无需额外排序。
  const segCounterRef = useRef(0);
  const latestSegIdRef = useRef(0);
  // 连说保序：段间「润色+粘贴」收尾阶段按【说话顺序】串行的 promise 链。转写侧本就 FIFO 串行，
  // 但云端润色并发/快慢会让短的后一段先返回→先粘贴→出字颠倒（流式还会交错成乱码）。
  // 每段在转写完成(按段序到达)时抢占一个有序槽：本段收尾须等上一段粘贴完成后再进行。
  const pasteOrderChainRef = useRef(Promise.resolve());
  // 连说取消：按段记录「被 Esc 取消的段号」，避免极速「Esc→再唤醒」时单例 cancelledRef 被新段清零
  // 导致旧段被误「复活」转写粘贴。onstop 用 (cancelledRef || cancelledSegIdRef===本段) 判定。
  const cancelledSegIdRef = useRef(0);

  // 使用模型状态Hook
  const modelStatus = useModelStatus();

  // 停止内存感知保护定时器（停止/取消/结束录音都会触发，避免定时器泄漏）
  const stopMemoryGuard = () => {
    try { if (memCheckTimerRef.current) clearInterval(memCheckTimerRef.current); } catch (_) {}
    memCheckTimerRef.current = null;
  };

  // 停止实时音频电平分析并释放 AudioContext（停止与取消都必须调用，避免泄漏）
  const stopAudioAnalysis = () => {
    stopMemoryGuard();
    try { if (levelRafRef.current) cancelAnimationFrame(levelRafRef.current); } catch (_) {}
    levelRafRef.current = null;
    try { if (analyserRef.current) analyserRef.current.disconnect(); } catch (_) {}
    analyserRef.current = null;
    try { if (audioCtxRef.current) audioCtxRef.current.close(); } catch (_) {}
    audioCtxRef.current = null;
    setAudioLevel(0);
    // 静音/停止：频段全部归零，柱子静止呈平直线
    setAudioBands(createZeroBands());
  };

  // 开始录音
  const startRecording = useCallback(async () => {
    try {
      setError(null);
      cancelledRef.current = false;

      // Fire-and-forget: warm up TLS/TCP to relay/direct LLM while user speaks
      try { window.electronAPI?.prewarmLLM?.(); } catch (_) {}

      // 唤醒键即时生效：引擎只是"正在加载/未就绪"时不再阻止录音——麦克风采集不依赖模型。
      // 仅当引擎处于明确错误态时才中止（无法转写）。其余情况照常采集，音频在停止时排队等引擎就绪转写。
      if (!modelStatus.isReady && modelStatus.error && !modelStatus.isLoading) {
        throw new Error('FunASR服务器未就绪，请检查配置');
      }

      // 检查浏览器支持
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('您的浏览器不支持录音功能');
      }

      // 请求麦克风权限。默认跟随系统默认输入设备；用户在设置里指定过麦克风时优先用指定设备
      // （蓝牙耳机/虚拟设备抢占系统默认时会选错设备，导致"权限已授予却录到静音"）。
      const rlog = (level, ...args) => {
        if (window.electronAPI && window.electronAPI.log) window.electronAPI.log(level, ...args);
      };
      const baseAudioConstraints = {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      };

      // 读取设置的麦克风（audio_input_device_id，'default'=系统默认）；读取失败按默认处理
      let preferredDeviceId = 'default';
      try {
        preferredDeviceId = (await window.electronAPI?.getSetting?.('audio_input_device_id', 'default')) || 'default';
      } catch (e) {
        rlog('warn', '读取 audio_input_device_id 失败，使用系统默认麦克风:', e?.message || e);
      }

      const audioConstraints = { ...baseAudioConstraints };
      if (preferredDeviceId && preferredDeviceId !== 'default') {
        // 校验所选设备是否仍在线（蓝牙耳机/外接麦可能已断开）；不在则回退系统默认并回写设置
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const stillPresent = devices.some((d) => d.kind === 'audioinput' && d.deviceId === preferredDeviceId);
          if (stillPresent) {
            audioConstraints.deviceId = { exact: preferredDeviceId };
          } else {
            rlog('warn', `所选麦克风已断开(deviceId=${preferredDeviceId})，回退系统默认`);
            try { await window.electronAPI?.setSetting?.('audio_input_device_id', 'default'); } catch (_) {}
          }
        } catch (e) {
          rlog('warn', '枚举音频设备失败，使用系统默认麦克风:', e?.message || e);
        }
      }

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      } catch (gumErr) {
        // 指定设备约束失败（设备刚被拔走等）：自动降级为系统默认约束重试一次
        if (audioConstraints.deviceId && (gumErr.name === 'OverconstrainedError' || gumErr.name === 'NotFoundError')) {
          rlog('warn', `指定麦克风获取失败(${gumErr.name})，降级系统默认重试:`, gumErr?.message || gumErr);
          stream = await navigator.mediaDevices.getUserMedia({ audio: baseAudioConstraints });
        } else {
          throw gumErr;
        }
      }

      // 麦克风轨道诊断日志：远程排障"权限已授予却录到静音"（选错设备/轨道被系统静音）
      try {
        const track = stream.getAudioTracks()[0];
        if (track) {
          const ts = track.getSettings ? track.getSettings() : {};
          rlog('info',
            `[麦克风] label="${track.label}" enabled=${track.enabled} muted=${track.muted} ` +
            `readyState=${track.readyState} deviceId=${ts.deviceId || '?'} sampleRate=${ts.sampleRate || '?'}`);
          if (track.muted === true || track.readyState !== 'live') {
            rlog('warn', '[麦克风] 麦克风轨道疑似无信号（muted 或非 live），本段可能录到静音');
          }
          // 录音期间轨道状态变化（系统抢占/设备拔出会触发）；track.stop 后自然失效，无需刻意解绑
          track.addEventListener('mute', () => rlog('warn', '[麦克风] 轨道被静音(mute)，当前录音可能出现无声段'));
          track.addEventListener('unmute', () => rlog('info', '[麦克风] 轨道恢复(unmute)'));
          track.addEventListener('ended', () => rlog('warn', '[麦克风] 轨道已结束(ended)，设备可能被拔出或被系统回收'));
        }
      } catch (e) {
        rlog('warn', '[麦克风] 轨道诊断日志记录失败:', e?.message || e);
      }

      streamRef.current = stream;
      audioChunksRef.current = [];

      // 实时音频电平分析（驱动胶囊声波）。防重复启动：已有 AudioContext 时先清理。
      if (audioCtxRef.current) stopAudioAnalysis();
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new AC();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = SMOOTHING_TIME_CONSTANT;
        source.connect(analyser);
        audioCtxRef.current = audioCtx;
        analyserRef.current = analyser;

        // 频域缓冲：取较低 ~70% 的频段（语音能量集中区），等分成 BAND_COUNT 段
        const freqBuf = new Uint8Array(analyser.frequencyBinCount);
        const usableBins = Math.max(BAND_COUNT, Math.floor(freqBuf.length * SPECTRUM_USABLE_RATIO));
        const binsPerBand = Math.max(1, Math.floor(usableBins / BAND_COUNT));

        const smoothBands = createZeroBands();
        let lastBands = createZeroBands();
        let lastLevel = -1;
        let lastEmit = 0;

        // 单个频段电平：对其覆盖的频点取均值 → 归一化 0..1 → 增益+钳制 → 噪声门
        const computeBandLevel = (bandIndex) => {
          const start = bandIndex * binsPerBand;
          const end = Math.min(start + binsPerBand, usableBins);
          let sum = 0;
          for (let i = start; i < end; i++) sum += freqBuf[i];
          const avg = sum / Math.max(1, end - start);
          const normalized = Math.min(1, (avg / 255) * BAND_GAIN);
          return normalized < BAND_NOISE_GATE ? 0 : normalized;
        };

        // 节流提交 + 仅在四舍五入后数组变化时 setState，降低重渲染压力
        const hasMeaningfulChange = (rounded) => {
          for (let b = 0; b < BAND_COUNT; b++) {
            if (rounded[b] !== lastBands[b]) return true;
          }
          return false;
        };

        const tick = () => {
          analyser.getByteFrequencyData(freqBuf);
          const rounded = new Array(BAND_COUNT);
          for (let b = 0; b < BAND_COUNT; b++) {
            const cur = computeBandLevel(b);
            smoothBands[b] = smoothBands[b] * BAND_SMOOTH_OLD + cur * BAND_SMOOTH_NEW;
            rounded[b] = Math.round(smoothBands[b] * 100) / 100;
          }
          // 平滑后整体音量电平（0..1）：取各频段最大值，驱动音符的"说话/静音"与数量
          let maxBand = 0;
          for (let b = 0; b < BAND_COUNT; b++) {
            if (rounded[b] > maxBand) maxBand = rounded[b];
          }
          const now = performance.now();
          if (now - lastEmit >= BAND_RENDER_INTERVAL_MS) {
            const levelChanged = maxBand !== lastLevel;
            const bandsChanged = hasMeaningfulChange(rounded);
            if (levelChanged || bandsChanged) {
              lastEmit = now;
              if (bandsChanged) {
                lastBands = rounded;
                setAudioBands(rounded);
              }
              if (levelChanged) {
                lastLevel = maxBand;
                setAudioLevel(maxBand);
              }
            }
          }
          levelRafRef.current = requestAnimationFrame(tick);
        };
        levelRafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        // audio analysis is best-effort; never block recording
      }

      // 创建MediaRecorder
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
      });

      mediaRecorderRef.current = mediaRecorder;

      // 本段段号：onstop 与后续管线用它判断自己是否仍是「最新段」，据此决定是否驱动
      // 共享 UI 状态 / 隐藏胶囊（旧段尾段流程静默完成，不抢最新段的胶囊）。
      const segId = ++segCounterRef.current;
      latestSegIdRef.current = segId;
      const isLatestSeg = () => latestSegIdRef.current === segId;

      // 设置事件处理器
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // 端到端埋点 t0：录音真正结束的时刻。按段快照(segRecEndTs)随本段下传，避免尾段再唤醒时
        // 被新段的 onstop 覆盖（连说下 recEndTsRef 会被后一段刷新）。
        const segRecEndTs = Date.now();
        recEndTsRef.current = segRecEndTs;
        // 停止的是「当前录音」→ 关闭录音态（连说下新段尚未开始，此刻本段必为最新段）。
        setIsRecording(false);
        // 录音结束：停止实时电平分析并释放 AudioContext（不泄漏）
        stopAudioAnalysis();

        // 已取消（Esc）：丢弃音频，不识别、不粘贴。按段判定（cancelledRef 单例 + 本段被取消的段号），
        // 防「极速 Esc→再唤醒」时单例标记被新段清零导致旧段误复活。
        if (cancelledRef.current || cancelledSegIdRef.current === segId) {
          audioChunksRef.current = [];
          if (isLatestSeg()) setIsProcessing(false);
          return;
        }

        if (isLatestSeg()) setIsProcessing(true);

        try {
          // 创建音频Blob
          const audioBlob = new Blob(audioChunksRef.current, {
            type: 'audio/webm;codecs=opus'
          });

          // 空/零长度音频：静默 no-op，不识别、不粘贴、不报错（ROB-5，对齐"未识别到语音"处理）
          if (!audioBlob || audioBlob.size === 0) {
            audioChunksRef.current = [];
            // 唤醒后最小驻留守卫：胶囊刚显示的极短时间内(<800ms)出现空录音，多半是麦克风首帧
            // 未就绪而非用户"没说话"，此时保留胶囊、只丢弃数据，避免"没说话就自己消失"。
            const elapsedMs = Date.now() - recordStartedAtRef.current;
            if (elapsedMs < MIN_RECORDER_RESIDENCE_MS) {
              if (window.electronAPI && window.electronAPI.log) {
                window.electronAPI.log('info', `空录音但未达最小驻留(${elapsedMs}ms<${MIN_RECORDER_RESIDENCE_MS}ms)，忽略隐藏，避免麦克风首帧未就绪被误判为空录音`);
              }
              return;
            }
            if (window.electronAPI && window.electronAPI.log) {
              window.electronAPI.log('info', '空录音（0 字节），跳过识别');
            }
            // 连说：仅当本段仍是最新段时才收起胶囊——用户可能已再唤醒开了新段，胶囊归新段所有。
            if (isLatestSeg() && window.electronAPI && window.electronAPI.hideRecorder) {
              try { await window.electronAPI.hideRecorder(); } catch (e) { /* 忽略 */ }
            }
            return;
          }

          if (isLatestSeg()) setAudioData(audioBlob);

          // 处理音频（按段下传：段号 + 本段录音结束时刻）
          await processAudio(audioBlob, segId, segRecEndTs);
        } catch (err) {
          // 连说：仅最新段的错误才提示用户；旧段尾段出错只记日志，不打断正在进行的新段。
          if (isLatestSeg()) setError(`音频处理失败: ${err.message}`);
          else if (window.electronAPI?.log) window.electronAPI.log('error', '旧段音频处理失败(不提示，不影响新段):', err?.message || err);
        } finally {
          if (isLatestSeg()) setIsProcessing(false);
        }
      };

      mediaRecorder.onerror = (event) => {
        // 连说：仅本段仍是最新段时才翻动全局录音/处理态与错误提示，避免旧段 recorder 报错误关新段。
        if (isLatestSeg()) {
          setError(`录音错误: ${event.error?.message || '未知错误'}`);
          setIsRecording(false);
          setIsProcessing(false);
        } else if (window.electronAPI?.log) {
          window.electronAPI.log('warn', '旧段 recorder 报错(忽略，不影响新段):', event.error?.message || '');
        }
      };

      // 开始录音
      mediaRecorder.start(1000); // 每秒收集一次数据
      setIsRecording(true);
      // 连说：新段开始，清掉上一段尾段流程可能残留的处理/润色态，让胶囊回到「录音中」。
      setIsProcessing(false);
      setIsOptimizing(false);
      recordStartedAtRef.current = Date.now();

      // 内存感知动态保护（WS6）：每 ~5 秒预测内存峰值，仅在临界时自动停止，尽量给久。
      // 预测峰值 = 转换期倍数 × (16000*2*已录秒数)；安全预算 = min(60%可用内存, 1.2GB)。
      stopMemoryGuard();
      const memLog = (level, ...args) => {
        if (window.electronAPI && window.electronAPI.log) {
          window.electronAPI.log(level, ...args);
        }
      };
      memCheckTimerRef.current = setInterval(async () => {
        try {
          if (!window.electronAPI || !window.electronAPI.getMemoryInfo) return;
          const elapsedSec = (Date.now() - recordStartedAtRef.current) / 1000;
          const wavBytes = WAV_BYTES_PER_SEC * elapsedSec;
          const predictedPeak = CONVERT_PEAK_MULTIPLIER * wavBytes;

          const { freeBytes } = await window.electronAPI.getMemoryInfo();
          const safeBudget = Math.min(
            MEM_FRACTION_BUDGET * freeBytes,
            MEM_ABSOLUTE_BUDGET_BYTES
          );

          if (predictedPeak > safeBudget) {
            memLog('warn',
              `内存保护触发：预测峰值 ${Math.round(predictedPeak / 1024 / 1024)}MB > ` +
              `安全预算 ${Math.round(safeBudget / 1024 / 1024)}MB（已录 ${Math.round(elapsedSec)}s），自动停止录音`
            );
            stopMemoryGuard();
            // 自动停止：照常进入转写流程（onstop 会处理已录音频，不丢弃）。
            // 不依赖闭包里的 isRecording（捕获即过期）；以 mediaRecorderRef 录制中状态为准。
            const mr = mediaRecorderRef.current;
            if (mr && mr.state !== 'inactive') {
              try { mr.stop(); } catch (_) {}
              stopAudioAnalysis();
              if (streamRef.current) {
                streamRef.current.getTracks().forEach((track) => track.stop());
                streamRef.current = null;
              }
            }
            try {
              window.electronAPI?.showNotification?.('弦外小猫', '录音较长，已自动停止以防内存不足，本段已保存');
            } catch (_) {}
          }
        } catch (e) {
          // 内存检查为尽力而为，失败不影响录音
          memLog('warn', '内存保护检查失败:', e?.message || e);
        }
      }, MEM_CHECK_INTERVAL_MS);

    } catch (err) {
      setError(`无法开始录音: ${err.message}`);
      setIsRecording(false);
    }
  }, [modelStatus.isReady, modelStatus.isLoading, modelStatus.error]);

  // 停止录音
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();

      // 停止实时电平分析并释放 AudioContext（不泄漏）
      stopAudioAnalysis();

      // 停止所有音频轨道
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
    }
  }, [isRecording]);

  // 处理音频（按段隔离：segId=本段段号，recEndTs=本段录音结束时刻）。
  // 连说：不再有「上一段处理中就丢弃本段」的全局并发锁——每段各自独立走完管线，
  // 段间转写/润色/粘贴由主进程 FIFO 队列串行、互不串扰且天然保序。
  const processAudio = useCallback(async (audioBlob, segId, recEndTs) => {
    // 本段是否仍是「最新段」——决定是否驱动共享 UI 状态 / 隐藏胶囊。
    const isLatestSeg = () => latestSegIdRef.current === segId;

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
        try {
          engine = await window.electronAPI.getSetting('asr_engine', 'sensevoice');
        } catch (e) {
          // 读取失败不阻塞识别：记录后回退默认引擎（SF-4）
          if (window.electronAPI && window.electronAPI.log) {
            window.electronAPI.log('warn', '读取 asr_engine 失败，回退 sensevoice:', e?.message || e);
          }
        }
        const _tT0 = Date.now();
        const transcriptionResult = await window.electronAPI.transcribeAudio(uint8Array, { engine });
        tlog(`[计时] 转写往返(WAV→识别, ${engine}): ${Date.now() - _tT0}ms`);

        if (transcriptionResult.success) {
          const raw_text = transcriptionResult.text;

          // 未识别到有效语音：不提交大模型、不粘贴、不入库，直接收起胶囊
          if (!raw_text || !raw_text.trim()) {
            tlog('[计时] 未识别到有效语音，跳过LLM与粘贴');
            // 连说：仅当本段仍是最新段时才收起胶囊（用户可能已再唤醒开新段）。
            if (isLatestSeg() && window.electronAPI && window.electronAPI.hideRecorder) {
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

          // 异步处理 LLM 与保存（只保存一次）。连说：润色态只在本段仍为最新段时驱动 UI。
          if (isLatestSeg()) setIsOptimizing(true);

          // 连说保序：转写侧 FIFO 串行 → 此处按【说话顺序】到达，同步抢占一个有序粘贴槽。
          // 本段的收尾（润色+粘贴）须等上一段粘贴完成后再进行；录音本身不受此影响、仍可并行开新段。
          const _prevPaste = pasteOrderChainRef.current;
          let _releasePaste;
          pasteOrderChainRef.current = new Promise((r) => { _releasePaste = r; });

          setTimeout(async () => {
            const log = (level, ...args) => {
              if (window.electronAPI && window.electronAPI.log) {
                window.electronAPI.log(level, ...args);
              }
            };
            // 去掉渲染层硬超时（WS1）：直接 await 整条异步链，避免误杀慢但正常的 LLM 流式。
            const runPipeline = (async () => {
              // 一次性快照所有设置：把热路径上原本 4~5 次串行 getSetting(IPC+读库)往返
              // 压成一次 getAllSettings，单句不会中途改设置，快照足够安全且更快。
              const _settings =
                (window.electronAPI.getAllSettings ? await window.electronAPI.getAllSettings() : null) || {};
              const getS = (k, d) => (_settings[k] !== undefined ? _settings[k] : d);

              // 文案模式：识别后必走 LLM，贴"模型结果"；旧版优化模式作为兼容回退
              let copywriting = getS('copywriting_mode_enabled', true);
              let useAI = getS('enable_ai_optimization', true);
              // 强制全部走 AI 润色：不再对短句静默跳过润色（每条转写都必须经过润色/替换）。

              let finalData = { ...transcriptionData };
              let emit;
              // 端到端埋点：recEndTs 为本段录音结束时刻（onstop 已按段快照并随参数下传，
              // 连说下不会被后一段覆盖）。e2e_total_ms = 真正粘贴完成时刻 − recEndTs。仅测量、异步补写、失败静默。
              // 润色标识：当前引擎 + 完整润色耗时（含本地首次加载模型的一次性开销）。
              // 耗时口径 = 从发起润色到拿到结果的完整等待时间。仅在实际走了润色时写入。
              const polishEngine = getS('polish_engine', 'cloud');
              // 历史记录的「引擎」按【本次实际使用的引擎】写入，而非设置里的引擎——
              // 云端额度不足时会自动降级本地(local-4b)真实润色，历史须如实标注实际引擎。
              // 缺失（老路径/未回传）才回退设置值；passthrough(未润色)不覆盖，维持原有行为。
              let actualEngine = polishEngine;
              let polishDurMs = null;

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

              // 连说保序：等上一段的收尾（润色+粘贴）完成后再进行本段——保证段间出字顺序 = 说话顺序，
              // 并杜绝流式 appendChunk 在多段间交错。落库(savePromise)已在上面不阻塞地先发，历史不受影响。
              // 加超时降级：上一段若卡死(LLM/网络/本地模型无响应)，最多等 PASTE_ORDER_MAX_WAIT_MS 即放行本段，
              // 最坏退回「可能乱序」而非「后续段永久不出字」（活性优先，避免头阻塞冻结整条连说）。
              try {
                await Promise.race([
                  _prevPaste,
                  new Promise((r) => setTimeout(r, PASTE_ORDER_MAX_WAIT_MS)),
                ]);
              } catch (_) {}

              if (copywriting) {
                // —— 流式上屏由设置开关控制（默认关闭）：
                //    仅当 llm_streaming_enabled 为 true 时才走流式(processTextStream，边生成边贴)；
                //    关闭时走下方非流式主路径(processText)，拿到整段结果后一次性粘贴。——
                const streamingEnabled = getS('llm_streaming_enabled', false) === true;
                let streamed = false;
                let streamReason = null; // 结构化失败原因（如 input_too_long），供下方明确提示
                try {
                  if (streamingEnabled && window.electronAPI.processTextStream) {
                    const _sT0 = Date.now();
                    // 流式上屏首字耗时：从润色发起(_sT0)到首个"已上屏"的 polish-progress 事件
                    // (首段 delta，带 chunk)之间的毫秒差。只记录首次，随后立即取消订阅。
                    let firstCharMs = null;
                    let offProgress = null;
                    if (window.electronAPI.onPolishProgress) {
                      offProgress = window.electronAPI.onPolishProgress((data) => {
                        if (firstCharMs != null) return;
                        const isFirstChunk =
                          data && data.status === 'delta' &&
                          (typeof data.chunk === 'string' ? data.chunk.length > 0 : (data.charCount || 0) > 0);
                        if (isFirstChunk) {
                          firstCharMs = Date.now() - _sT0;
                          try { if (typeof offProgress === 'function') offProgress(); } catch (_) {}
                          offProgress = null;
                        }
                      });
                    }
                    let sres;
                    try {
                      sres = await window.electronAPI.processTextStream(raw_text);
                    } finally {
                      try { if (typeof offProgress === 'function') offProgress(); } catch (_) {}
                    }
                    if (sres && (sres.success || sres.pastedAny)) {
                      polishDurMs = Date.now() - _sT0;
                      // 端到端 t_end（流式）：processTextStream 返回 = 主进程最后一段增量已粘贴落屏。
                      if (Number.isFinite(recEndTs) && recEndTs > 0) {
                        finalData.e2e_total_ms = Date.now() - recEndTs;
                      }
                      log('info', `[计时] 流式文案: ${polishDurMs}ms` + (Number.isFinite(firstCharMs) ? `，首字 ${firstCharMs}ms` : ''));
                      // 实际引擎（云端降级本地时如实记录）；passthrough 不覆盖，维持原有行为
                      if (sres.engine && sres.engine !== 'passthrough') actualEngine = sres.engine;
                      const t = sres.text || raw_text;
                      finalData.processed_text = t;
                      finalData.text = t;
                      // 流式路径：记录首字上屏耗时（仅此路径设置，非流式保持 null）
                      if (Number.isFinite(firstCharMs)) finalData.polish_first_char_ms = firstCharMs;
                      // 主进程已增量贴出，这里不再重复粘贴
                      emit = { ...transcriptionResult, text: t, processed_text: t, enhanced_by_ai: true, paste: false };
                      streamed = true;
                    } else if (sres && typeof sres.reason === 'string') {
                      streamReason = sres.reason; // 流式失败原因，透传给非流式收尾分支的提示
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
                  // 润色失败先重试一次（额度受限/未配置 key 等结构化失败不重试，重试无意义）
                  if (!(result && result.success && result.text)) {
                    const reason = result && result.reason;
                    const noRetry =
                      reason === 'insufficient_quota' ||
                      reason === 'daily_cap_exceeded' ||
                      reason === 'input_too_long';
                    const errMsg0 = (result && result.error) || '';
                    const noKey0 = /API\s*密钥|API\s*Key|api[_\s]?key/i.test(errMsg0);
                    if (!noRetry && !noKey0) {
                      log('info', '文案生成失败，自动重试一次');
                      try {
                        result = await window.electronAPI.processText(raw_text, 'copywriting');
                      } catch (err2) {
                        log('error', '文案生成重试异常:', err2);
                      }
                    }
                  }
                  polishDurMs = Date.now() - _lT0;
                  log('info', `[计时] DeepSeek文案: ${polishDurMs}ms`);
                } catch (err) {
                  log('error', '文案生成调用异常:', err);
                }

                if (result && result.success && result.text) {
                  // passthrough = 云端额度用尽且本地未装时的「原文直贴」：不是真正的润色。
                  // 必须如实标注 enhanced_by_ai:false 并落日志，否则 Windows 上表现为
                  // 「看起来没有 AI 润色（原文直接出）」却查不到原因。
                  const isPassthrough = result.engine === 'passthrough';
                  if (isPassthrough) {
                    log('warn', '[润色] enhanced_by_ai=false 原因: 云端额度用尽且本地模型未装(passthrough 原文直贴)');
                  } else if (result.engine) {
                    // 实际引擎（云端降级本地时如实记录）；passthrough 不覆盖，维持原有行为
                    actualEngine = result.engine;
                  }
                  finalData.processed_text = result.text;
                  finalData.text = result.text;
                  emit = {
                    ...transcriptionResult,
                    text: result.text,
                    processed_text: result.text,
                    enhanced_by_ai: !isPassthrough,
                    paste: true,
                  };
                } else {
                  // LLM 失败：
                  //  - 未配置 API Key → 视为"纯听写"，照常粘贴识别原文（保证开箱可用）
                  //  - 已配置但调用失败 → 由 llm_fallback_paste_raw 决定是否回退贴原文（默认是）
                  const fallback = getS('llm_fallback_paste_raw', true);
                  const errMsg = (result && result.error) || 'AI 文案生成失败';
                  const noKey = /API\s*密钥|API\s*Key|api[_\s]?key/i.test(errMsg);
                  // 结构化失败原因：优先取非流式结果，其次取流式路径捕获的原因。
                  const failReason = (result && result.reason) || streamReason;
                  const tooLong = failReason === 'input_too_long';
                  // 云端额度受限：额度不足 / 今日已达上限（后端计费返回）。贴原文 + 明确提示，不自动转本地。
                  const quotaLimited =
                    failReason === 'insufficient_quota' || failReason === 'daily_cap_exceeded';
                  log('error', '文案生成失败:', errMsg);
                  // 统一根因日志：enhanced_by_ai=false 的原因（quota/网络/开关/引擎不可用）一行可查。
                  log('error', '[润色] enhanced_by_ai=false 原因: ' +
                    (failReason || (noKey ? 'no_api_key' : 'request_failed')) +
                    ' | engine=' + polishEngine + ' | ' + errMsg);
                  // 所选引擎润色失败（非"未配置 key 的纯听写"）：贴原文 + 系统通知，绝不回退到其它引擎/云端。
                  if (!noKey) {
                    try {
                      let notifyText = '润色失败，已贴出原文';
                      if (tooLong) {
                        notifyText = '内容过长，本地模型无法处理，建议改用云端AI';
                      } else if (failReason === 'daily_cap_exceeded') {
                        notifyText = '今日云端用量已达上限，请购买套餐、兑换或改用本地模型';
                      } else if (failReason === 'insufficient_quota') {
                        notifyText = '云端额度不足，请购买套餐、兑换或改用本地模型';
                      }
                      window.electronAPI?.showNotification?.('弦外小猫', notifyText);
                    } catch (e) { /* 通知失败无妨 */ }
                  }
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
                  const _oT0 = Date.now();
                  result = await window.electronAPI.processText(raw_text, 'optimize');
                  polishDurMs = Date.now() - _oT0;
                } catch (err) {
                  log('error', 'AI文本优化捕获到错误:', err);
                }
                if (result && result.success) {
                  if (result.engine && result.engine !== 'passthrough') actualEngine = result.engine;
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
              // 连说：每段都是用户有意的独立一段，均须粘贴（不再「新段取消旧段粘贴」）。段间保序
              // 由主进程粘贴 FIFO 队列保证。隐藏胶囊的所有权交给 App：仅当本段仍是最新段时才允许收起。
              if (onAIOptimizationCompleteRef?.current) {
                emit.canHideRecorder = () => latestSegIdRef.current === segId;
                const doneP = onAIOptimizationCompleteRef?.current(emit);
                // 端到端 t_end（非流式）：handleAIOptimizationComplete 为 async，其返回 Promise 在
                // safePaste 的 pasteText 完成后 resolve（整段真正落屏）。仅观测、不 await、不阻塞出字；
                // 仅当本次确有粘贴(emit.paste)且 recEndTs 有效时，粘贴完成后拿行 id 异步补写 e2e_total_ms。
                if (
                  emit && emit.paste === true &&
                  Number.isFinite(recEndTs) && recEndTs > 0 &&
                  window.electronAPI && window.electronAPI.updateTranscription
                ) {
                  Promise.resolve(doneP)
                    .then(() => {
                      const e2e = Date.now() - recEndTs;
                      return Promise.resolve(savePromise).then((r) => {
                        const sid = r && r.lastInsertRowid != null ? r.lastInsertRowid : null;
                        if (sid != null) {
                          return window.electronAPI.updateTranscription(sid, { e2e_total_ms: e2e });
                        }
                      });
                    })
                    .catch(() => { /* 埋点失败静默，绝不影响粘贴/入库 */ });
                }
              }

              // 走过润色且拿到结果时，记录引擎与完整润色耗时（供历史界面显示「AI优化·<引擎> 时长X.XX秒」）。
              const polished = !!finalData.processed_text && Number.isFinite(polishDurMs);
              if (polished) {
                finalData.polish_engine = actualEngine;
                finalData.polish_duration_ms = polishDurMs;
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
                        ...(polished
                          ? { polish_engine: actualEngine, polish_duration_ms: polishDurMs }
                          : {}),
                        ...(Number.isFinite(finalData.polish_first_char_ms)
                          ? { polish_first_char_ms: finalData.polish_first_char_ms }
                          : {}),
                        // 端到端字/秒（流式路径已在出字时算好）；非流式此处为空、由粘贴完成后单独补写。
                        ...(Number.isFinite(finalData.e2e_total_ms)
                          ? { e2e_total_ms: finalData.e2e_total_ms }
                          : {}),
                      });
                    }
                    return window.electronAPI.saveTranscription(finalData);
                  })
                  .catch((err) => log('error', '补写转录失败:', err));
              }
            })();

            try {
              await runPipeline;
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
                  // 连说：异常收尾路径同样把「是否可隐藏胶囊」的判定交给 App（仅最新段可收起）。
                  canHideRecorder: () => latestSegIdRef.current === segId,
                });
              }
            } finally {
              // 连说：润色态只在本段仍为最新段时清除，避免误清最新段(新段)的 UI。
              if (isLatestSeg()) setIsOptimizing(false);
              // 释放有序粘贴槽：放行下一段的收尾（务必在本段粘贴/入库都结束后）。
              try { _releasePaste(); } catch (_) {}
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
    // 按段记录被取消的段号（=当前最新段），airtight 防「Esc→再唤醒」竞态误复活旧段。
    cancelledSegIdRef.current = latestSegIdRef.current;
    if (mediaRecorderRef.current) {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        // 忽略
      }
    }

    // 停止实时电平分析并释放 AudioContext（取消路径同样不泄漏）
    stopAudioAnalysis();

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
    audioLevel,
    audioBands,
    startRecording,
    stopRecording,
    cancelRecording,
    checkPermissions
  };
};