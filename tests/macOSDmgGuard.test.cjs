const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { assertHost, assertDraftAsset, assertDownloadedDmg, assertFreshHost, assertScopedPath, assertUiHealth, PRODUCT } = require('../scripts/macos-dmg-guard.cjs');
const host = () => ({ platform: 'darwin', arch: 'arm64', version: '14.8.9', totalMemory: 7 * 1024 ** 3, freeDisk: 10 * 1024 ** 3, repositoryPublic: true, env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64', GITHUB_REPOSITORY: 'firendvip/WordTaker', RUNNER_TEMP: '/Users/runner/work/_temp', ImageOS: 'macos14', ImageVersion: '20260831.0302.1' } });
test('accepts only the actually observed macOS14 native public hosted environment', () => assert.doesNotThrow(() => assertHost(host())));
for (const [key, value] of [['platform', 'linux'], ['arch', 'x64'], ['version', '15.0'], ['totalMemory', 1024], ['freeDisk', 1024], ['repositoryPublic', false]]) {
  test(`refuses incorrect or insufficient host ${key}`, () => assert.throws(() => assertHost({ ...host(), [key]: value })));
}
for (const [key, value] of [['GITHUB_ACTIONS', 'false'], ['RUNNER_ENVIRONMENT', 'self-hosted'], ['RUNNER_OS', 'Linux'], ['RUNNER_ARCH', 'X64'], ['GITHUB_REPOSITORY', 'someone/else'], ['RUNNER_TEMP', '/'], ['ImageOS', 'macos14-large'], ['ImageVersion', '']]) {
  test(`refuses local paid unknown or wrong runner ${key}`, () => assert.throws(() => assertHost({ ...host(), env: { ...host().env, [key]: value } })));
}
const draft = () => ({ id: 123, tag_name: 'v1.29.5', target_commitish: PRODUCT.candidateSha, draft: true, published_at: null });
const asset = () => ({ id: 456, name: PRODUCT.dmgName, size: PRODUCT.dmgSize, digest: `sha256:${PRODUCT.dmgSha256}`, state: 'uploaded' });
test('accepts only the exact frozen DMG from an unpublished e401 draft', () => assert.doesNotThrow(() => assertDraftAsset(draft(), asset())));
for (const [key, value] of [['target_commitish', 'main'], ['tag_name', 'v1.29.5-test'], ['draft', false], ['published_at', '2026-10-10'], ['id', 0]]) {
  test(`refuses changed draft source or publication ${key}`, () => assert.throws(() => assertDraftAsset({ ...draft(), [key]: value }, asset())));
}
for (const [key, value] of [['name', 'other.dmg'], ['size', 1], ['digest', 'sha256:fake'], ['state', 'new'], ['id', 0]]) {
  test(`refuses mismatched draft asset ${key}`, () => assert.throws(() => assertDraftAsset(draft(), { ...asset(), [key]: value })));
}
test('requires full raw size and hash rather than a receipt-only match', () => {
  assert.doesNotThrow(() => assertDownloadedDmg(PRODUCT.dmgSize, PRODUCT.dmgSha256));
  assert.throws(() => assertDownloadedDmg(1, PRODUCT.dmgSha256));
  assert.throws(() => assertDownloadedDmg(PRODUCT.dmgSize, 'fake'));
});
test('refuses any old installation legacy profile or live product process', () => {
  const fresh = { installations: [], pids: [], legacyDataExists: false };
  assert.doesNotThrow(() => assertFreshHost(fresh));
  for (const change of [{ installations: ['/Applications/KittyEcho.app'] }, { pids: [123] }, { legacyDataExists: true }]) assert.throws(() => assertFreshHost({ ...fresh, ...change }));
});
test('cleanup accepts only a strict named child and rejects roots sibling paths or the runner home', () => {
  assert.equal(assertScopedPath('/Users/runner/work/_temp/qa/installed', '/Users/runner/work/_temp/qa'), '/Users/runner/work/_temp/qa/installed');
  for (const unsafe of ['/', '/Users/runner', '/Users/runner/work/_temp/qa', '/Users/runner/work/_temp/qa2', '/Users/runner/work/_temp/qa/../other']) assert.throws(() => assertScopedPath(unsafe, '/Users/runner/work/_temp/qa'));
  assert.throws(() => assertScopedPath('/tmp/a', '/'));
});
test('requires real visible versioned isolated anonymous settings and worker readiness', () => {
  const ui = { version: '1.29.5', isolated: true, hasRoot: true, bodyText: '弦外小猫 设置', loggedIn: false, server_ready: true, models_initialized: true };
  assert.doesNotThrow(() => assertUiHealth(ui));
  for (const change of [{ version: '1.29.4' }, { isolated: false }, { hasRoot: false }, { bodyText: '' }, { bodyText: '应用出现错误' }, { loggedIn: true }, { server_ready: false }, { models_initialized: false }]) assert.throws(() => assertUiHealth({ ...ui, ...change }));
  assert.equal(path.posix.isAbsolute('/Users/runner/work/_temp'), true);
});
