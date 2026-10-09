// @vitest-environment jsdom
// Real tokenStore -> backendClient -> IPC -> AccountPanel. Only OS storage/network are test-owned fixtures.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPanel } from '../src/components/account/AccountPanel';

const ui = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), clear: vi.fn(), refresh: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: ui.error, success: ui.success } }));
vi.mock('../src/components/account/useCloudQuota', () => ({ useCloudQuota: () => ({ clear: ui.clear, refresh: ui.refresh }) }));
vi.mock('../src/components/account/QuotaCard', () => ({ QuotaCard: ({ onLogin }) => <button onClick={onLogin}>打开登录</button> }));
vi.mock('../src/components/account/InviteCard', () => ({ InviteCard: () => null }));
vi.mock('../src/components/account/RedeemCard', () => ({ RedeemCard: () => null }));
vi.mock('../src/components/account/PlansCard', () => ({ PlansCard: () => null }));
vi.mock('../src/components/account/MembershipHero', () => ({ MembershipHero: ({ account, onLogout }) => <div>已登录 {account.phone}<button onClick={onLogout}>退出</button></div> }));

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const oldAccount = { phone: '13800138000' };
const newAccount = { phone: '13900139000' };

function loadSource(relative, dependencies, globals = {}) {
  const filename = path.join(fileURLToPath(new NodeURL('../', import.meta.url)), relative);
  const context = { Buffer, Date, JSON, URL, AbortController, setTimeout, clearTimeout, module: { exports: {} },
    require: name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    }, ...globals };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}

