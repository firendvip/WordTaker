import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const managerPath = require.resolve('../src/helpers/funasrManager.js');

afterEach(() => {
  vi.restoreAllMocks();
  delete require.cache[managerPath];
});

function createManager(platform = 'darwin') {
  const children = [];
  const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    children.push(child);
    return child;
  });
  delete require.cache[managerPath];
  const FunASRManager = require(managerPath);
  const manager = new FunASRManager({ error: vi.fn(), info: vi.fn() });
  vi.spyOn(manager, 'isOnnxOnlyMode').mockReturnValue(platform === 'win32');
  manager.findPythonExecutable = vi.fn().mockResolvedValue('/test/python');
  const env = { PYTHONHOME: '/test/python-home', PYTHONNOUSERSITE: '1' };
  manager.buildPythonEnvironment = vi.fn(() => env);
  return { manager, children, spawn, env };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
function finish(children, code = 0, output = 'OK') {
  for (const child of children) {
    child.stdout.emit('data', output);
    child.emit('close', code);
  }
}

describe('FunASR installation check singleflight', () => {
  it('releases an unexpectedly rejected check and permits recovery', async () => {
    const { manager } = createManager();
    const result = { installed: true, working: true };
    manager._checkFunASRInstallation = vi.fn()
      .mockRejectedValueOnce(new Error('unexpected check failure'))
      .mockResolvedValueOnce(result);
    const checks = await Promise.allSettled([manager.checkFunASRInstallation(), manager.checkFunASRInstallation()]);
    expect(checks.every(check => check.status === 'rejected' && check.reason.message === 'unexpected check failure')).toBe(true);
    expect(manager.funasrInstallationPromise).toBeNull();
    expect(await manager.checkFunASRInstallation()).toBe(result);
    expect(manager._checkFunASRInstallation).toHaveBeenCalledTimes(2);
    expect(manager.funasrInstallationPromise).toBeNull();
  });
  it.each(['darwin', 'win32'])('shares concurrent %s checks and preserves its engine/environment', async platform => {
    const { manager, children, spawn, env } = createManager(platform);
    const checks = Array.from({ length: 10 }, () => manager.checkFunASRInstallation());
    await flush();
    try {
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0]).toEqual(['/test/python', ['-c', platform === 'win32'
        ? 'import numpy, onnxruntime, soundfile; print("OK")' : 'import funasr; print("OK")'], { env }]);
    } finally {
      finish(children);
      await Promise.all(checks);
    }
    const results = await Promise.all(checks);
    expect(results.every(result => result === results[0])).toBe(true);
    expect(results[0]).toEqual({ installed: true, working: true });
    expect(manager.funasrInstallationPromise).toBeNull();
    expect(await manager.checkFunASRInstallation()).toBe(results[0]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(['close', 'error', 'python'])('releases pending %s failures, caches the result and allows a later recheck', async failure => {
    const { manager, children, spawn } = createManager();
    if (failure === 'python') manager.findPythonExecutable.mockRejectedValue(new Error('python missing'));
    const checks = [manager.checkFunASRInstallation(), manager.checkFunASRInstallation()];
    await flush();
    if (failure === 'close') {
      for (const child of children) child.stderr.emit('data', 'import failed');
      finish(children, 1, '');
    } else if (failure === 'error') {
      for (const child of children) child.emit('error', new Error('spawn failed'));
    }
    const results = await Promise.all(checks);
    expect(results[0]).toEqual({ installed: false, working: false,
      error: failure === 'python' ? 'python missing' : failure === 'close' ? 'import failed' : 'spawn failed' });
    expect(results[1]).toBe(results[0]);
    expect(manager.funasrInstallationPromise).toBeNull();
    const calls = spawn.mock.calls.length;
    expect(await manager.checkFunASRInstallation()).toBe(results[0]);
    expect(spawn).toHaveBeenCalledTimes(calls);
    // Existing installFunASR lifecycle invalidates this completed-result cache.
    manager.funasrInstalled = null;
    manager.findPythonExecutable.mockResolvedValue('/test/python');
    const recovery = manager.checkFunASRInstallation();
    await flush();
    finish(children.slice(calls));
    expect(await recovery).toEqual({ installed: true, working: true });
    expect(manager.funasrInstallationPromise).toBeNull();
    expect(spawn).toHaveBeenCalledTimes(calls + 1);
  });
});
