import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(new URL('../src/helpers/funasrManager.js', import.meta.url), 'utf8');
function method(name, next, globals = {}) {
  const start = source.indexOf(`  ${name}(`);
  const end = source.indexOf(`  ${next}(`, start);
  if (start < 0 || end < 0) throw new Error(`Missing ${name}`);
  return vm.runInNewContext(`({${source.slice(start, end)}})`, globals)[name.replace(/^async /, '')];
}
function environmentHarness(embedded = true, platform = 'darwin') {
  const env = { PATH: '/fixture/bin', TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD: '1', TORCH_FORCE_WEIGHTS_ONLY_LOAD: '0',
    NUMBA_CACHE_DIR: '/fixture/sealed.app/cache', NUMBA_CACHE_LOCATOR_CLASSES: 'InTreeCacheLocator' };
  const mkdir = vi.fn();
  const globals = {
    fs: { existsSync: () => embedded, mkdirSync: mkdir }, path,
    process: { platform, arch: 'arm64', env },
    require: () => ({ app: { getPath: () => '/fixture/data' } }),
  };
  return {
    mkdir,
    run: method('buildPythonEnvironment', 'findDamoRoot', globals),
    manager: { getEmbeddedPythonPath: () => '/fixture/python', getEmbeddedPythonDir: () => '/fixture/runtime', getEmbeddedSitePackages: () => '/fixture/runtime/site', logger: {} },
  };
}

describe('Python subprocess safe environment', () => {
  it.each([true, false])('forces weights-only and removes an inherited unsafe override (embedded=%s)', embedded => {
    const { run, manager } = environmentHarness(embedded);
    const env = run.call(manager);
    expect(env.TORCH_FORCE_WEIGHTS_ONLY_LOAD).toBe('1');
    expect(env).not.toHaveProperty('TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD');
    expect(env.ELECTRON_USER_DATA).toBe('/fixture/data');
  });
  it('reasserts policy even on a mutated cached environment', () => {
    const { run, manager } = environmentHarness();
    const first = run.call(manager);
    first.TORCH_FORCE_WEIGHTS_ONLY_LOAD = '0';
    first.TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD = '1';
    expect(run.call(manager).TORCH_FORCE_WEIGHTS_ONLY_LOAD).toBe('1');
    expect(first).not.toHaveProperty('TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD');
  });
});

describe('sealed bundle Numba cache boundary', () => {
  it.each([[true, 'darwin'], [false, 'darwin'], [true, 'win32'], [false, 'win32']])(
    'uses private userData cache without in-package fallback (embedded=%s, platform=%s)', (embedded, platform) => {
      const { run, manager, mkdir } = environmentHarness(embedded, platform);
      const env = run.call(manager);
      expect(env.NUMBA_CACHE_DIR).toBe('/fixture/data/cache/numba');
      expect(env.NUMBA_CACHE_LOCATOR_CLASSES).toBe('UserProvidedCacheLocator');
      expect(mkdir).toHaveBeenCalledWith('/fixture/data/cache/numba', { recursive: true, mode: 0o700 });
      expect(env.PYTHONDONTWRITEBYTECODE).toBe('1');
      expect(env.ELECTRON_USER_DATA).toBe('/fixture/data');
      if (platform === 'win32') expect(env.WORDTAKER_ONNX_ONLY).toBe('1');
    },
  );
  it('reasserts cache location and fail-closed locator on cached environments', () => {
    const { run, manager } = environmentHarness();
    const first = run.call(manager);
    first.NUMBA_CACHE_DIR = '/fixture/sealed.app/cache';
    first.NUMBA_CACHE_LOCATOR_CLASSES = 'InTreeCacheLocator';
    const second = run.call(manager);
    expect(second).toBe(first);
    expect(second.NUMBA_CACHE_DIR).toBe('/fixture/data/cache/numba');
    expect(second.NUMBA_CACHE_LOCATOR_CLASSES).toBe('UserProvidedCacheLocator');
  });
  it.each([false, true])('refuses an unwritable external cache instead of falling back into the bundle (cached=%s)', cached => {
    const { run, manager, mkdir } = environmentHarness();
    if (cached) run.call(manager);
    mkdir.mockImplementation(() => { throw new Error('EACCES: private cache'); });
    expect(() => run.call(manager)).toThrow('EACCES: private cache');
  });
});

