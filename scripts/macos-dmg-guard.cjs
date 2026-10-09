// Test-only boundaries for the frozen, already built 1.29.5 DMG.
const assert = require('node:assert/strict');
const path = require('node:path');
const PRODUCT = Object.freeze({
  candidateSha: 'e40149aea4c1dbfa701fb434433e4f8210a82072',
  originalMacBuildSha: '62fc18164e8059784c32cdf9a83c1d2ee86f8f3d',
  version: '1.29.5', dmgName: 'KittyEcho-1.29.5-arm64.dmg', dmgSize: 635262839,
  dmgSha256: 'c0b9ec17c6c40304255b5ef2d4cb5c127f13b58481a90cd5b770e15898978d2a',
  asarSha256: '922b7d10ba777583b9d6890b36768f5ca5d2d461f75b40bf902ad929014196b5',
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
  assert.equal(release.target_commitish, PRODUCT.candidateSha);
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
function assertUiHealth(value) {
  assert.equal(value.version, PRODUCT.version);
  assert.equal(value.isolated, true);
  assert.equal(value.hasRoot, true);
  assert.ok(value.bodyText.trim() && !value.bodyText.includes('应用出现错误'));
  assert.equal(value.loggedIn, false);
  assert.equal(value.server_ready, true);
  assert.equal(value.models_initialized, true);
}
module.exports = { PRODUCT, assertHost, assertDraftAsset, assertDownloadedDmg, assertFreshHost, assertScopedPath, assertUiHealth };
