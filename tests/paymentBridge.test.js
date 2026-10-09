import fs from 'node:fs';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
describe('payment main-process boundary', () => {
  let handlers, backend, tokens;
  beforeEach(() => {
    handlers = new Map(); backend = { createOrder: vi.fn(), getPaymentOrder: vi.fn() };
    tokens = { getAccessToken: vi.fn().mockReturnValue('test-token') };
    const context = { module: { exports: {} }, require: name => {
      if (name === 'electron') return { ipcMain: { handle: (key, fn) => handlers.set(key, fn) } };
      if (name === './aiService') return class {};
      if (name === '../utils/shortTextPolicy.cjs') return {};
      if (name === './backendClient') return backend;
      if (name === './tokenStore') return tokens;
      throw new Error(name);
    } };
    vm.runInNewContext(read('../src/helpers/ipcHandlers.js'), context);
    context.module.exports.prototype.setupBillingHandlers.call({ logger: { warn: vi.fn() } });
  });
  it.each(['other', undefined, {}, 'WECHAT'])('rejects unknown payment channel %j', async channel => {
    expect(await handlers.get('create-order')({}, 'pkg_small', channel)).toMatchObject({ success: false, code: 'INVALID_CHANNEL' });
    expect(backend.createOrder).not.toHaveBeenCalled();
  });
  it.each(['../auth/me', '0', '-1', '1.2', {}, null])('rejects unsafe order ID %j', async id => {
    expect(await handlers.get('get-payment-order')({}, id)).toMatchObject({ success: false, code: 'INVALID_ORDER' });
    expect(backend.getPaymentOrder).not.toHaveBeenCalled();
  });
  it('requires the main-process token and returns only order data', async () => {
    tokens.getAccessToken.mockReturnValue(null);
    expect(await handlers.get('get-payment-order')({}, '17')).toMatchObject({ success: false, code: 'UNAUTHORIZED' });
    expect(backend.getPaymentOrder).not.toHaveBeenCalled();
    tokens.getAccessToken.mockReturnValue('test-token');
    backend.getPaymentOrder.mockResolvedValue({ orderId: '17', payStatus: 'pending' });
    expect(await handlers.get('get-payment-order')({}, '17')).toEqual({ success: true, order: { orderId: '17', payStatus: 'pending' } });
  });
  it('exposes the exact preload order lookup bridge', () => {
    let api; const invoke = vi.fn();
    vm.runInNewContext(read('../preload.js'), { process: { env: {}, platform: 'darwin' }, require: () => ({ contextBridge: { exposeInMainWorld: (key, value) => { if (key === 'electronAPI') api = value; } }, ipcRenderer: { invoke } }) });
    api.getPaymentOrder('17');
    expect(invoke).toHaveBeenCalledWith('get-payment-order', '17');
  });
});
