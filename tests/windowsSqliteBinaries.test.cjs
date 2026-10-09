const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

function fixture(t, names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wordtaker-sqlite-pe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of names) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
  }
  return root;
}

function find(root, arch) {
  return require('../scripts/find-windows-sqlite.cjs').findWindowsSqliteBinaries(root, arch);
}

test('reproduces the old filename scan against the installed SQLite 13 distribution', () => {
  const packageRoot = path.dirname(require.resolve('better-sqlite3/package.json'));
  const oldMatches = fs.readdirSync(packageRoot, { recursive: true })
    .filter((name) => path.basename(name) === 'better_sqlite3.node');
  assert.deepEqual(oldMatches, []);
  for (const arch of ['x64', 'arm64']) {
    const file = path.join(packageRoot, 'prebuilds', `win32-${arch}.node`);
    assert.equal(fs.existsSync(file), true);
    assert.notEqual(path.basename(file), 'better_sqlite3.node');
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
    const peOffset = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.readUInt32LE(peOffset), 0x00004550);
    assert.equal(bytes.readUInt16LE(peOffset + 4), arch === 'x64' ? 0x8664 : 0xaa64);
  }
});

test('discovers the actual SQLite 13 Windows prebuild for each target', () => {
  const packageRoot = path.dirname(require.resolve('better-sqlite3/package.json'));
  for (const arch of ['x64', 'arm64']) {
    assert.deepEqual(find(packageRoot, arch), [
      path.join(packageRoot, 'prebuilds', `win32-${arch}.node`),
    ]);
  }
});

for (const layout of [
  'node_modules/better-sqlite3',
  'node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3',
]) {
  for (const arch of ['x64', 'arm64']) {
    test(`selects only ${arch} SQLite prebuilds in ${layout}`, (t) => {
      const names = ['win32-x64.node', 'win32-arm64.node', 'darwin-arm64.node', 'linux-x64.node'];
      const root = fixture(t, names.map((name) => `${layout}/prebuilds/${name}`));
      assert.deepEqual(find(root, arch), [path.join(root, layout, 'prebuilds', `win32-${arch}.node`)]);
    });
  }
}

test('preserves checks for legacy rebuilt binaries as well as the preferred prebuild', (t) => {
  const prefix = 'node_modules/better-sqlite3';
  const names = [
    `${prefix}/build/Debug/better_sqlite3.node`,
    `${prefix}/build/Release/better_sqlite3.node`,
    `${prefix}/prebuilds/win32-x64.node`,
  ];
  const root = fixture(t, names);
  assert.deepEqual(find(root, 'x64'), names.map((name) => path.join(root, name)).sort());
});

test('does not mistake another package Windows prebuild for SQLite', (t) => {
  const root = fixture(t, [
    'node_modules/other-package/prebuilds/win32-x64.node',
    'node_modules/better-sqlite3/not-prebuilds/win32-x64.node',
    'node_modules/better-sqlite3/prebuilds/win32-arm64.node',
  ]);
  assert.deepEqual(find(root, 'x64'), []);
});

test('returns no candidates when SQLite is absent, so the CI missing-file assertion can fail', (t) => {
  assert.deepEqual(find(fixture(t, []), 'arm64'), []);
});

test('refuses unsupported target architectures', (t) => {
  const root = fixture(t, []);
  for (const arch of ['ia32', 'darwin-arm64', '', undefined]) {
    assert.throws(() => find(root, arch), /Unsupported Windows architecture/);
  }
});

test('propagates missing-root errors instead of silently passing', (t) => {
  const root = fixture(t, []);
  assert.throws(() => find(path.join(root, 'missing'), 'x64'), { code: 'ENOENT' });
});

test('ignores directories whose names resemble native files', (t) => {
  const root = fixture(t, ['better_sqlite3.node/nested.txt']);
  assert.deepEqual(find(root, 'x64'), []);
});

test('cannot upload installers or publish Releases from the unqualified candidate workflow', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/build-windows.yml'), 'utf8');
  const uploadStep = workflow.slice(workflow.indexOf('- name: Upload Windows artifacts'));
  assert.match(uploadStep, /if: \$\{\{ false \}\}/);
  const releaseStep = workflow.split('- name: Publish to GitHub Release')[1].split('- name: Upload Windows artifacts')[0];
  assert.match(releaseStep, /if: \$\{\{ false \}\}/);
  assert.match(workflow, /permissions:\s+contents: read/);
});

test('resolves and executes the locked rebuild CLI without an npx-generated command shim', () => {
  const { resolveElectronRebuildCli } = require('../scripts/find-electron-rebuild.cjs');
  const cli = resolveElectronRebuildCli(path.join(__dirname, '..'));
  assert.equal(fs.existsSync(cli), true);
  const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(cli), '../package.json'), 'utf8'));
  assert.equal(metadata.name, '@electron/rebuild');
  assert.equal(metadata.version, '4.2.0');
  const help = require('node:child_process').execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help, /--arch/);
  assert.match(help, /--which-module/);
});

test('rebuild CLI resolver reports missing dependencies and emits the actual locked path', (t) => {
  const { resolveElectronRebuildCli } = require('../scripts/find-electron-rebuild.cjs');
  assert.throws(() => resolveElectronRebuildCli(fixture(t, [])), { code: 'MODULE_NOT_FOUND' });
  const output = require('node:child_process').execFileSync(process.execPath, [
    path.join(__dirname, '../scripts/find-electron-rebuild.cjs'),
  ], { encoding: 'utf8' });
  assert.equal(output.trim(), resolveElectronRebuildCli(path.join(__dirname, '..')));
});

test('Windows rebuild uses the locked Node CLI and rebuilds both modules in the project', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/build-windows.yml'), 'utf8');
  const step = workflow.split('- name: Rebuild native modules for Electron')[1].split('- name: Prepare embedded Python')[0];
  assert.match(step, /node scripts\/find-electron-rebuild\.cjs/);
  assert.match(step, /& node \$rebuildCli -f -w better-sqlite3,uiohook-napi --module-dir \. --arch/);
  assert.doesNotMatch(step, /npx/);
});

test('Windows prepares the pinned four-file model without dynamic host export', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/build-windows.yml'), 'utf8');
  const prepare = workflow.split('- name: Prepare pinned SenseVoice model')[1]?.split('- name: Build renderer')[0] || '';
  assert.match(prepare, /pnpm run prepare:sensevoice/);
  assert.match(prepare, /pnpm run verify:sensevoice/);
  assert.doesNotMatch(workflow, /Install host tooling for model download|snapshot_download|ci_download_sensevoice\.py|SenseVoiceSmall\("iic\/SenseVoiceSmall"/);
});

test('Windows checks the packaged four-file model with the shared size and SHA verifier', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/build-windows.yml'), 'utf8');
  const packed = workflow.split('- name: Assert SenseVoice model packed')[1].split('- name: Assert native modules')[0];
  assert.match(packed, /dist\\win-arm64-unpacked/);
  assert.match(packed, /dist\\win-unpacked/);
  assert.match(packed, /node scripts\/sensevoice-model\.js --verify "--model-dir=\$modelDir"/);
  assert.match(packed, /\$LASTEXITCODE -ne 0/);
});