describe('legacy identity rejection opens a safe one-time SMS reauthentication path', () => {
  let directory, tokens, client, handlers, api, fetchMock, cipher, root, container;
  const button = label => [...container.querySelectorAll('button')].find(el => el.textContent.includes(label));
  const click = async label => act(async () => { expect(button(label)).toBeDefined(); button(label).click(); });
  const input = async (id, value) => act(async () => {
    const element = container.querySelector(id);
    expect(element).not.toBeNull();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const mount = async () => act(async () => root.render(<AccountPanel rowLabelClass="label" />));
  const snapshotFile = () => fs.readFileSync(path.join(directory, 'backend-token.json'), 'utf8');
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wordtaker-legacy-reauth-'));
    cipher = {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: value => Buffer.from(`fixture-only:${Buffer.from(value).toString('base64')}`),
      decryptString: value => Buffer.from(value.toString().slice('fixture-only:'.length), 'base64').toString(),
    };
    tokens = loadSource('src/helpers/tokenStore.js', { fs, path, electron: { app: { getPath: () => directory }, safeStorage: cipher } }, { process: { platform: 'darwin' } });
    expect(tokens.set({ accessToken: 'test-only-legacy-access', account: oldAccount })).toBe(true);
    fetchMock = vi.fn(async url => {
      if (url.endsWith('/auth/sms/send')) return reply(200, { success: true, data: { sent: true } });
      if (url.endsWith('/auth/sms/login')) return reply(200, { success: true, data: { accessToken: 'test-only-new-access', refreshToken: 'test-only-new-refresh', account: newAccount } });
      if (url.endsWith('/auth/me') && tokens.getRefreshToken()) return reply(200, { success: true, data: { account: tokens.get().account } });
      return reply(401, { code: 'NOT_LOGGED_IN', message: 'expired' });
    });
    client = loadSource('src/helpers/backendClient.js', {
      './backendConfig': { AI_BACKEND_URL: 'https://fixture.invalid', API_PREFIX: '/api/v1', CLIENT_PLATFORM: 'mac', BACKEND_REQUEST_TIMEOUT_MS: 1000 },
      './deviceIdentity': { getDeviceId: () => 'test-only-device' }, './tokenStore': tokens,
    }, { fetch: fetchMock });
    handlers = new Map();
    const IPC = loadSource('src/helpers/ipcHandlers.js', {
      electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
      './aiService': class {}, '../utils/shortTextPolicy.cjs': {}, './backendClient': client, './tokenStore': tokens,
    });
    IPC.prototype.setupAuthHandlers.call({ logger: { warn: vi.fn() } });
    api = {
      getAuthState: () => handlers.get('get-auth-state')(), authMe: () => handlers.get('auth-me')(),
      authSmsSend: phone => handlers.get('auth-sms-send')({}, phone),
      authSmsLogin: (phone, code, invite) => handlers.get('auth-sms-login')({}, phone, code, invite),
      authLogout: () => handlers.get('auth-logout')(),
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
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('shows confirmed expiry and a usable SMS entry, then securely persists a new refresh session', async () => {
    const saved = snapshotFile();
    await mount();
    expect(container.textContent).toContain('旧登录已失效，请重新进行手机验证码验证');
    expect(container.textContent).not.toContain('已登录 13800138000');
    expect(snapshotFile()).toBe(saved);
    expect(tokens.getAccessToken()).toBe('test-only-legacy-access');
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/auth/refresh'))).toBe(false);
    await click('重新手机验证');
    await input('#login-phone', '13900139000');
    await click('获取验证码');
    await input('#login-code', '123456');
    await click('登录 / 注册');
    expect(container.textContent).toContain('已登录 13900139000');
    expect(container.textContent).not.toContain('旧登录已失效');
    expect(tokens.getRefreshToken()).toBe('test-only-new-refresh');
    expect(snapshotFile()).not.toContain('test-only-new-refresh');
    expect(snapshotFile()).not.toBe(saved);
    expect(await api.getAuthState()).not.toHaveProperty('refreshToken');
    expect(ui.success).toHaveBeenCalledWith('登录成功');
  });
  it('marks authoritative identity rejection without deleting the legacy credential or returning secrets', async () => {
    const saved = snapshotFile();
    const result = await api.authMe();
    expect(result).toMatchObject({ success: false, code: 'REAUTH_REQUIRED', reauthRequired: true });
    expect(result).not.toHaveProperty('accessToken');
    expect(result).not.toHaveProperty('refreshToken');
    expect(snapshotFile()).toBe(saved);
  });
  it('rechecks the session after the no-refresh promise boundary', async () => {
    vi.spyOn(tokens, 'getRefreshToken').mockImplementationOnce(() => {
      expect(tokens.set({ accessToken: 'test-only-B-access', refreshToken: 'test-only-B-refresh', account: newAccount })).toBe(true);
      return null;
    });
    expect(await api.authMe()).toMatchObject({ success: false, code: 'SESSION_CHANGED' });
    expect(tokens.get().account).toEqual(newAccount);
  });
  it.each(['old-rejection', 'new-session'])('IPC rejects a stale reauthentication marker from %s', async kind => {
    const generation = tokens.getGeneration();
    vi.spyOn(client, 'authMe').mockImplementationOnce(async () => {
      if (kind === 'new-session') tokens.set({ accessToken: 'test-only-B-access', refreshToken: 'test-only-B-refresh', account: newAccount });
      throw Object.assign(new Error('test-only stale rejection'), { code: 'REAUTH_REQUIRED', reauthRequired: true, sessionGeneration: kind === 'old-rejection' ? generation - 1 : generation });
    });
    expect(await api.authMe()).toMatchObject({ success: false, code: 'SESSION_CHANGED' });
    expect(tokens.getAccessToken()).toBe(kind === 'new-session' ? 'test-only-B-access' : 'test-only-legacy-access');
  });
  it('does not log out a valid access-only session merely because refresh is absent', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true, data: { account: oldAccount } }));
    await mount();
    expect(container.textContent).toContain('已登录 13800138000');
    expect(container.textContent).not.toContain('重新手机验证');
    expect(tokens.getRefreshToken()).toBeNull();
  });
  it.each(['network', 'timeout', '5xx', 'storage'])('keeps credentials and local account on temporary %s failure', async kind => {
    const saved = snapshotFile();
    if (kind === 'network') fetchMock.mockRejectedValue(new Error('offline'));
    if (kind === 'timeout') fetchMock.mockRejectedValue(Object.assign(new Error('timeout'), { name: 'AbortError' }));
    if (kind === '5xx') fetchMock.mockResolvedValue(reply(503, { message: 'unavailable' }));
    if (kind === 'storage') vi.spyOn(tokens, 'getAccessToken').mockImplementation(() => { throw Object.assign(new Error('test storage temporarily unavailable'), { code: 'AUTH_STORAGE_UNAVAILABLE' }); });
    await mount();
    expect(container.textContent).toContain('已登录 13800138000');
    expect(container.textContent).not.toContain('重新手机验证');
    expect(snapshotFile()).toBe(saved);
  });
  it.each(['/redeem', '/auth/me'])('does not mark a non-identity POST %s 401 as authoritative legacy expiry', async endpoint => {
    await expect(client.request(endpoint, { method: 'POST', body: { code: 'test-only' } })).rejects.toMatchObject({ status: 401, code: 'NOT_LOGGED_IN' });
    expect(tokens.getAccessToken()).toBe('test-only-legacy-access');
  });
  it('keeps the expiry prompt/form and old disk credential if the new login cannot persist safely', async () => {
    const saved = snapshotFile();
    await mount();
    await click('重新手机验证');
    await input('#login-phone', '13900139000');
    await input('#login-code', '123456');
    cipher.isEncryptionAvailable.mockReturnValue(false);
    await click('登录 / 注册');
    expect(ui.error).toHaveBeenCalledWith('无法安全保存登录状态，请重试');
    expect(ui.success).not.toHaveBeenCalledWith('登录成功');
    expect(container.querySelector('#account-login-form')).not.toBeNull();
    expect(container.textContent).toContain('旧登录已失效');
    expect(snapshotFile()).toBe(saved);
    expect(tokens.getRefreshToken()).toBeNull();
  });
  it.each([200, 401])('does not apply a delayed A identity %s to a newly persisted B session', async status => {
    let respond;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
    const pending = api.authMe();
    expect(tokens.set({ accessToken: 'test-only-B-access', refreshToken: 'test-only-B-refresh', account: newAccount })).toBe(true);
    respond(reply(status, { success: status === 200, data: { account: oldAccount }, code: 'NOT_LOGGED_IN' }));
    expect(await pending).toMatchObject({ success: false, code: 'SESSION_CHANGED' });
    expect(tokens.get()).toMatchObject({ account: newAccount, refreshToken: 'test-only-B-refresh' });
    await mount();
    expect(container.textContent).toContain('已登录 13900139000');
    expect(container.textContent).not.toContain('旧登录已失效');
  });
  it.each([200, 401])('keeps the visible B account when the mounted A identity %s arrives after focus reread', async status => {
    let respond;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
    await mount();
    expect(container.textContent).toContain('已登录 13800138000');
    expect(tokens.set({ accessToken: 'test-only-B-access', refreshToken: 'test-only-B-refresh', account: newAccount })).toBe(true);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.textContent).toContain('已登录 13900139000');
    await act(async () => respond(reply(status, { success: status === 200, data: { account: oldAccount }, code: 'NOT_LOGGED_IN' })));
    expect(container.textContent).toContain('已登录 13900139000');
    expect(container.textContent).not.toContain('旧登录已失效');
    expect(tokens.get().account).toEqual(newAccount);
  });
  it('keeps the visible logged-out state when a mounted legacy identity check arrives late', async () => {
    let respond;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
    await mount();
    await click('退出');
    await act(async () => respond(reply(401, { code: 'NOT_LOGGED_IN' })));
    expect(container.textContent).not.toContain('已登录');
    expect(container.textContent).not.toContain('重新手机验证');
    expect(tokens.get()).toBeNull();
  });
  it('does not resurrect or demand reauthentication after explicit logout wins a pending identity check', async () => {
    let respond;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
    const pending = api.authMe();
    expect(await api.authLogout()).toMatchObject({ success: true });
    respond(reply(401, { code: 'NOT_LOGGED_IN' }));
    expect(await pending).toMatchObject({ success: false, code: 'SESSION_CHANGED' });
    expect(tokens.get()).toBeNull();
  });
});
