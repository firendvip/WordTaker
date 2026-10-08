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
