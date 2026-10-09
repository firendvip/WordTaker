// Pure lifecycle policy. All actual system operations belong to a guarded disposable-VM adapter.
function parseInterfaces(text) {
  return text.split('\n').flatMap(line => {
    const value = line.match(/^([a-z][a-z0-9]*): flags=[0-9a-fx]+<([^>]*)>/i);
    if (!value) return [];
    const flags = value[2].split(',');
    return [{ name: value[1], up: flags.includes('UP'), loopback: flags.includes('LOOPBACK') }];
  });
}
function chooseIsolation(snapshot) {
  const interfaces = parseInterfaces(snapshot.interfaces);
  if (!interfaces.some(item => item.loopback && item.up)) throw new Error('NETWORK_LOOPBACK_NOT_READY');
  const external = interfaces.filter(item => item.up && !item.loopback).map(item => item.name);
  if (!external.length) throw new Error('NETWORK_UPLINK_INVENTORY_UNKNOWN');
  const attached = snapshot.enabled === true && !snapshot.children?.trim() && snapshot.rootRules.trim() === 'anchor "com.apple/*" all' && !snapshot.states.trim();
  return { method: attached ? 'pf-anchor' : 'uplinks-offline', interfaces: external, pfReason: attached ? 'EXISTING_WILDCARD_AND_EMPTY_STATES' : 'PF_NOT_SAFELY_ATTACHED_OR_EXISTING_STATES' };
}
function assertNetworkLease(lease, root, harnessSha, now = Date.now()) {
  if (lease.root !== root || lease.harnessSha !== harnessSha || lease.active !== true || lease.blockedProbesVerified !== true || lease.watchdogReady !== true || !Number.isSafeInteger(lease.watchdogPid) || lease.watchdogPid <= 0 || !Number.isFinite(lease.deadline) || lease.deadline <= now || lease.deadline - now > 20 * 60000 || !['pf-anchor', 'uplinks-offline'].includes(lease.method)) throw new Error('NETWORK_LEASE_REJECTED');
}
async function prepareOwnedAnchor(ops) {
  if (await ops.exists()) throw new Error('NETWORK_ANCHOR_ALREADY_EXISTS');
  await ops.validate();
  await ops.markIntent();
  await ops.install();
}
function retainLease(read, previous, validate) {
  try { const state = read(); validate(state); return { state, readFailed: false }; }
  catch { if (!previous) throw new Error('NETWORK_WATCHDOG_LEASE_UNAVAILABLE'); return { state: previous, readFailed: true }; }
}
async function restoreWithCleanup(ops) {
  let stage;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { stage = 'PRODUCT_CLEANUP'; await ops.cleanup(); stage = 'RESTORE'; await ops.restore(); return; }
    catch {
      await ops.failure({ attempt, stage });
      if (attempt === 5) throw new Error(`NETWORK_WATCHDOG_${stage}_FAILED`);
      await ops.wait();
    }
  }
}
async function withHostIsolation(ops) {
  await ops.preflight();
  await ops.watchdog();
  try {
    await ops.configure();
    await ops.verifyBlocked();
    await ops.runProduct();
  } finally {
    await ops.cleanupProduct();
    await ops.restore();
    await ops.verifyRestored();
  }
}
module.exports = { parseInterfaces, chooseIsolation, withHostIsolation, assertNetworkLease, prepareOwnedAnchor, retainLease, restoreWithCleanup };
