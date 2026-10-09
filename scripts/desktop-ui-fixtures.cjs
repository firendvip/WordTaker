// Test-only fake backend and encryption. Not included in the product package.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function createOfflineFixture() {
  const key = crypto.randomBytes(32);
  const fixture = {
    calls: [],
    payStatus: 'pending',
    wrongOrder: false,
    account: { userId: 'offline-qa', nickname: '离线验收账号', phone: '13800138000' },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString(value) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
      },
      decryptString(value) {
        const cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
        cipher.setAuthTag(value.subarray(12, 28));
        return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
      },
    },
  };
  fixture.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://fixture.invalid', 'Production network is forbidden in this harness');
    assert.ok(url.pathname.startsWith('/api/v1/'));
    const route = url.pathname.slice('/api/v1'.length);
    const method = options.method || 'GET';
    let data;
    if (route === '/quota' && method === 'GET') data = { userId: 'offline-qa', registered: true, cloudRemaining: 12345, subscription: null, dailyUsed: 0, dailyCap: 50000 };
    else if (route === '/payment/plans' && method === 'GET') data = [{ code: 'qa_only', name: '离线验收套餐', priceCents: 900, charAmount: 150000, validityDays: 365, type: 'char_package' }];
    else if (route === '/auth/sms/login' && method === 'POST') data = { accessToken: 'offline-fixture-access', refreshToken: 'offline-fixture-refresh', account: fixture.account };
    else if (route === '/auth/me' && method === 'GET') data = { account: fixture.account };
    else if (route === '/payment/order' && method === 'POST') data = { orderId: '17', channel: 'wechat', planCode: 'qa_only', priceCents: 900, payload: { mock: false, codeUrl: 'weixin://wxpay/bizpayurl?pr=offline_qa_only', expiresAt: '2099-01-01T00:00:00Z' } };
    else if (route === '/payment/order/17' && method === 'GET') data = { orderId: fixture.wrongOrder ? '18' : '17', channel: 'wechat', payStatus: fixture.payStatus };
    else throw new Error(`No offline fixture for ${method} ${route}`);
    fixture.calls.push({ route, method });
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data }) };
  };
  return fixture;
}
module.exports = { createOfflineFixture };
