import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const levelState = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('react', () => ({
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, initial === 0 ? levelState.set : vi.fn()],
  useRef: (current) => ({ current }),
  useCallback: (callback) => callback,
  useEffect: vi.fn(),
}));
vi.mock('../src/hooks/useModelStatus', () => ({
  useModelStatus: () => ({ isReady: true, isLoading: false, error: null }),
}));
import { useRecording } from '../src/hooks/useRecording.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const drain = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };

describe('recording startup cancellation', () => {
  let hook, getUserMedia, start, stopTrack, stream;
  beforeEach(() => {
    vi.useFakeTimers();
    levelState.set.mockClear();
    start = vi.fn();
    stopTrack = vi.fn();
    stream = { getTracks: () => [{ stop: stopTrack }], getAudioTracks: () => [] };
    getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.stubGlobal('window', { electronAPI: { log: vi.fn(), getSetting: vi.fn().mockResolvedValue('default') } });
    vi.stubGlobal('MediaRecorder', class {
      state = 'inactive';
      start() { this.state = 'recording'; start(); }
      stop() { this.state = 'inactive'; this.onstop?.(); }
    });
    hook = useRecording();
  });
  afterEach(() => {
    hook.cancelRecording();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('deduplicates hotkeys while microphone access is pending', async () => {
    const pending = deferred();
    getUserMedia.mockReturnValue(pending.promise);
    const first = hook.startRecording();
    const second = hook.startRecording();
    await drain();
    expect(getUserMedia).toHaveBeenCalledOnce();
    pending.resolve(stream);
    await Promise.all([first, second]);
    expect(start).toHaveBeenCalledOnce();
  });
  it('stops a late microphone stream instead of recording after Escape', async () => {
    const pending = deferred();
    getUserMedia.mockReturnValue(pending.promise);
    const opening = hook.startRecording();
    await drain();
    hook.cancelRecording();
    pending.resolve(stream);
    await opening;
    expect(start).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalledOnce();
  });
  it('does not request microphone access after cancellation during settings lookup', async () => {
    const pending = deferred();
    window.electronAPI.getSetting.mockReturnValue(pending.promise);
    const opening = hook.startRecording();
    hook.cancelRecording();
    pending.resolve('default');
    await opening;
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('ignores another start while already recording', async () => {
    await hook.startRecording();
    await hook.startRecording();
    expect(start).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
  it('drives cat feedback from quiet microphone samples even when frequency bands are zero', async () => {
    let frame;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => { frame = callback; return 1; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    window.AudioContext = class {
      state = 'running';
      createMediaStreamSource() { return { connect: vi.fn() }; }
      createAnalyser() {
        return {
          frequencyBinCount: 256,
          getByteFrequencyData: (buffer) => buffer.fill(0),
          getFloatTimeDomainData: (buffer) => buffer.forEach((_, i) => { buffer[i] = 0.018 * Math.sin(i / 4); }),
          disconnect: vi.fn(),
        };
      }
      close() {}
    };
    await hook.startRecording();
    for (let n = 0; n < 12; n++) {
      vi.advanceTimersByTime(40);
      frame();
    }
    expect(start).toHaveBeenCalledOnce();
    expect(levelState.set.mock.lastCall[0]).toBeGreaterThan(0.35);
    hook.cancelRecording();
    expect(levelState.set).toHaveBeenLastCalledWith(0);
  });
});
