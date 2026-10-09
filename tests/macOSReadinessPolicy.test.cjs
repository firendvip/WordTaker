const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertFirstUseReadiness, assertPreparedReadiness, assertModelBudget } = require('../scripts/macos-readiness-policy.cjs');
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
