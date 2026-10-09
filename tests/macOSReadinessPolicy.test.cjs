const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertFirstUseReadiness, assertPreparedReadiness, assertModelBudget, waitForWorkerReadiness } = require('../scripts/macos-readiness-policy.cjs');
const first = () => ({
  models: { status: 'fulfilled', value: { success: true, models_downloaded: false, missing_models: ['asr', 'vad', 'punc'] } },
  controls: [{ visible: true, disabled: false, aria: '下载模型' }],
  samples: [{ pendingImportProcessCount: 1 }, { pendingImportProcessCount: 0 }],
  cacheAbsent: true,
});
test('first-use pass means missing models plus a real enabled download entry, never worker-ready', () => {
  assert.doesNotThrow(() => assertFirstUseReadiness(first()));
});
for (const bad of [
  { models: { status: 'pending' } },
  { models: { status: 'fulfilled', value: { success: true, models_downloaded: true } } },
  { controls: [] }, { controls: [{ visible: false, disabled: false, aria: '下载模型' }] },
  { controls: [{ visible: true, disabled: true, aria: '下载模型' }] },
  { samples: [{ pendingImportProcessCount: 2 }] }, { samples: [] }, { cacheAbsent: false },
]) test(`refuses misleading first-use pass ${JSON.stringify(bad)}`, () => assert.throws(() => assertFirstUseReadiness({ ...first(), ...bad })));
const prepared = () => ({
  worker: { server_ready: true, models_initialized: true },
  engines: ['sensevoice', 'paraformer'].map(engine => ({ success: true, requested_engine: engine, actual_engine: engine, fallback_reason: null })),
  modelsVerified: true,
});
test('prepared pass requires actual worker and both requested engines without fallback', () => assert.doesNotThrow(() => assertPreparedReadiness(prepared())));
for (const bad of [
  { worker: { server_ready: false, models_initialized: true } }, { modelsVerified: false }, { engines: [] },
  { engines: [{ success: true, requested_engine: 'sensevoice', actual_engine: 'paraformer', fallback_reason: 'missing' }] },
]) test(`refuses misleading prepared pass ${JSON.stringify(bad)}`, () => assert.throws(() => assertPreparedReadiness({ ...prepared(), ...bad })));
test('model preparation enforces the exact authorized resource bounds', () => {
  const budget = { freeDisk: 16 * 1024 ** 3, fileCount: 14, totalBytes: 1186817247, maximumWaitMs: 900000, symlinks: 0, extraFiles: 0 };
  assert.doesNotThrow(() => assertModelBudget(budget));
  for (const bad of [{ freeDisk: 14 * 1024 ** 3 }, { fileCount: 15 }, { totalBytes: 1186817248 }, { maximumWaitMs: 900001 }, { symlinks: 1 }, { extraFiles: 1 }]) assert.throws(() => assertModelBudget({ ...budget, ...bad }));
});
const startup = () => ({ status: 'fulfilled', value: { success: true, installed: true, models_downloaded: true, models_initialized: false, server_ready: false, initializing: true, start_error: null } });
test('a fulfilled starting snapshot is not final failure: bounded sequential reads wait for true readiness', async () => {
  let clock = 0, active = 0, maximum = 0, calls = 0;
  const result = await waitForWorkerReadiness(async index => {
    active++; maximum = Math.max(maximum, active); calls++;
    await new Promise(resolve => setImmediate(resolve)); active--;
    return index ? { status: 'fulfilled', value: { ...startup().value, server_ready: true, models_initialized: true } } : startup();
  }, { timeout: 100, interval: 10, now: () => clock, wait: ms => { clock += ms; } });
  assert.equal(result.ready, true); assert.equal(result.reads, 2); assert.equal(calls, 2); assert.equal(maximum, 1);
});
test('starting snapshots never pass readiness and stop at the global deadline', async () => {
  let clock = 0;
  const result = await waitForWorkerReadiness(async () => startup(), { timeout: 15, interval: 5, now: () => clock, wait: ms => { clock += ms; } });
  assert.equal(result.ready, false); assert.equal(result.timedOut, true); assert.equal(result.reads, 3); assert.equal(result.elapsedMs, 15);
});
test('a late ready snapshot cannot bypass the global startup deadline', async () => {
  let clock = 0;
  const result = await waitForWorkerReadiness(async () => { clock = 101; return { status: 'fulfilled', value: { ...startup().value, server_ready: true, models_initialized: true } }; }, { timeout: 100, now: () => clock });
  assert.equal(result.ready, false); assert.equal(result.timedOut, true); assert.equal(result.reads, 1);
});
for (const change of [{ status: 'pending' }, { status: 'rejected' }, { value: { ...startup().value, start_error: 'failed' } }, { value: { ...startup().value, installed: false } }, { value: { ...startup().value, success: false } }]) {
  test(`terminal or unsettled startup cannot retry or claim readiness ${JSON.stringify(change)}`, async () => {
    let calls = 0;
    const result = await waitForWorkerReadiness(async () => { calls++; return { ...startup(), ...change }; }, { timeout: 10 });
    assert.equal(result.ready, false); assert.equal(result.timedOut, false); assert.equal(calls, 1);
  });
}
