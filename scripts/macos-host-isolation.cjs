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
  const attached = snapshot.rootRules.trim() === 'anchor "com.apple/*" all' && !snapshot.states.trim();
  return { method: attached ? 'pf-anchor' : 'uplinks-offline', interfaces: external, pfReason: attached ? 'EXISTING_WILDCARD_AND_EMPTY_STATES' : 'PF_NOT_SAFELY_ATTACHED_OR_EXISTING_STATES' };
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
module.exports = { parseInterfaces, chooseIsolation, withHostIsolation };
