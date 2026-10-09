import fs from 'node:fs';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const ipcSource = read('../src/helpers/ipcHandlers.js');

describe('phone-only authentication IPC', () => {
  let handlers, backend, tokens, logger;
  beforeEach(() => {
    handlers = new Map();
    backend = { authSmsSend: vi.fn(), authSmsLogin: vi.fn(), authMe: vi.fn() };
    tokens = {
      set: vi.fn(() => true),
      get: vi.fn(),
      updateAccount: vi.fn(() => true),
      getGeneration: vi.fn(() => 1),
      clear: vi.fn(() => true),
    };
    logger = { warn: vi.fn() };
    const context = {
      module: { exports: {} },
      require: (name) => {
        if (name === 'electron') return { ipcMain: { handle: (key, fn) => handlers.set(key, fn) } };
        if (name === './aiService') return class {};
        if (name === '../utils/shortTextPolicy.cjs') return {};
        if (name === './backendClient') return backend;
        if (name === './tokenStore') return tokens;
        throw new Error(`Unexpected dependency: ${name}`);
      },
    };
    vm.runInNewContext(ipcSource, context);
    context.module.exports.prototype.setupAuthHandlers.call({ logger });
  });

  it('registers only SMS login plus account/session actions', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'auth-logout', 'auth-me', 'auth-sms-login', 'auth-sms-send', 'get-auth-state',
    ]);
  });
  it.each([null, {}, 13800138000, '', '123', '1380013800a'])('rejects invalid phone %j before calling the backend', async (phone) => {
    expect(await handlers.get('auth-sms-send')({}, phone)).toMatchObject({ success: false, code: 'INVALID_PHONE' });
    expect(await handlers.get('auth-sms-login')({}, phone, '123456')).toMatchObject({ success: false, code: 'INVALID_PHONE' });
    expect(backend.authSmsSend).not.toHaveBeenCalled();
    expect(backend.authSmsLogin).not.toHaveBeenCalled();
  });
  it('sends a normalized phone number without exposing the verification code', async () => {
    backend.authSmsSend.mockResolvedValue({ success: true, data: { sent: true, mockCode: '123456' } });
    expect(await handlers.get('auth-sms-send')({}, ' 13800138000 ')).toEqual({ success: true });
    expect(backend.authSmsSend).toHaveBeenCalledWith('13800138000');
  });
  it.each([undefined, { success: false }, { success: true, data: { sent: false } }])('does not claim SMS delivery without backend confirmation: %j', async (response) => {
    backend.authSmsSend.mockResolvedValue(response);
    expect(await handlers.get('auth-sms-send')({}, '13800138000')).toMatchObject({ success: false });
  });
  it.each(['', '1234', '12345678', 'abcdef', null, {}])('rejects malformed six-digit code %j', async (code) => {
    expect(await handlers.get('auth-sms-login')({}, '13800138000', code)).toMatchObject({ success: false, code: 'INVALID_CODE' });
    expect(backend.authSmsLogin).not.toHaveBeenCalled();
    expect(tokens.set).not.toHaveBeenCalled();
  });
  it('stores the token in the main process and returns only an account summary', async () => {
    backend.authSmsLogin.mockResolvedValue({ success: true, data: {
      accessToken: 'test-only-token', refreshToken: 'test-only-refresh',
      account: { phone: '13800138000' }, isNew: true,
    } });
    const result = await handlers.get('auth-sms-login')({}, ' 13800138000 ', ' 123456 ', ' INVITE ');
    expect(backend.authSmsLogin).toHaveBeenCalledWith('13800138000', '123456', 'INVITE');
    expect(tokens.set).toHaveBeenCalledWith({
      accessToken: 'test-only-token',
      refreshToken: 'test-only-refresh',
      account: { phone: '13800138000' },
    });
    expect(result).toMatchObject({ success: true, loggedIn: true, isNew: true });
    expect(result).not.toHaveProperty('accessToken');
    expect(result).not.toHaveProperty('refreshToken');
  });
  it('does not authenticate a response without a token', async () => {
    backend.authSmsLogin.mockResolvedValue({ success: true, data: {} });
    expect(await handlers.get('auth-sms-login')({}, '13800138000', '123456')).toMatchObject({ success: false });
    expect(tokens.set).not.toHaveBeenCalled();
  });

  it('reports failed login persistence without clearing a recoverable previous session', async () => {
    tokens.set.mockReturnValue(false);
    backend.authSmsLogin.mockResolvedValue({ success: true, data: {
      accessToken: 'test-only-token', refreshToken: 'test-only-refresh',
      account: { phone: '13800138000' },
    } });

    expect(await handlers.get('auth-sms-login')({}, '13800138000', '123456')).toMatchObject({ success: false });
    expect(tokens.clear).not.toHaveBeenCalled();
  });
  it.each([
    { success: false, data: { accessToken: 'test-only-token' } },
    { success: true, data: { accessToken: {} } },
    { success: true, data: { accessToken: '   ' } },
    { success: true, data: { accessToken: 'test-only-token' } },
    { success: true, data: { accessToken: 'test-only-token', refreshToken: {} } },
    { success: true, data: { accessToken: 'test-only-token', refreshToken: '   ' } },
  ])('rejects failed or malformed authentication responses: %j', async (response) => {
    backend.authSmsLogin.mockResolvedValue(response);
    expect(await handlers.get('auth-sms-login')({}, '13800138000', '123456')).toMatchObject({ success: false });
    expect(tokens.set).not.toHaveBeenCalled();
  });

  it('restores the persisted account without a network request after restart', async () => {
    tokens.get.mockReturnValue({ account: { phone: '13800138000' } });

    expect(await handlers.get('get-auth-state')()).toEqual({
      success: true,
      loggedIn: true,
      account: { phone: '13800138000' },
    });
    expect(backend.authMe).not.toHaveBeenCalled();
  });

  it('reports temporarily unreadable storage instead of confirming a logged-out state', async () => {
    tokens.get.mockImplementation(() => { throw Object.assign(new Error('keychain unavailable'), { code: 'AUTH_STORAGE_UNAVAILABLE' }); });
    const result = await handlers.get('get-auth-state')();
    expect(result).toMatchObject({ success: false, code: 'AUTH_STORAGE_UNAVAILABLE' });
    expect(result).not.toHaveProperty('loggedIn');
  });

  it('updates only the account summary after a successful server check', async () => {
    backend.authMe.mockResolvedValue({
      success: true,
      data: { account: { phone: '13800138000', nickname: '小猫' } },
    });

    expect(await handlers.get('auth-me')()).toMatchObject({ success: true });
    expect(tokens.updateAccount).toHaveBeenCalledWith({ phone: '13800138000', nickname: '小猫' });
    expect(tokens.set).not.toHaveBeenCalled();
  });

  it('does not write account A into B after a successful auth-me response arrives late', async () => {
    let respond;
    backend.authMe.mockReturnValue(new Promise((resolve) => { respond = resolve; }));
    const pending = handlers.get('auth-me')();
    tokens.getGeneration.mockReturnValue(3);
    respond({ success: true, data: { account: { userId: 'A' } } });
    expect(await pending).toMatchObject({ success: false, code: 'SESSION_CHANGED' });
    expect(tokens.updateAccount).not.toHaveBeenCalled();
  });

  it('does not replace a new session with a delayed previous login result', async () => {
    let respond;
    backend.authSmsLogin.mockReturnValue(new Promise((resolve) => { respond = resolve; }));
    const pending = handlers.get('auth-sms-login')({}, '13800138000', '123456');
    tokens.getGeneration.mockReturnValue(3);
    respond({ success: true, data: { accessToken: 'access-A', refreshToken: 'refresh-A' } });
    expect(await pending).toMatchObject({ success: false, code: 'SESSION_CHANGED' });
    expect(tokens.set).not.toHaveBeenCalled();
  });

  it.each([
    Object.assign(new Error('offline'), { kind: 'network' }),
    Object.assign(new Error('timeout'), { kind: 'timeout' }),
    Object.assign(new Error('server error'), { kind: 'http', status: 503 }),
    Object.assign(new Error('legacy access expired'), { kind: 'http', status: 401, code: 'NOT_LOGGED_IN' }),
  ])('never clears credentials for an auth-me failure handled by the backend client', async (error) => {
    backend.authMe.mockRejectedValue(error);

    expect(await handlers.get('auth-me')()).toMatchObject({ success: false });
    expect(tokens.clear).not.toHaveBeenCalled();
  });

  it('clears the persisted session only on explicit logout', async () => {
    expect(await handlers.get('auth-logout')()).toEqual({ success: true });
    expect(tokens.clear).toHaveBeenCalledOnce();
  });
  it('does not report a successful logout when credentials could not be removed', async () => {
    tokens.clear.mockReturnValue(false);
    expect(await handlers.get('auth-logout')()).toMatchObject({
      success: false, code: 'AUTH_LOGOUT_PERSISTENCE_FAILED',
    });
  });
  it.each(['auth-sms-send', 'auth-sms-login'])('returns failures from %s without logging private response details', async (channel) => {
    const error = Object.assign(new Error('验证码已过期'), { kind: 'http', code: 'INVALID_CODE', status: 400 });
    backend[channel === 'auth-sms-send' ? 'authSmsSend' : 'authSmsLogin'].mockRejectedValue(error);
    expect(await handlers.get(channel)({}, '13800138000', '123456')).toMatchObject({ success: false, code: 'INVALID_CODE' });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(error.message);
    expect(tokens.set).not.toHaveBeenCalled();
  });
});

