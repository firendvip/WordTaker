import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { createOfflineFixture } = require('../scripts/desktop-ui-fixtures.cjs');

describe('offline packaged UI fixture boundaries', () => {
  it('rejects production URLs and unknown routes instead of falling through to network', async () => {
    const fixture = createOfflineFixture();
    await expect(fixture.fetch('https://look3.cn/api/v1/quota')).rejects.toThrow();
    await expect(fixture.fetch('https://fixture.invalid/api/v1/unknown')).rejects.toThrow();
    expect(fixture.calls).toEqual([]);
  });
  it('uses only fixture SMS/session/order responses with explicit states', async () => {
    const fixture = createOfflineFixture();
    const login = await (await fixture.fetch('https://fixture.invalid/api/v1/auth/sms/login', { method: 'POST' })).text();
    expect(JSON.parse(login).data.account.nickname).toBe('离线验收账号');
    for (const status of ['pending', 'paid', 'expired']) {
      fixture.payStatus = status;
      const order = JSON.parse(await (await fixture.fetch('https://fixture.invalid/api/v1/payment/order/17')).text()).data;
      expect(order.payStatus).toBe(status);
      expect(order.orderId).toBe('17');
    }
    fixture.wrongOrder = true;
    expect(JSON.parse(await (await fixture.fetch('https://fixture.invalid/api/v1/payment/order/17')).text()).data.orderId).toBe('18');
  });
  it('does not permit mock payment, redeem, browser checkout or arbitrary SMS send', async () => {
    const fixture = createOfflineFixture();
    for (const route of ['/payment/mock/pay', '/redeem', '/auth/sms/send']) {
      await expect(fixture.fetch(`https://fixture.invalid/api/v1${route}`, { method: 'POST' })).rejects.toThrow();
    }
    expect(fixture.calls).toEqual([]);
  });
  it('encrypts fixture session bytes without using OS safeStorage/keychain', () => {
    const { safeStorage } = createOfflineFixture();
    const encrypted = safeStorage.encryptString('offline-session-only');
    expect(encrypted.toString()).not.toContain('offline-session-only');
    expect(safeStorage.decryptString(encrypted)).toBe('offline-session-only');
    const corrupted = Buffer.from(encrypted);
    corrupted[corrupted.length - 1] ^= 1;
    expect(() => safeStorage.decryptString(corrupted)).toThrow();
  });
  it('records routes/methods only, never fixture tokens or submitted bodies', async () => {
    const fixture = createOfflineFixture();
    await fixture.fetch('https://fixture.invalid/api/v1/payment/order', { method: 'POST', headers: { Authorization: 'Bearer never-print-me' }, body: 'private' });
    expect(fixture.calls).toEqual([{ route: '/payment/order', method: 'POST' }]);
    expect(JSON.stringify(fixture.calls)).not.toContain('never-print-me');
  });
  it('supplies the packaged account screen quota, plans and profile without external resources', async () => {
    const fixture = createOfflineFixture();
    const get = async route => JSON.parse(await (await fixture.fetch(`https://fixture.invalid/api/v1${route}`)).text()).data;
    expect((await get('/quota')).cloudRemaining).toBe(12345);
    expect((await get('/payment/plans'))[0].name).toBe('离线验收套餐');
    expect((await get('/auth/me')).account).toEqual(fixture.account);
    await expect(fixture.fetch('https://fixture.invalid/outside')).rejects.toThrow();
    await expect(fixture.fetch('https://fixture.invalid/api/v1/quota', { method: 'POST' })).rejects.toThrow();
  });
});
