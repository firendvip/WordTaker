import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(new URL('../src/helpers/windowManager.js', import.meta.url), 'utf8');
const start = source.indexOf('  hideMainWindow() {');
const end = source.indexOf('\n  async createControlPanelWindow()', start);
const hideMainWindow = vm.runInNewContext(`({${source.slice(start, end)}}).hideMainWindow`);

function harness() {
  return {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() }, hide: vi.fn() },
    setQuotaBubbleVisible: vi.fn(), _logError: vi.fn(),
  };
}

describe('native recorder hide is independent of renderer IPC', () => {
  it('notifies the renderer and hides the window normally', () => {
    const h = harness();
    hideMainWindow.call(h);
    expect(h.mainWindow.webContents.send).toHaveBeenCalledWith('recorder-window-visibility-changed', false);
    expect(h.mainWindow.hide).toHaveBeenCalledOnce();
  });
  it.each(['ipc', 'resize'])('still hides when %s fails', (failure) => {
    const h = harness();
    const target = failure === 'ipc' ? h.mainWindow.webContents.send : h.setQuotaBubbleVisible;
    target.mockImplementation(() => { throw new Error('unavailable'); });
    hideMainWindow.call(h);
    expect(h.mainWindow.hide).toHaveBeenCalledOnce();
    expect(h._logError).toHaveBeenCalledOnce();
  });
  it('logs native failure without throwing or reopening the window', () => {
    const h = harness();
    h.mainWindow.hide.mockImplementation(() => { throw new Error('window closed'); });
    expect(() => hideMainWindow.call(h)).not.toThrow();
    expect(h._logError).toHaveBeenCalledOnce();
  });
  it.each([null, { isDestroyed: () => true }])('ignores an absent or destroyed window', (mainWindow) => {
    const h = { ...harness(), mainWindow };
    expect(() => hideMainWindow.call(h)).not.toThrow();
    expect(h._logError).not.toHaveBeenCalled();
  });
});
