// Test-only boundaries for the frozen, already built 1.29.5 DMG.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const PRODUCT = Object.freeze({
  candidateSha: '98b7a4093936fad4d1152f39d0b342f5d79c2d37',
  originalMacBuildSha: '98b7a4093936fad4d1152f39d0b342f5d79c2d37',
  // The existing unpublished draft is deliberately not retargeted or overwritten.
  draftSourceSha: 'e40149aea4c1dbfa701fb434433e4f8210a82072',
  qaBaselineSha: 'e40149aea4c1dbfa701fb434433e4f8210a82072',
  assetId: 626599706,
  version: '1.29.5', dmgName: 'KittyEcho-1.29.5-arm64-sealed-98b7a409.dmg', dmgSize: 635266113,
  dmgSha256: '085ec9593aa767093915f5f3d51a86a3aa2ea5d2ae06c103a8eef5d8cbac4d00',
  asarSha256: 'b78d1feec1aa53ac7cd6a07920892f52d4b2bcb96b1e559735889466abc35187',
});
function assertHost(host) {
  assert.equal(host.platform, 'darwin');
  assert.equal(host.arch, 'arm64');
  assert.match(host.version, /^14\.\d+(?:\.\d+)?$/);
  assert.ok(host.totalMemory >= 6 * 1024 ** 3, 'Less than 6 GiB memory');
  assert.ok(host.freeDisk >= 8 * 1024 ** 3, 'Less than 8 GiB available storage');
  assert.equal(host.repositoryPublic, true, 'Only the standard public runner is authorized');
  const env = host.env;
  for (const [key, expected] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64', GITHUB_REPOSITORY: 'firendvip/WordTaker', ImageOS: 'macos14' })) assert.equal(env[key], expected, key);
  assert.ok(path.posix.isAbsolute(env.RUNNER_TEMP) && env.RUNNER_TEMP !== '/', 'Invalid runner temp directory');
  assert.ok(env.ImageVersion, 'Unknown runner image version');
}
function assertDraftAsset(release, asset) {
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0);
  assert.equal(release.tag_name, 'v1.29.5');
  assert.equal(release.target_commitish, PRODUCT.draftSourceSha);
  assert.equal(release.draft, true);
  assert.equal(release.published_at, null);
  assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0);
  assert.equal(asset.name, PRODUCT.dmgName);
  assert.equal(asset.size, PRODUCT.dmgSize);
  assert.equal(asset.digest, `sha256:${PRODUCT.dmgSha256}`);
  assert.equal(asset.state, 'uploaded');
}
function assertDownloadedDmg(size, sha256) {
  assert.equal(size, PRODUCT.dmgSize);
  assert.equal(sha256, PRODUCT.dmgSha256);
}
function assertFreshHost(state) {
  assert.deepEqual(state.installations, [], 'Existing application installation');
  assert.deepEqual(state.pids, [], 'Existing product process');
  assert.equal(state.legacyDataExists, false, 'Existing legacy application profile');
}
function assertScopedPath(target, parent) {
  const base = path.posix.resolve(parent), resolved = path.posix.resolve(target);
  assert.notEqual(base, '/');
  const relative = path.posix.relative(base, resolved);
  assert.ok(relative && relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative), 'Refusing broad/out-of-root cleanup');
  return resolved;
}
function captureBundleInventory(root) {
  assert.ok(path.isAbsolute(root), 'Absolute bundle root required');
  const stat = fs.lstatSync(root);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Real bundle directory required');
  const entries = {}, buffer = Buffer.alloc(1024 * 1024);
  const hashFile = file => {
    const hash = crypto.createHash('sha256'), fd = fs.openSync(file, 'r');
    try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
    finally { fs.closeSync(fd); }
    return hash.digest('hex');
  };
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), item = fs.lstatSync(file), relative = path.relative(root, file);
      const mode = item.mode & 0o7777;
      if (item.isSymbolicLink()) entries[relative] = { type: 'symlink', mode, target: fs.readlinkSync(file) };
      else if (item.isDirectory()) { entries[relative] = { type: 'directory', mode }; walk(file); }
      else { assert.ok(item.isFile(), 'Unsupported bundle resource'); entries[relative] = { type: 'file', mode, size: item.size, sha256: hashFile(file) }; }
    }
  }
  walk(root);
  return { entries, entryCount: Object.keys(entries).length, sha256: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}
function compareBundleInventories(before, after) {
  const added = Object.keys(after.entries).filter(file => !Object.hasOwn(before.entries, file));
  const removed = Object.keys(before.entries).filter(file => !Object.hasOwn(after.entries, file));
  const changed = Object.keys(before.entries).filter(file => Object.hasOwn(after.entries, file) && JSON.stringify(before.entries[file]) !== JSON.stringify(after.entries[file]));
  return { unchanged: !added.length && !removed.length && !changed.length, added, removed, changed };
}
function assertUiHealth(value) {
  assert.equal(value.version, PRODUCT.version);
  assert.equal(value.isolated, true);
  assert.equal(value.hasRoot, true);
  assert.ok(value.bodyText.trim() && !value.bodyText.includes('应用出现错误'));
  assert.equal(value.loggedIn, false);
}
function assertWorkerHealth(value) {
  assert.equal(value.server_ready, true);
  assert.equal(value.models_initialized, true);
}
function ipcProbeExpression(name, method, args = []) {
  assert.match(name, /^[a-z][a-z0-9-]{0,30}$/);
  assert.ok(['getAppVersion', 'getAuthState', 'getSetting', 'checkModelFiles', 'checkFunASRStatus', 'transcribeAudio'].includes(method));
  assert.ok(Array.isArray(args));
  const key = JSON.stringify(`__wordtakerQaProbe_${name}`), operation = JSON.stringify(method), argumentsJson = JSON.stringify(args);
  return `(()=>{ const key=${key}, method=${operation}, args=${argumentsJson}; let probe=globalThis[key]; if(probe && (probe.method!==method || probe.argumentsJson!==JSON.stringify(args))) throw Error('IPC_PROBE_KEY_COLLISION'); if(!probe){ probe={status:'pending',method,argumentsJson:JSON.stringify(args),startedAt:Date.now()}; globalThis[key]=probe; Promise.resolve().then(()=>window.electronAPI[method](...args)).then(value=>{probe.value=value;probe.status='fulfilled';probe.settledAt=Date.now();},()=>{probe.error='IPC_PROBE_REJECTED';probe.status='rejected';probe.settledAt=Date.now();}); } return probe; })()`;
}
async function pollIpcProbe(evaluate, name, method, args = [], options = {}) {
  const timeout = options.timeout || 10000, interval = options.interval || 250;
  const now = options.now || Date.now, wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const expression = ipcProbeExpression(name, method, args), started = now();
  let observed;
  do {
    observed = await evaluate(expression);
    assert.ok(['pending', 'fulfilled', 'rejected'].includes(observed.status), 'IPC_PROBE_INVALID_STATE');
    if (options.observe) await options.observe(observed);
    if (observed.status !== 'pending') return { ...observed, timedOut: false, elapsedMs: now() - started };
    await wait(Math.min(interval, timeout - (now() - started)));
  } while (now() - started < timeout);
  return { ...observed, timedOut: true, elapsedMs: now() - started };
}
module.exports = { PRODUCT, assertHost, assertDraftAsset, assertDownloadedDmg, assertFreshHost, assertScopedPath, captureBundleInventory, compareBundleInventories, assertUiHealth, assertWorkerHealth, ipcProbeExpression, pollIpcProbe };
