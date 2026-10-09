const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseInterfaces, chooseIsolation, withHostIsolation, assertNetworkLease } = require('../scripts/macos-host-isolation.cjs');
const { prepareOwnedAnchor, retainLease, restoreWithCleanup } = require('../scripts/macos-host-isolation.cjs');
const { write } = require('../scripts/macos-host-network.cjs');
const interfaces = 'lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384\n\tinet 127.0.0.1 netmask 0xff000000\n\tinet6 ::1 prefixlen 128\nen0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500\n\tinet 10.0.0.4 netmask 0xffffff00\ngif0: flags=8010<POINTOPOINT,MULTICAST> mtu 1280\n';
test('only valid live external interfaces are scoped for temporary restoration', () => {
  assert.deepEqual(parseInterfaces(interfaces), [{ name: 'lo0', up: true, loopback: true }, { name: 'en0', up: true, loopback: false }, { name: 'gif0', up: false, loopback: false }]);
});
test('an already attached standard PF wildcard and empty state table can use an owned anchor', () => {
  assert.equal(chooseIsolation({ enabled: true, children: '', rootRules: 'anchor "com.apple/*" all', states: '', interfaces }).method, 'pf-anchor');
});
test('unattached PF or preexisting states requires reversible VM uplink isolation, not global PF overwrite', () => {
  for (const state of [{ rootRules: '', states: '' }, { rootRules: 'pass out quick all', states: '' }, { rootRules: 'anchor "com.apple/*" all', states: 'existing external connection' }]) {
    const result = chooseIsolation({ ...state, interfaces });
    assert.equal(result.method, 'uplinks-offline'); assert.deepEqual(result.interfaces, ['en0']);
  }
});
test('unknown interface inventory, missing loopback or no active uplink is refused', () => {
  for (const value of ['', interfaces.replace('<UP,LOOPBACK', '<LOOPBACK'), interfaces.replace('en0: flags=8863<UP,', 'en0: flags=8863<')]) assert.throws(() => chooseIsolation({ rootRules: '', states: '', interfaces: value }));
});
const operations = (events, overrides = {}) => ({
  preflight: () => { events.push('preflight'); }, watchdog: () => { events.push('watchdog'); },
  configure: () => { events.push('configure'); }, verifyBlocked: () => { events.push('blocked'); },
  runProduct: () => { events.push('product'); }, cleanupProduct: () => { events.push('cleanup-product'); },
  restore: () => { events.push('restore'); }, verifyRestored: () => { events.push('verify-restored'); }, ...overrides,
});
test('normal lifecycle installs watchdog before mutation and cleans product before restoring network', async () => {
  const events = []; await withHostIsolation(operations(events));
  assert.deepEqual(events, ['preflight', 'watchdog', 'configure', 'blocked', 'product', 'cleanup-product', 'restore', 'verify-restored']);
});
test('wrong host or watchdog failure performs no network write/product start', async () => {
  for (const stage of ['preflight', 'watchdog']) {
    const events = []; await assert.rejects(withHostIsolation(operations(events, { [stage]: () => { throw new Error(stage); } })));
    assert.ok(!events.includes('configure') && !events.includes('product') && !events.includes('restore'));
  }
});
test('configuration, probe, product exception or timeout always cleans before restoration', async () => {
  for (const stage of ['configure', 'verifyBlocked', 'runProduct']) {
    const events = []; await assert.rejects(withHostIsolation(operations(events, { [stage]: () => { throw new Error(stage === 'runProduct' ? 'timeout' : stage); } })));
    assert.deepEqual(events.slice(-3), ['cleanup-product', 'restore', 'verify-restored']);
    if (stage !== 'runProduct') assert.ok(!events.includes('product'));
  }
});
test('unsafe product cleanup prevents restoring external connectivity', async () => {
  const events = []; await assert.rejects(withHostIsolation(operations(events, { cleanupProduct: () => { throw new Error('product still alive'); } })));
  assert.ok(!events.includes('restore'));
});
test('restoration errors are not claimed as success', async () => {
  for (const stage of ['restore', 'verifyRestored']) await assert.rejects(withHostIsolation(operations([], { [stage]: () => { throw new Error(stage); } })));
});
test('disabled PF or nonempty existing anchors are preserved rather than globally enabled/replaced', () => {
  for (const extra of [{ enabled: false }, { enabled: true, children: 'existing-service' }]) assert.equal(chooseIsolation({ rootRules: 'anchor "com.apple/*" all', states: '', interfaces, ...extra }).method, 'uplinks-offline');
});
test('product requires a matching active short-lived network lease with a live watchdog', () => {
  const now = 10000, lease = { root: '/runner/temp/task', harnessSha: 'abc', active: true, blockedProbesVerified: true, watchdogReady: true, watchdogPid: 123, deadline: now + 20 * 60000, method: 'uplinks-offline' };
  assert.doesNotThrow(() => assertNetworkLease(lease, '/runner/temp/task', 'abc', now));
  for (const extra of [{ root: '/elsewhere' }, { harnessSha: 'else' }, { active: false }, { blockedProbesVerified: false }, { watchdogReady: false }, { watchdogPid: 0 }, { deadline: now }, { deadline: now + 20 * 60000 + 1 }, { method: 'unknown' }]) assert.throws(() => assertNetworkLease({ ...lease, ...extra }, '/runner/temp/task', 'abc', now));
});
test('state publication is atomic and never truncates an already published lease', () => {
  const events = [], fake = {
    writeFileSync: (file, value, options) => { events.push(['write', file, JSON.parse(value), options]); },
    renameSync: (from, to) => { events.push(['rename', from, to]); },
    existsSync: () => false,
  };
  write('/runner/task', 'lease.json', { ready: true }, fake);
  assert.equal(events[0][0], 'write'); assert.notEqual(events[0][1], '/runner/task/lease.json');
  assert.equal(events[0][3].flag, 'wx'); assert.equal(events[0][3].mode, 0o600);
  assert.deepEqual(events[1], ['rename', events[0][1], '/runner/task/lease.json']);
  let removed;
  assert.throws(() => write('/runner/task', 'lease.json', {}, { ...fake, renameSync: () => { throw Error('rename'); }, existsSync: () => true, unlinkSync: file => { removed = file; } }));
  assert.notEqual(removed, '/runner/task/lease.json');
});
test('preexisting anchor rejection cannot mark mutation ownership or clear its rules', async () => {
  const events = [];
  await assert.rejects(prepareOwnedAnchor({ exists: () => true, validate: () => events.push('validate'), markIntent: () => events.push('intent'), install: () => events.push('install') }), /NETWORK_ANCHOR_ALREADY_EXISTS/);
  assert.deepEqual(events, []);
  await prepareOwnedAnchor({ exists: () => false, validate: () => events.push('validate'), markIntent: () => events.push('intent'), install: () => events.push('install') });
  assert.deepEqual(events, ['validate', 'intent', 'install']);
});
test('watchdog retains its last validated lease across transient corrupt or absent publications', () => {
  const old = { ownerPid: 1 }, validate = value => { if (!value.ownerPid) throw Error('invalid'); };
  assert.deepEqual(retainLease(() => { throw Error('partial JSON'); }, old, validate), { state: old, readFailed: true });
  assert.deepEqual(retainLease(() => ({ ownerPid: 2 }), old, validate), { state: { ownerPid: 2 }, readFailed: false });
  assert.deepEqual(retainLease(() => ({}), old, validate), { state: old, readFailed: true });
  assert.throws(() => retainLease(() => { throw Error('missing'); }, null, validate), /NETWORK_WATCHDOG_LEASE_UNAVAILABLE/);
});
test('watchdog retries cleanup failures and only restores after positively observing no owned product', async () => {
  const events = []; let attempts = 0;
  await restoreWithCleanup({ cleanup: () => { events.push('cleanup'); if (++attempts < 3) throw Error('alive'); }, restore: () => events.push('restore'), failure: () => events.push('failure'), wait: () => events.push('wait') });
  assert.deepEqual(events, ['cleanup', 'failure', 'wait', 'cleanup', 'failure', 'wait', 'cleanup', 'restore']);
  let restored = false;
  await assert.rejects(restoreWithCleanup({ cleanup: () => { throw Error('alive'); }, restore: () => { restored = true; }, failure: () => {}, wait: () => {} }), /NETWORK_WATCHDOG_PRODUCT_CLEANUP_FAILED/);
  assert.equal(restored, false);
  await assert.rejects(restoreWithCleanup({ cleanup: () => {}, restore: () => { throw Error('system failure'); }, failure: () => {}, wait: () => {} }), /NETWORK_WATCHDOG_RESTORE_FAILED/);
});
