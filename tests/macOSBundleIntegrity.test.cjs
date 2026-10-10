const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { captureBundleInventory, compareBundleInventories } = require('../scripts/macos-dmg-guard.cjs');
const owned = [];
afterEach(() => { for (const root of owned.splice(0)) fs.rmSync(root, { recursive: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wordtaker-bundle-integrity-test-'));
  owned.push(root);
  const resources = path.join(root, 'Contents/Resources/app.asar.unpacked/python');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(root, 'Contents/Resources/app.asar'), 'unchanged asar');
  fs.writeFileSync(path.join(resources, 'library.py'), 'original sealed library');
  return { root, resources };
}
test('whole-bundle inventory is deterministic and accepts unchanged resources', () => {
  const { root } = fixture();
  const before = captureBundleInventory(root), after = captureBundleInventory(root);
  assert.deepEqual(before, after);
  assert.match(before.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(compareBundleInventories(before, after), { unchanged: true, added: [], removed: [], changed: [] });
});
test('detects runtime Numba caches even when app.asar and executable are unchanged', () => {
  const { root, resources } = fixture(), before = captureBundleInventory(root);
  fs.mkdirSync(path.join(resources, '__pycache__'));
  fs.writeFileSync(path.join(resources, '__pycache__/library.py311.1.nbc'), 'jit bytes');
  const result = compareBundleInventories(before, captureBundleInventory(root));
  assert.equal(result.unchanged, false);
  assert.deepEqual(result.added, ['Contents/Resources/app.asar.unpacked/python/__pycache__', 'Contents/Resources/app.asar.unpacked/python/__pycache__/library.py311.1.nbc']);
  assert.deepEqual(result.removed, []); assert.deepEqual(result.changed, []);
});
test('detects changed bytes, deleted sealed resources and permission changes', () => {
  const { root, resources } = fixture(), before = captureBundleInventory(root);
  fs.writeFileSync(path.join(resources, 'library.py'), 'changed sealed library!');
  fs.unlinkSync(path.join(root, 'Contents/Resources/app.asar'));
  fs.chmodSync(resources, 0o500);
  const result = compareBundleInventories(before, captureBundleInventory(root));
  assert.equal(result.unchanged, false);
  assert.deepEqual(result.removed, ['Contents/Resources/app.asar']);
  assert.deepEqual(result.changed, ['Contents/Resources/app.asar.unpacked/python', 'Contents/Resources/app.asar.unpacked/python/library.py']);
  fs.chmodSync(resources, 0o700);
});
test('records symlink targets without following them outside the bundle', () => {
  const { root, resources } = fixture();
  fs.symlinkSync('/path/that/must/not/be/read', path.join(resources, 'link'));
  const before = captureBundleInventory(root);
  assert.equal(before.entries['Contents/Resources/app.asar.unpacked/python/link'].target, '/path/that/must/not/be/read');
  fs.unlinkSync(path.join(resources, 'link'));
  fs.symlinkSync('/different/external/target', path.join(resources, 'link'));
  assert.deepEqual(compareBundleInventories(before, captureBundleInventory(root)).changed, ['Contents/Resources/app.asar.unpacked/python/link']);
});
test('rejects relative or symlinked bundle roots', () => {
  const { root } = fixture();
  assert.throws(() => captureBundleInventory('relative.app'));
  const link = path.join(root, 'alias'); fs.symlinkSync(root, link);
  assert.throws(() => captureBundleInventory(link));
});
