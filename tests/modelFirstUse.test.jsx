// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelStatus } from '../src/hooks/useModelStatus';
import RecorderPill from '../src/components/RecorderPill';

describe('first-use model readiness and cat download entry', () => {
  let root, container, api, state;
  const missing = { success: true, models_downloaded: false, missing_models: ['asr', 'vad', 'punc'] };
  function Probe() { state = useModelStatus(); return <span>{state.stage}</span>; }
  const render = async element => act(async () => root.render(element));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({}, '', '/');
    api = {
      checkModelFiles: vi.fn().mockResolvedValue(missing),
      checkFunASRStatus: vi.fn().mockResolvedValue({ success: true, models_initialized: true }),
      downloadModels: vi.fn().mockResolvedValue({ success: false, error: 'download failed' }),
      log: vi.fn(),
    };
    window.electronAPI = api;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete window.electronAPI;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows known missing models without waiting for slow engine IPC', async () => {
    let releaseStatus;
    api.checkFunASRStatus.mockImplementation(() => new Promise(resolve => { releaseStatus = resolve; }));
    await render(<Probe />);
    try {
      expect(state.stage).toBe('need_download');
      expect(api.checkFunASRStatus).not.toHaveBeenCalled();
    } finally {
      if (releaseStatus) await act(async () => releaseStatus({ success: false }));
    }
  });

  it('does not turn normal first-use waiting into an engine failure after 61 seconds', async () => {
    await render(<Probe />);
    await act(async () => vi.advanceTimersByTimeAsync(61000));
    expect(state.stage).toBe('need_download');
    expect(state.modelFailed).toBe(false);
    expect(state.modelError).toBeNull();
  });

  it.each([
    [{ success: true, models_initialized: true }, 'ready', false],
    [{ success: true, initializing: true }, 'loading', false],
    [{ success: false, error: 'worker failed' }, 'error', true],
  ])('preserves downloaded-model worker status %j', async (status, stage, failed) => {
    api.checkModelFiles.mockResolvedValue({ success: true, models_downloaded: true });
    api.checkFunASRStatus.mockResolvedValue(status);
    await render(<Probe />);
    expect(state.stage).toBe(stage);
    expect(state.modelFailed).toBe(failed);
  });

  it('keeps the real loading timeout but resets its clock after waiting for a download', async () => {
    await render(<Probe />);
    await act(async () => vi.advanceTimersByTimeAsync(61000));
    api.checkModelFiles.mockResolvedValue({ success: true, models_downloaded: true });
    api.checkFunASRStatus.mockResolvedValue({ success: true, initializing: true });
    await act(async () => state.checkModelStatus());
    expect(state.modelFailed).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(61000));
    expect(state.modelFailed).toBe(true);
  });

  it('reports model file errors without a heavy worker check', async () => {
    api.checkModelFiles.mockRejectedValue(new Error('unreadable'));
    await render(<Probe />);
    expect(state.stage).toBe('error');
    expect(state.modelFailed).toBe(true);
    expect(api.checkFunASRStatus).not.toHaveBeenCalled();
  });

  it.each(['?panel=control', '?page=settings'])('does not check models from auxiliary window %s', async query => {
    window.history.replaceState({}, '', `/${query}`);
    await render(<Probe />);
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(api.checkModelFiles).not.toHaveBeenCalled();
  });

  it('reports an unavailable bridge, download and progress without throwing', async () => {
    delete window.electronAPI;
    await render(<Probe />);
    expect(state.modelError).toBe('Electron API 不可用');
    await act(async () => expect(await state.downloadModels()).toEqual({ success: false, error: 'Electron API 不可用' }));
    expect(await state.getDownloadProgress()).toEqual({ success: false });
    expect(await state.checkModelFiles()).toEqual({ success: false, models_downloaded: false });
  });

  it('downloads, restarts and checks real readiness after the existing delay', async () => {
    api.downloadModels.mockResolvedValue({ success: true });
    api.restartFunasrServer = vi.fn().mockResolvedValue({ success: true });
    await render(<Probe />);
    await act(async () => expect(await state.downloadModels()).toEqual({ success: true }));
    expect(state.stage).toBe('loading');
    expect(api.restartFunasrServer).toHaveBeenCalledTimes(1);
    api.checkModelFiles.mockResolvedValue({ success: true, models_downloaded: true });
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(state.stage).toBe('ready');
  });

  it('keeps restart and worker failures visible rather than marking ready', async () => {
    api.downloadModels.mockResolvedValue({ success: true });
    api.restartFunasrServer = vi.fn().mockRejectedValue(new Error('restart failed'));
    await render(<Probe />);
    await act(async () => state.downloadModels());
    expect(state.modelError).toContain('restart failed');
    api.checkModelFiles.mockResolvedValue({ success: true, models_downloaded: true });
    api.checkFunASRStatus.mockRejectedValue(new Error('IPC failed'));
    await act(async () => state.checkModelStatus());
    expect(state.modelError).toBe('服务器未就绪');
    expect(state.modelFailed).toBe(true);
  });

  it('subscribes to progress and initialization updates and releases both listeners', async () => {
    let progress, processing;
    const unsubscribeProgress = vi.fn(), unsubscribeProcessing = vi.fn();
    api.onModelDownloadProgress = vi.fn(callback => { progress = callback; return unsubscribeProgress; });
    api.onProcessingUpdate = vi.fn(callback => { processing = callback; return unsubscribeProcessing; });
    api.getDownloadProgress = vi.fn().mockResolvedValue({ success: true, progress: 42 });
    await render(<Probe />);
    await act(async () => progress(null, { overall_progress: 42 }));
    expect(state.downloadProgress).toBe(42);
    await act(async () => progress(null, { progress: 50 }));
    expect(state.downloadProgress).toBe(50);
    await act(async () => processing(null, { type: 'other' }));
    await act(async () => processing(null, { type: 'model_initialization', isLoading: true, isReady: false, progress: 75 }));
    expect(state.stage).toBe('loading');
    await act(async () => processing(null, { type: 'model_initialization', isLoading: false, isReady: true, progress: 100 }));
    expect(state.stage).toBe('ready');
    expect(await state.getDownloadProgress()).toEqual({ success: true, progress: 42 });
    api.getDownloadProgress.mockRejectedValue(new Error('progress failed'));
    expect(await state.getDownloadProgress()).toEqual({ success: false });
    await render(null);
    expect(unsubscribeProgress).toHaveBeenCalledTimes(1);
    expect(unsubscribeProcessing).toHaveBeenCalledTimes(1);
  });

  it.each(['cat', 'catfx'])('lets the real %s component download and retry while retaining exactly one cat', async pillSkin => {
    function FirstUseCat() {
      const models = useModelStatus();
      return <RecorderPill pillSkin={pillSkin} micState="idle" modelStatus={models}
        disabled onDownloadModels={models.downloadModels} />;
    }
    await render(<FirstUseCat />);
    const button = container.querySelector('button[aria-label="下载模型"]');
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(false);
    expect(container.querySelectorAll('.cat-skin')).toHaveLength(1);
    expect(container.querySelector('.recorder-pill')).toBeNull();
    await act(async () => button.click());
    expect(api.downloadModels).toHaveBeenCalledTimes(1);
    const retry = container.querySelector('button[aria-label="重试下载模型"]');
    expect(retry).not.toBeNull();
    await act(async () => retry.click());
    expect(api.downloadModels).toHaveBeenCalledTimes(2);
  });

  it.each(['cat', 'catfx'])('shows %s progress without allowing duplicate clicks, then removes the entry when ready', async pillSkin => {
    const onDownloadModels = vi.fn();
    await render(<RecorderPill pillSkin={pillSkin} micState="idle" modelStatus={{ stage: 'downloading', downloadProgress: 42 }} onDownloadModels={onDownloadModels} />);
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    expect(button.textContent).toContain('42%');
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(onDownloadModels).not.toHaveBeenCalled();
    await render(<RecorderPill pillSkin={pillSkin} micState="recording" modelStatus={{ stage: 'ready', isReady: true }} onDownloadModels={onDownloadModels} />);
    expect(container.querySelector('.cat-model-entry')).toBeNull();
    expect(container.querySelectorAll('.cat-skin')).toHaveLength(1);
  });

  it.each(['cat', 'catfx'])('does not offer a download for a %s engine-only failure', async pillSkin => {
    await render(<RecorderPill pillSkin={pillSkin} micState="idle" modelStatus={{ stage: 'error', modelsDownloaded: true, modelFailed: true }} />);
    expect(container.querySelector('.cat-model-entry')).toBeNull();
  });

  it.each(['music', 'voiceink'])('retains the existing %s badge download behavior', async pillSkin => {
    const onDownloadModels = vi.fn();
    await render(<RecorderPill pillSkin={pillSkin} micState="idle" modelStatus={{ stage: 'need_download' }} disabled onDownloadModels={onDownloadModels} />);
    await act(async () => container.querySelector('button[aria-label="下载模型"]').click());
    expect(onDownloadModels).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.cat-skin')).toBeNull();
  });

  it.each(['idle', 'recording', 'processing', 'optimizing'])('retains ready music actions in %s state', async micState => {
    const onToggle = vi.fn(), onOpenHistory = vi.fn(), onOpenSettings = vi.fn();
    await render(<RecorderPill micState={micState} modelStatus={{ stage: 'ready', isReady: true }}
      onToggle={onToggle} onOpenHistory={onOpenHistory} onOpenSettings={onOpenSettings} />);
    await act(async () => container.querySelector('.pill-badge').click());
    expect(onToggle).toHaveBeenCalledTimes(1);
    await act(async () => container.querySelector('button[aria-label="历史记录"]').click());
    await act(async () => container.querySelector('button[aria-label="设置"]').click());
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('retains translation, polish, loading and error render paths', async () => {
    const base = { micState: 'idle', modelStatus: { stage: 'ready', isReady: true } };
    await render(<RecorderPill {...base} translateState="translating" />);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(container.textContent).toContain('转换为英文');
    await render(<RecorderPill {...base} translateState="done" />);
    await render(<RecorderPill {...base} translateState="error" />);
    await render(<RecorderPill {...base} showPolishBubble polishCharCount={12} />);
    expect(container.textContent).toContain('已生成 12 字');
    await render(<RecorderPill {...base} showPolishBubble />);
    expect(container.textContent).toContain('生成中');
    await render(<RecorderPill {...base} pillSkin="voiceink" micState="processing" />);
    expect(container.textContent).toContain('转写中');
    await render(<RecorderPill {...base} modelStatus={{ stage: 'loading' }} />);
    expect(container.querySelector('.recorder-pill').title).toContain('模型加载中');
    await render(<RecorderPill {...base} modelStatus={{ stage: 'error', modelFailed: true, modelError: 'worker failed' }} />);
    expect(container.querySelector('.recorder-pill').title).toBe('worker failed');
  });

  it.each(['cat', 'catfx'])('preserves %s quota dismissal and does not consume ESC', async pillSkin => {
    const onDismiss = vi.fn(), onShown = vi.fn(), onDownloadModels = vi.fn(), esc = vi.fn();
    document.addEventListener('keydown', esc);
    try {
      await render(<RecorderPill pillSkin={pillSkin} micState="idle" modelStatus={{ stage: 'need_download' }}
        onDownloadModels={onDownloadModels} showQuotaExhaustedBubble onQuotaBubbleShown={onShown} onQuotaBubbleDismiss={onDismiss} />);
      expect(onShown).toHaveBeenCalledTimes(1);
      await act(async () => container.querySelector('button[aria-label="关闭云端字数提醒"]').click());
      expect(onDismiss).toHaveBeenCalledWith('dismissed');
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      container.querySelector('.cat-model-entry').dispatchEvent(event);
      expect(esc).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(false);
      expect(onDownloadModels).not.toHaveBeenCalled();
    } finally { document.removeEventListener('keydown', esc); }
  });
});