describe('cache reuse requires the same pure Python content verifier', () => {
  it('invokes the bundled verifier with explicit root and isolated environment', async () => {
    const runCommand = vi.fn().mockResolvedValue({ code: 0, output: JSON.stringify({ success: true, details: {} }) });
    const run = method('async verifyCachedModels', 'async downloadModels', { path, runCommand });
    const manager = { findPythonExecutable: vi.fn().mockResolvedValue('/fixture/python'), getFunASRServerPath: () => '/fixture/resources/funasr_server.py', buildPythonEnvironment: () => ({ TORCH_FORCE_WEIGHTS_ONLY_LOAD: '1' }) };
    expect(await run.call(manager, '/fixture/cache')).toBe(true);
    expect(runCommand).toHaveBeenCalledWith('/fixture/python', ['/fixture/resources/pytorch_model_security.py', '--verify-root', '/fixture/cache'], expect.objectContaining({ env: { TORCH_FORCE_WEIGHTS_ONLY_LOAD: '1' } }));
  });
  it.each(['{}', '{"success":false}', 'not-json'])('fails closed for invalid verifier output: %s', async output => {
    const runCommand = vi.fn().mockResolvedValue({ code: 0, output });
    const run = method('async verifyCachedModels', 'async downloadModels', { path, runCommand });
    const manager = { findPythonExecutable: async () => '/fixture/python', getFunASRServerPath: () => '/fixture/server.py', buildPythonEnvironment: () => ({}) };
    expect(await run.call(manager, '/fixture/cache')).toBe(false);
  });
});

describe('model download launch boundary', () => {
  function harness(onnxOnly = false, verified = false) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const spawn = vi.fn(() => child);
    const run = method('async downloadModels', 'async restartServer', { spawn, fs: { existsSync: () => true }, path, StringDecoder, setTimeout: vi.fn(), require: () => ({ app: { getPath: () => '/fixture/private-data' } }) });
    const manager = {
      logger: {}, isOnnxOnlyMode: () => onnxOnly,
      checkModelFiles: async () => ({ models_downloaded: true }),
      verifyCachedModels: vi.fn().mockResolvedValue(verified),
      getModelCachePath: vi.fn(() => '/fixture/shared-cache'),
      findPythonExecutable: async () => '/fixture/python',
      getDownloadScriptPath: () => '/fixture/download_models.py',
      buildPythonEnvironment: () => ({ TORCH_FORCE_WEIGHTS_ONLY_LOAD: '1' }),
    };
    return { child, spawn, manager, run };
  }
  it('does not touch Torch cache or start a downloader in Windows pure-ONNX mode', async () => {
    const h = harness(true);
    expect(await h.run.call(h.manager)).toMatchObject({ success: true });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.manager.getModelCachePath).not.toHaveBeenCalled();
    expect(h.manager.verifyCachedModels).not.toHaveBeenCalled();
  });
  it('does not regard an unverified shared size-only cache hit as success', async () => {
    const h = harness();
    const pending = h.run.call(h.manager);
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce());
    expect(h.spawn).toHaveBeenCalledWith('/fixture/python', ['/fixture/download_models.py', '--damo-root', '/fixture/private-data/models/damo'], expect.objectContaining({ windowsHide: true, env: { TORCH_FORCE_WEIGHTS_ONLY_LOAD: '1' } }));
    h.child.stdout.emit('data', Buffer.from('{"succ'));
    h.child.stdout.emit('data', Buffer.from('ess":true,"message":"verified"}\n'));
    expect(await pending).toEqual({ success: true, message: 'verified' });
  });
  it('reuses the existing cache only after complete content verification', async () => {
    const h = harness(false, true);
    expect(await h.run.call(h.manager)).toMatchObject({ success: true });
    expect(h.manager.verifyCachedModels).toHaveBeenCalledWith('/fixture/shared-cache');
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it('preserves Chinese JSON text when a data chunk splits inside a UTF-8 character', async () => {
    const h = harness();
    const pending = h.run.call(h.manager);
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce());
    const frame = Buffer.from('{"success":true,"message":"验证完成"}\n');
    const split = Buffer.byteLength('{"success":true,"message":"') + 1;
    h.child.stdout.emit('data', frame.subarray(0, split));
    h.child.stdout.emit('data', frame.subarray(split));
    expect(await pending).toEqual({ success: true, message: '验证完成' });
  });
});