describe('phone-only preload and backend client', () => {
  it('exposes no email or WeChat authentication API to any renderer', async () => {
    let api;
    const invoke = vi.fn();
    vm.runInNewContext(read('../preload.js'), {
      process: { env: { NODE_ENV: 'production' }, platform: 'darwin' },
      require: () => ({
        contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'electronAPI') api = value; } },
        ipcRenderer: { invoke },
      }),
    });
    expect(Object.keys(api).filter((key) => /email|wechat/i.test(key))).toEqual([]);
    await api.authSmsSend('13800138000');
    await api.authSmsLogin('13800138000', '123456', 'INVITE');
    expect(invoke).toHaveBeenCalledWith('auth-sms-send', '13800138000');
    expect(invoke).toHaveBeenCalledWith('auth-sms-login', '13800138000', '123456', 'INVITE');
  });
  it('keeps only SMS transport methods and sends the existing SMS contract', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ success: true }) });
    const context = { module: { exports: {} }, fetch, AbortController, setTimeout, clearTimeout,
      require: (name) => {
        if (name === './backendConfig') return { AI_BACKEND_URL: 'https://backend.invalid', API_PREFIX: '/api/v1', CLIENT_PLATFORM: 'mac', BACKEND_REQUEST_TIMEOUT_MS: 1000 };
        if (name === './deviceIdentity') return { getDeviceId: () => 'test-device-123' };
        if (name === './tokenStore') return { getAccessToken: () => null, getGeneration: () => 0 };
        throw new Error(name);
      },
    };
    vm.runInNewContext(read('../src/helpers/backendClient.js'), context);
    const api = context.module.exports;
    expect(Object.keys(api).filter((key) => /email|wechat/i.test(key))).toEqual([]);
    await api.authSmsSend('13800138000');
    await api.authSmsLogin('13800138000', '123456', 'INVITE');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://backend.invalid/api/v1/auth/sms/send', 'https://backend.invalid/api/v1/auth/sms/login',
    ]);
    expect(JSON.parse(fetch.mock.lastCall[1].body)).toEqual({ phone: '13800138000', code: '123456', inviteCode: 'INVITE', deviceId: 'test-device-123' });
  });
});
