const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseInterfaces, chooseIsolation, withHostIsolation } = require('../scripts/macos-host-isolation.cjs');
const interfaces = 'lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384\n\tinet 127.0.0.1 netmask 0xff000000\n\tinet6 ::1 prefixlen 128\nen0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500\n\tinet 10.0.0.4 netmask 0xffffff00\ngif0: flags=8010<POINTOPOINT,MULTICAST> mtu 1280\n';
test('only valid live external interfaces are scoped for temporary restoration', () => {
  assert.deepEqual(parseInterfaces(interfaces), [{ name: 'lo0', up: true, loopback: true }, { name: 'en0', up: true, loopback: false }, { name: 'gif0', up: false, loopback: false }]);
});
test('an already attached standard PF wildcard and empty state table can use an owned anchor', () => {
  assert.equal(chooseIsolation({ rootRules: 'anchor "com.apple/*" all', states: '', interfaces }).method, 'pf-anchor');
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
