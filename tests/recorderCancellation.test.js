import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
function mainFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function harness(settings = {}) {
  const context = {
    Date: { now: () => 100 }, recordStartedAt: 0,
    isBusy: false, isRecording: false, appFullyInitialized: true,
    cancelKeyRegistered: null,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    databaseManager: { getSetting: (key, fallback) => settings[key] ?? fallback },
    TriggerManager: { VALID_KEYS: new Set(['Escape', 'F1', 'F2', 'F4', 'F8']) },
    cancelTriggerManager: { start: vi.fn(), stop: vi.fn() },
    translateTriggerManager: { stop: vi.fn() },
    globalShortcut: { register: vi.fn(() => true), unregister: vi.fn(), isRegistered: vi.fn(() => true) },
    windowManager: {
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      hideMainWindow: vi.fn(),
    },
    getRecordingTriggerModifier: () => null,
    isSameModifierTap: () => false,
    broadcastRecorderSessionState: vi.fn(),
    endSession: vi.fn(),
  };
  vm.createContext(context);
  for (const name of ['fireCancel', 'registerCancelKey']) vm.runInContext(mainFunction(name), context);
  return context;
}

describe('recorder Escape lifecycle', () => {
  it('registers single Escape without a native accessibility hook', () => {
    const h = harness();
    h.registerCancelKey();
    expect(h.globalShortcut.register).toHaveBeenCalledWith('Escape', h.fireCancel);
    expect(h.cancelTriggerManager.start).not.toHaveBeenCalled();
  });
  it('preserves the configured double-tap gesture', () => {
    const h = harness({ cancel_taps: 2 });
    h.registerCancelKey();
    expect(h.cancelTriggerManager.start).toHaveBeenCalledWith(
      { type: 'modifier-tap', key: 'Escape', taps: 2 }, h.fireCancel,
    );
  });
  it('cancels immediately, including before the microphone starts', () => {
    const h = harness();
    h.fireCancel();
    expect(h.windowManager.mainWindow.webContents.send).toHaveBeenCalledWith('cancel-recording');
    expect(h.windowManager.hideMainWindow).toHaveBeenCalledOnce();
    expect(h.endSession).toHaveBeenCalledOnce();
  });
  it('still hides the cat when notifying the renderer fails', () => {
    const h = harness();
    h.windowManager.mainWindow.webContents.send.mockImplementation(() => { throw new Error('renderer unavailable'); });
    expect(() => h.fireCancel()).not.toThrow();
    expect(h.windowManager.hideMainWindow).toHaveBeenCalledOnce();
    expect(h.endSession).toHaveBeenCalledOnce();
  });
  it('restores a lost Escape registration during an existing session', () => {
    const h = harness();
    h.isBusy = true;
    h.cancelKeyRegistered = 'Escape';
    h.globalShortcut.isRegistered.mockReturnValue(false);
    vm.runInContext(mainFunction('beginRecorderSession'), h);
    h.beginRecorderSession();
    expect(h.globalShortcut.register).toHaveBeenCalledWith('Escape', h.fireCancel);
  });
  it('arms cancellation at the hotkey entry, without depending on a native show event', () => {
    const h = harness({ recording_trigger: { type: 'accelerator', accelerator: 'Alt+1' } });
    Object.assign(h, {
      process: { platform: 'darwin' },
      validateRecordingTrigger: (trigger) => trigger,
      recordingFallbackAccel: null, recordingCurrentAccel: null,
      triggerManager: { stop: vi.fn() },
      hotkeyManager: { registerHotkey: vi.fn(() => true) },
      beginRecorderSession: vi.fn(),
    });
    h.windowManager.showRecorderAtBottom = vi.fn();
    vm.runInContext(mainFunction('setupRecordingTrigger'), h);
    h.setupRecordingTrigger();
    h.hotkeyManager.registerHotkey.mock.calls[0][1]();
    expect(h.beginRecorderSession).toHaveBeenCalledOnce();
    expect(h.windowManager.mainWindow.webContents.send).toHaveBeenCalledWith('hotkey-triggered', expect.anything());
  });
  it('arms Escape when the recorder becomes visible and is idempotent', () => {
    const h = harness();
    vm.runInContext(mainFunction('beginRecorderSession'), h);
    h.beginRecorderSession();
    h.beginRecorderSession();
    expect(h.isBusy).toBe(true);
    expect(h.isRecording).toBe(false);
    expect(h.globalShortcut.register).toHaveBeenCalledOnce();
    expect(h.translateTriggerManager.stop).toHaveBeenCalledOnce();
    expect(source).toContain("recorderWindow.on('show', beginRecorderSession)");
    expect(source).toContain("recorderWindow.on('hide', endSession)");
  });
});
