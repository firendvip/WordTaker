const assert = require('node:assert/strict');
const MODEL_BYTES = 1186817247;
function assertFirstUseReadiness(value) {
  assert.equal(value.cacheAbsent, true, 'Scenario A must remain unprepared');
  assert.equal(value.models.status, 'fulfilled');
  assert.equal(value.models.value.success, true);
  assert.equal(value.models.value.models_downloaded, false);
  assert.deepEqual([...value.models.value.missing_models].sort(), ['asr', 'punc', 'vad']);
  assert.ok(value.controls.some(button => button.visible && !button.disabled && /下载/.test(button.aria || button.text || '')), 'No real enabled first-use download entry');
  assert.ok(value.samples.length > 0, 'No process observations');
  assert.ok(value.samples.every(sample => sample.pendingImportProcessCount <= 1), 'Installation imports accumulated');
}
function assertPreparedReadiness(value) {
  assert.equal(value.modelsVerified, true);
  assert.equal(value.worker.server_ready, true);
  assert.equal(value.worker.models_initialized, true);
  assert.equal(value.engines.length, 2);
  for (const engine of ['sensevoice', 'paraformer']) {
    const result = value.engines.find(item => item.requested_engine === engine);
    assert.ok(result && result.success === true);
    assert.equal(result.actual_engine, engine);
    assert.ok(!result.fallback_reason, 'Engine fallback cannot pass exact-engine acceptance');
  }
}
function assertModelBudget(value) {
  assert.ok(value.freeDisk >= 15 * 1024 ** 3, 'Need at least 15 GiB before model preparation');
  assert.equal(value.fileCount, 14);
  assert.equal(value.totalBytes, MODEL_BYTES);
  assert.ok(value.maximumWaitMs > 0 && value.maximumWaitMs <= 900000);
  assert.equal(value.symlinks, 0);
  assert.equal(value.extraFiles, 0);
}
module.exports = { MODEL_BYTES, assertFirstUseReadiness, assertPreparedReadiness, assertModelBudget };
