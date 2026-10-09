// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPanel } from '../src/components/account/AccountPanel';

const mocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), refresh: vi.fn(), clear: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('../src/components/account/useCloudQuota', () => ({ useCloudQuota: () => ({ refresh: mocks.refresh, clear: mocks.clear }) }));
vi.mock('../src/components/account/QuotaCard', () => ({ QuotaCard: ({ onLogin }) => <button onClick={onLogin}>打开登录</button> }));
vi.mock('../src/components/account/InviteCard', () => ({ InviteCard: () => null }));
vi.mock('../src/components/account/RedeemCard', () => ({ RedeemCard: ({ onRedeemed }) => <button onClick={onRedeemed}>兑换完成</button> }));
vi.mock('../src/components/account/PlansCard', () => ({ PlansCard: ({ onPurchased }) => <button onClick={onPurchased}>购买完成</button> }));
vi.mock('../src/components/account/MembershipHero', () => ({ MembershipHero: ({ account, onLogout, onRedeemed }) => <div>已登录 {account.phone}<button onClick={onLogout}>退出</button><button onClick={onRedeemed}>会员兑换完成</button></div> }));

describe('SMS is the only account login form', () => {
  let root, container, api;
  const button = (label) => [...container.querySelectorAll('button')].find((el) => el.textContent.includes(label));
  const click = async (label) => act(async () => { button(label).click(); });
  const input = async (placeholder, value) => act(async () => {
    const el = container.querySelector(`input[placeholder="${placeholder}"]`);
    expect(el).not.toBeNull();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    api = {
      getAuthState: vi.fn().mockResolvedValue({ loggedIn: false }),
      authSmsSend: vi.fn().mockResolvedValue({ success: true }),
      authSmsLogin: vi.fn().mockResolvedValue({ success: true, account: { phone: '13800138000' }, isNew: true }),
      authMe: vi.fn().mockResolvedValue({ success: true, account: { phone: '13800138000' } }),
      authLogout: vi.fn().mockResolvedValue({ success: true }),
      authEmailSend: vi.fn(), authEmailLogin: vi.fn(), authWechatLogin: vi.fn(),
    };
    window.electronAPI = api;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<AccountPanel rowLabelClass="label" />));
    await click('打开登录');
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete window.electronAPI;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    vi.useRealTimers();
  });
  it('shows phone and verification fields, never email, password or WeChat', () => {
    expect(container.querySelector('input[type="tel"]')).not.toBeNull();
    expect(container.querySelector('input[autocomplete="one-time-code"]')).not.toBeNull();
    expect(container.querySelector('input[type="email"], input[type="password"]')).toBeNull();
    expect(container.textContent).not.toMatch(/邮箱|密码|微信登录/);
  });
  it('disables sending for an invalid phone without calling any provider', async () => {
    await input('请输入手机号', '123');
    expect(button('获取验证码').disabled).toBe(true);
    await click('获取验证码');
    expect(api.authSmsSend).not.toHaveBeenCalled();
  });
  it('sends SMS once and permits resending only after the cooldown', async () => {
    await input('请输入手机号', '13800138000');
    await click('获取验证码');
    expect(api.authSmsSend).toHaveBeenCalledOnce();
    expect(api.authSmsSend).toHaveBeenCalledWith('13800138000');
    expect(button('60s').disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(60000));
    expect(button('获取验证码').disabled).toBe(false);
    expect(api.authEmailSend).not.toHaveBeenCalled();
  });
  it('shows send failure and permits a retry without a success countdown', async () => {
    api.authSmsSend.mockResolvedValue({ success: false, error: '短信服务暂不可用' });
    await input('请输入手机号', '13800138000');
    await click('获取验证码');
    expect(mocks.error).toHaveBeenCalledWith('短信服务暂不可用');
    expect(button('获取验证码').disabled).toBe(false);
  });
  it('logs in using phone/code, refreshes the account, and logs out normally', async () => {
    await input('请输入手机号', '13800138000');
    await input('6 位验证码', '123456');
    await click('登录 / 注册');
    expect(api.authSmsLogin).toHaveBeenCalledWith('13800138000', '123456', undefined);
    expect(container.querySelector('#account-login-form')).toBeNull();
    expect(container.textContent).toContain('已登录 13800138000');
    expect(mocks.refresh).toHaveBeenCalled();
    await click('退出');
    expect(api.authLogout).toHaveBeenCalledOnce();
    expect(mocks.clear).toHaveBeenCalledOnce();
    expect(api.authEmailLogin).not.toHaveBeenCalled();
    expect(api.authWechatLogin).not.toHaveBeenCalled();
  });
  it('rejects malformed verification codes locally', async () => {
    await input('请输入手机号', '13800138000');
    await input('6 位验证码', 'abcd');
    await click('登录 / 注册');
    expect(api.authSmsLogin).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('请输入 6 位数字验证码');
  });
  it('keeps the form open on an expired code and never falls back to other methods', async () => {
    api.authSmsLogin.mockResolvedValue({ success: false, error: '验证码无效或已过期' });
    await input('请输入手机号', '13800138000');
    await input('6 位验证码', '123456');
    await click('登录 / 注册');
    expect(mocks.error).toHaveBeenCalledWith('验证码无效或已过期');
    expect(container.querySelector('#account-login-form')).not.toBeNull();
    expect(container.textContent).not.toMatch(/邮箱|密码|微信登录/);
  });
  it('retains only SMS fields after Escape and reopening', async () => {
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('#account-login-form')).toBeNull();
    await click('打开登录');
    expect(container.querySelector('input[type="tel"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/邮箱|密码|微信登录/);
  });
  it('blocks login when the phone is invalid', async () => {
    await input('请输入手机号', '123');
    await input('6 位验证码', '123456');
    await click('登录 / 注册');
    expect(api.authSmsLogin).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('请输入正确的 11 位手机号');
  });
  it('clears the verification code when the phone changes', async () => {
    await input('请输入手机号', '13800138000');
    await input('6 位验证码', '123456');
    await input('请输入手机号', '13900139000');
    expect(container.querySelector('#login-code').value).toBe('');
  });
  it('disables login when the SMS bridge is missing without offering another method', async () => {
    delete api.authSmsSend;
    await act(async () => root.render(<AccountPanel key="missing-bridge" rowLabelClass="label" />));
    await click('打开登录');
    await input('请输入手机号', '13800138000');
    expect(container.querySelector('[role="alert"]').textContent).toContain('暂不支持手机验证码登录');
    expect(button('获取验证码').disabled).toBe(true);
    expect(button('登录 / 注册').disabled).toBe(true);
    expect(container.textContent).not.toMatch(/邮箱|密码|微信登录/);
  });
  it.each(['send', 'login'])('recovers from a rejected %s request', async (operation) => {
    await input('请输入手机号', '13800138000');
    if (operation === 'send') {
      api.authSmsSend.mockRejectedValue(new Error('offline'));
      await click('获取验证码');
      expect(mocks.error).toHaveBeenCalledWith('发送失败，请检查网络');
      expect(button('获取验证码').disabled).toBe(false);
    } else {
      api.authSmsLogin.mockRejectedValue(new Error('offline'));
      await input('6 位验证码', '123456');
      await click('登录 / 注册');
      expect(mocks.error).toHaveBeenCalledWith('登录失败，请重试');
      expect(button('登录 / 注册').disabled).toBe(false);
    }
    expect(container.querySelector('#account-login-form')).not.toBeNull();
  });
  it('blocks duplicate sends and login while the SMS request is pending', async () => {
    let resolveSend;
    api.authSmsSend.mockReturnValue(new Promise((resolve) => { resolveSend = resolve; }));
    await input('请输入手机号', '13800138000');
    const sendButton = button('获取验证码');
    await act(async () => sendButton.click());
    expect(sendButton.disabled).toBe(true);
    expect(button('登录 / 注册').disabled).toBe(true);
    expect(container.querySelector('#login-phone').disabled).toBe(true);
    await act(async () => sendButton.click());
    await click('登录 / 注册');
    expect(api.authSmsSend).toHaveBeenCalledOnce();
    expect(api.authSmsLogin).not.toHaveBeenCalled();
    await act(async () => resolveSend({ success: true }));
    expect(button('60s').disabled).toBe(true);
  });
  it('blocks duplicate logins and sends the optional invite code', async () => {
    let resolveLogin;
    api.authSmsLogin.mockReturnValue(new Promise((resolve) => { resolveLogin = resolve; }));
    await input('请输入手机号', '13800138000');
    await input('6 位验证码', '123456');
    await input('有邀请码可在此填写', ' INVITE ');
    await click('登录 / 注册');
    expect(button('登录 / 注册').disabled).toBe(true);
    expect(button('获取验证码').disabled).toBe(true);
    expect(container.querySelector('#login-code').disabled).toBe(true);
    await click('登录 / 注册');
    expect(api.authSmsLogin).toHaveBeenCalledOnce();
    expect(api.authSmsLogin).toHaveBeenCalledWith('13800138000', '123456', 'INVITE');
    await act(async () => resolveLogin({ success: true, account: { phone: '13800138000' }, isNew: false }));
    expect(mocks.success).toHaveBeenCalledWith('登录成功');
  });
  it('keeps unreadable session state unknown and restores it through a retry in the same component', async () => {
    api.getAuthState.mockResolvedValueOnce({ success: false, code: 'AUTH_STORAGE_UNAVAILABLE' });
    await act(async () => root.render(<AccountPanel key="session-failure" rowLabelClass="label" />));
    expect(container.querySelector('[role="alert"]').textContent).toContain('暂时无法读取登录状态');
    expect(button('打开登录')).toBeUndefined();
    expect(container.textContent).not.toContain('已登录');
    api.getAuthState.mockResolvedValue({ success: true, loggedIn: true, account: { phone: '13800138000' } });
    await click('重试读取登录状态');
    expect(container.textContent).toContain('已登录 13800138000');
    expect(api.authMe).toHaveBeenCalledOnce();
    expect(api.authSmsLogin).not.toHaveBeenCalled();
    expect(api.authSmsSend).not.toHaveBeenCalled();
  });
  it.each([null, undefined, { success: false }, {}])('does not render unknown session response %j as logged out', async (response) => {
    api.getAuthState.mockResolvedValueOnce(response);
    await act(async () => root.render(<AccountPanel key="unknown-session" rowLabelClass="label" />));
    expect(button('重试读取登录状态')).toBeDefined();
    expect(button('打开登录')).toBeUndefined();
    expect(api.authMe).not.toHaveBeenCalled();
  });
  it('offers a retry after a rejected local session read', async () => {
    api.getAuthState.mockRejectedValueOnce(new Error('keychain unavailable'));
    await act(async () => root.render(<AccountPanel key="rejected-read" rowLabelClass="label" />));
    expect(button('重试读取登录状态')).toBeDefined();
    expect(button('打开登录')).toBeUndefined();
  });
  it('shows ordinary phone login when the local store confirms there is no session', async () => {
    api.getAuthState.mockResolvedValue({ success: true, loggedIn: false, account: null });
    await act(async () => root.render(<AccountPanel key="no-session" rowLabelClass="label" />));
    expect(button('打开登录')).toBeDefined();
    expect(button('重试读取登录状态')).toBeUndefined();
    expect(api.authMe).not.toHaveBeenCalled();
  });
  it.each(['logout', 'switch'])('reads the current credentials if the user performed an external %s before retry', async (action) => {
    api.getAuthState.mockResolvedValueOnce({ success: false, code: 'AUTH_STORAGE_UNAVAILABLE' });
    await act(async () => root.render(<AccountPanel key="external-change" rowLabelClass="label" />));
    api.getAuthState.mockResolvedValue({ success: true, loggedIn: action === 'switch', account: { phone: '13900139000' } });
    api.authMe.mockResolvedValue({ success: true, account: { phone: '13900139000' } });
    await click('重试读取登录状态');
    expect(container.textContent).not.toContain('已登录 13800138000');
    if (action === 'switch') expect(container.textContent).toContain('已登录 13900139000');
    else expect(button('打开登录')).toBeDefined();
    expect(api.authSmsLogin).not.toHaveBeenCalled();
  });
  it('deduplicates pending retries, permits focus recovery, and never polls', async () => {
    api.getAuthState.mockResolvedValueOnce({ success: false, code: 'AUTH_STORAGE_UNAVAILABLE' });
    await act(async () => root.render(<AccountPanel key="retry-focus" rowLabelClass="label" />));
    let respond;
    api.getAuthState.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const calls = api.getAuthState.mock.calls.length;
    await click('重试读取登录状态');
    expect(button('重试读取登录状态').disabled).toBe(true);
    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => vi.advanceTimersByTime(3600000));
    expect(api.getAuthState).toHaveBeenCalledTimes(calls + 1);
    await act(async () => respond({ success: false, code: 'AUTH_STORAGE_UNAVAILABLE' }));
    expect(button('重试读取登录状态').disabled).toBe(false);
    api.getAuthState.mockResolvedValue({ success: true, loggedIn: true, account: { phone: '13800138000' } });
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.textContent).toContain('已登录 13800138000');
  });
  it.each(['logout', 'switch'])('ignores a late getAuthState reply after a renderer %s', async (action) => {
    api.getAuthState.mockResolvedValue({ success: true, loggedIn: true, account: { phone: '13800138000' } });
    await act(async () => root.render(<AccountPanel key="pending-state-read" rowLabelClass="label" />));
    let respond;
    api.getAuthState.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(respond).toBeTypeOf('function');
    await click('退出');
    if (action === 'switch') {
      api.authSmsLogin.mockResolvedValue({ success: true, account: { phone: '13900139000' } });
      api.authMe.mockResolvedValue({ success: true, account: { phone: '13900139000' } });
      await click('打开登录');
      await input('请输入手机号', '13900139000');
      await input('6 位验证码', '123456');
      await click('登录 / 注册');
    }
    const accountChecks = api.authMe.mock.calls.length;
    await act(async () => respond({ success: true, loggedIn: true, account: { phone: '13800138000' } }));
    expect(api.authMe).toHaveBeenCalledTimes(accountChecks);
    expect(container.textContent).not.toContain('已登录 13800138000');
    if (action === 'switch') expect(container.textContent).toContain('已登录 13900139000');
    else expect(button('打开登录')).toBeDefined();
  });
  it.each(['logout', 'switch', 'switch-rejected-old-session'])('ignores a late authMe reply after a renderer %s', async (action) => {
    api.getAuthState.mockResolvedValue({ success: true, loggedIn: true, account: { phone: '13800138000' } });
    let respond;
    api.authMe.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    await act(async () => root.render(<AccountPanel key="pending-account-check" rowLabelClass="label" />));
    await click('退出');
    if (action !== 'logout') {
      api.authSmsLogin.mockResolvedValue({ success: true, account: { phone: '13900139000' } });
      api.authMe.mockResolvedValue({ success: true, account: { phone: '13900139000' } });
      await click('打开登录');
      await input('请输入手机号', '13900139000');
      await input('6 位验证码', '123456');
      await click('登录 / 注册');
    }
    await act(async () => respond(action === 'switch-rejected-old-session'
      ? { success: false, loggedIn: false }
      : { success: true, account: { phone: '13800138000' } }));
    expect(container.textContent).not.toContain('已登录 13800138000');
    if (action !== 'logout') expect(container.textContent).toContain('已登录 13900139000');
    else expect(button('打开登录')).toBeDefined();
  });
  it.each(['getAuthState', 'authMe'])('discards late %s results and removes focus listeners on unmount', async (method) => {
    let respond;
    api.getAuthState.mockResolvedValue({ success: true, loggedIn: true, account: { phone: '13800138000' } });
    api[method].mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    await act(async () => root.render(<AccountPanel key="to-unmount" rowLabelClass="label" />));
    await act(async () => root.unmount());
    const reads = api.getAuthState.mock.calls.length;
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(api.getAuthState).toHaveBeenCalledTimes(reads);
    const checks = api.authMe.mock.calls.length;
    root = createRoot(container);
    api.getAuthState.mockResolvedValue({ success: true, loggedIn: true, account: { phone: '13900139000' } });
    api.authMe.mockResolvedValue({ success: true, account: { phone: '13900139000' } });
    await act(async () => root.render(<AccountPanel rowLabelClass="label" />));
    await act(async () => respond({ success: true, loggedIn: true, account: { phone: '13800138000' } }));
    expect(container.textContent).toContain('已登录 13900139000');
    expect(container.textContent).not.toContain('已登录 13800138000');
    expect(api.authMe).toHaveBeenCalledTimes(checks + 1);
  });
  it('retains the local account on a refresh failure and on a rejected logout', async () => {
    api.getAuthState.mockResolvedValue({ loggedIn: true, account: { phone: '13800138000' } });
    api.authMe.mockRejectedValue(new Error('offline'));
    api.authLogout.mockRejectedValue(new Error('unavailable'));
    await act(async () => root.render(<AccountPanel key="local-session" rowLabelClass="label" />));
    expect(container.textContent).toContain('已登录 13800138000');
    await click('退出');
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(container.textContent).toContain('已登录 13800138000');
    expect(mocks.success).not.toHaveBeenCalledWith('已退出登录');
    expect(mocks.error).toHaveBeenCalled();
  });
  it('reports failed persistent logout without hiding the account or clearing quota', async () => {
    api.getAuthState.mockResolvedValue({ loggedIn: true, account: { phone: '13800138000' } });
    api.authLogout.mockResolvedValue({ success: false, error: '退出未保存，请重试' });
    await act(async () => root.render(<AccountPanel key="failed-logout" rowLabelClass="label" />));
    await click('退出');
    expect(container.textContent).toContain('已登录 13800138000');
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalledWith('已退出登录');
    expect(mocks.error).toHaveBeenCalledWith('退出未保存，请重试');
  });
  it('returns to phone login after the server rejects an expired session', async () => {
    api.getAuthState.mockResolvedValue({ loggedIn: true, account: { phone: '13800138000' } });
    api.authMe.mockResolvedValue({ success: false, loggedIn: false });
    await act(async () => root.render(<AccountPanel key="expired-session" rowLabelClass="label" />));
    expect(container.textContent).not.toContain('已登录 13800138000');
    await click('打开登录');
    expect(container.querySelector('#login-phone')).not.toBeNull();
  });
  it('preserves account and quota refreshes after existing membership actions', async () => {
    api.authMe.mockResolvedValue({ success: false });
    await click('兑换完成');
    await click('购买完成');
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(api.authMe).toHaveBeenCalledTimes(2);
    api.authMe.mockResolvedValue({ success: true, account: { phone: '13800138000' } });
    await input('请输入手机号', '13800138000');
    await input('6 位验证码', '123456');
    await click('登录 / 注册');
    await click('会员兑换完成');
    await click('购买完成');
    expect(mocks.refresh).toHaveBeenCalledTimes(5);
    expect(api.authMe).toHaveBeenCalledTimes(5);
  });
  it('closes on the close button or backdrop, but not inside the form', async () => {
    await act(async () => container.querySelector('#account-login-form').click());
    expect(container.querySelector('#account-login-form')).not.toBeNull();
    await act(async () => container.querySelector('button[aria-label="关闭"]').click());
    expect(container.querySelector('#account-login-form')).toBeNull();
    await click('打开登录');
    await act(async () => container.querySelector('#account-login-form').parentElement.click());
    expect(container.querySelector('#account-login-form')).toBeNull();
  });
});
