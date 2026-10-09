const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = () => fs.readFileSync(new URL('../.github/workflows/accept-macos14-dmg.yml', `file://${__filename}`), 'utf8');
test('repository metadata uses the real API root without the observed 404 trailing slash', () => {
  const { repositoryApiUrl } = require('../scripts/macos-dmg-transport.cjs');
  assert.equal(repositoryApiUrl(''), 'https://api.github.com/repos/firendvip/WordTaker');
  assert.equal(repositoryApiUrl('releases/408254714'), 'https://api.github.com/repos/firendvip/WordTaker/releases/408254714');
  assert.equal(repositoryApiUrl('releases/assets/625938591'), 'https://api.github.com/repos/firendvip/WordTaker/releases/assets/625938591');
});
test('only a manual or exact test-branch push invokes the standard read-only macos14 job', () => {
  const text = source();
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /runs-on: macos-14\s/);
  assert.match(text, /permissions:\s+contents: read/);
  assert.doesNotMatch(text, /contents: write|macos-14-large|macos-14-xlarge|self-hosted|pull_request:/);
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /push:\s+branches: \[codex\/macos14-acceptance\]/);
  assert.match(text, /paths:\s+- '\.github\/workflows\/accept-macos14-dmg\.yml'/);
  assert.doesNotMatch(text, /branches: \[(?:main|\*|master)\]|paths:.*\*/);
  assert.match(text, /DRAFT_RELEASE_ID: \$\{\{ inputs\.draft_release_id \|\| '408254714' \}\}/);
  assert.match(text, /DMG_ASSET_ID: \$\{\{ inputs\.dmg_asset_id \|\| '625938591' \}\}/);
});
test('transports frozen assets before real acceptance without building or installing dependencies', () => {
  const text = source();
  assert.ok(text.indexOf('macos-dmg-transport.cjs') < text.indexOf('macos-host-network.cjs --accept'));
  assert.doesNotMatch(text, /pnpm install|npm install|pip install|build:mac|prepare:python|brew install|npx .*latest|release (?:create|edit|upload)/);
});
test('credentials exist only at the read-only transport boundary and evidence excludes packages', () => {
  const text = source();
  assert.equal(text.match(/GH_TOKEN:/g)?.length, 1);
  assert.match(text, /GH_TOKEN: \$\{\{ github.token \}\}/);
  assert.equal(text.match(/secrets\.WORDTAKER_MAC_DMG_ONCE_408254714/g)?.length, 1);
  assert.match(text, /WORDTAKER_DMG_URL: \$\{\{ secrets\.WORDTAKER_MAC_DMG_ONCE_408254714 \}\}/);
  assert.match(text, /if:.*github\.repository == 'firendvip\/WordTaker'.*github\.ref == 'refs\/heads\/codex\/macos14-acceptance'/);
  assert.match(text, /github\.event\.repository\.fork == false/);
  assert.match(text, /tests\/macOSSignedDmg\.test\.cjs/);
  assert.match(text, /MAC_RUNTIME_ACCEPTANCE\.json/);
  assert.match(text, /settings\.png/);
  assert.doesNotMatch(text, /xattr -d|tccutil|spctl --master-disable|security (?:add|delete|unlock)|\.dmg\s*$|\.exe\s*$|path:.*\*/m);
});
test('CI never reclaims a successful private draft metadata read or exposes signed fetch errors', () => {
  const text = fs.readFileSync(new URL('../scripts/macos-dmg-transport.cjs', `file://${__filename}`), 'utf8');
  assert.doesNotMatch(text, /await api\(`releases\//);
  assert.match(text, /safeTransportError\(error\)/);
  assert.doesNotMatch(text, /String\(error\.message\)|process\.stderr\.write\(`\$\{error\.message\}/);
  assert.match(text, /delete process\.env\.WORDTAKER_DMG_URL/);
});
test('failure cleanup never signals an exited/reused PID or removes a runner home/profile', () => {
  const text = fs.readFileSync(new URL('../scripts/macos-dmg-acceptance.cjs', `file://${__filename}`), 'utf8');
  assert.match(text, /if \(child && !cleanExit && child\.exitCode === null && child\.signalCode === null\)/);
  assert.match(text, /fs\.lstatSync\(install\)\.isDirectory\(\)/);
  assert.doesNotMatch(text, /fs\.rmSync\((?:legacy|root|os\.homedir\(|process\.env\.HOME)/);
  assert.doesNotMatch(text, /xattr.*\['-d'|tccutil|--master-disable|requestPermissions\(/);
  assert.doesNotMatch(text, /sandbox-exec|--no-sandbox|--disable-gpu-sandbox/);
  assert.match(text, /assertNetworkLease\(/);
});
test('host isolation has an independent watchdog and never overwrites global PF or writes system files', () => {
  const text = fs.readFileSync(new URL('../scripts/macos-host-network.cjs', `file://${__filename}`), 'utf8');
  assert.match(text, /detached: true/); assert.match(text, /20 \* 60000/);
  assert.match(text, /await cleanupOwned\(root\); result\.productProcessesAbsentBeforeRestore = true/);
  assert.doesNotMatch(text, /\['-d'\]|\['-F', '(?:all|states)'\]|\/etc\/pf\.conf.*write|--no-sandbox/);
});
