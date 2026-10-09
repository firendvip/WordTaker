// Disposable-VM-only isolation. Never run system operations before host/ref guards.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), tls = require('node:tls');
const { Resolver } = require('node:dns').promises;
const { spawnSync, execFileSync, spawn } = require('node:child_process');
const { PRODUCT, assertHost, assertScopedPath } = require('./macos-dmg-guard.cjs');
const { assertTransportContext } = require('./macos-signed-dmg.cjs');
const { chooseIsolation, parseInterfaces, withHostIsolation, prepareOwnedAnchor, retainLease, restoreWithCleanup } = require('./macos-host-isolation.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function command(exe, args, options = {}) { const value = spawnSync(exe, args, { encoding: 'utf8', timeout: 15000, ...options }); return { status: value.status, stdout: value.stdout || '', stderr: value.stderr || '' }; }
function checked(exe, args, options) { const value = command(exe, args, options); if (value.status !== 0) throw new Error('NETWORK_SYSTEM_OPERATION_FAILED'); return value.stdout.trim(); }
const pf = args => command('/usr/bin/sudo', ['-n', '/sbin/pfctl', ...args]);
function guardedRoot(input) {
  assertTransportContext(process.env, '408254714', String(PRODUCT.assetId));
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('NETWORK_HOST_REJECTED');
  const parent = fs.realpathSync(process.env.RUNNER_TEMP);
  return assertScopedPath(fs.realpathSync(assertScopedPath(input, parent)), parent);
}
let publication = 0;
function write(root, name, value, files = fs) {
  const target = path.join(root, name), temporary = `${target}.${process.pid}.${++publication}.tmp`;
  try { files.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); files.renameSync(temporary, target); }
  finally { if (files.existsSync(temporary)) files.unlinkSync(temporary); }
}
function snapshot() {
  return { rules: pf(['-sr']), allRules: pf(['-a', '*', '-sr']), info: pf(['-s', 'info']), states: pf(['-ss']), children: pf(['-a', 'com.apple', '-s', 'Anchors']), interfaces: command('/sbin/ifconfig', ['-a']) };
}
function planFrom(value) { return chooseIsolation({ enabled: value.info.status === 0 && value.states.status === 0 && value.children.status === 0 && /^Status: Enabled/m.test(value.info.stdout), children: value.children.stdout, rootRules: value.rules.stdout, states: value.states.stdout, interfaces: value.interfaces.stdout }); }
function hostGuard(root) {
  const stats = fs.statfsSync(root), version = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
  const host = { version, arch: process.arch, totalMemory: os.totalmem(), freeDisk: Number(stats.bavail) * Number(stats.bsize), imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion, repositoryPrivateFromTrustedEvent: process.env.WORDTAKER_REPOSITORY_PRIVATE };
  write(root, 'HOST_GUARD_OBSERVATIONS.json', host);
  assertHost({ platform: process.platform, arch: process.arch, version, totalMemory: host.totalMemory, freeDisk: host.freeDisk, repositoryPublic: process.env.WORDTAKER_REPOSITORY_PRIVATE === 'false', env: process.env });
  return host;
}
function tcpProbe(host, family) {
  return new Promise(resolve => {
    const socket = net.connect({ host, family, port: 443 });
    const finish = result => { socket.destroy(); resolve(result); };
    socket.once('connect', () => finish({ host, family, connected: true }));
    socket.once('error', error => finish({ host, family, connected: false, code: error.code }));
    socket.setTimeout(4000, () => finish({ host, family, connected: false, code: 'TIMEOUT' }));
  });
}
async function preflight() {
  assertTransportContext(process.env, '408254714', String(PRODUCT.assetId));
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('NETWORK_HOST_REJECTED');
  const parent = fs.realpathSync(process.env.RUNNER_TEMP), root = assertScopedPath(fs.mkdtempSync(path.join(parent, 'wordtaker-network-')), parent);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `root=${root}\n`);
  const report = { success: false, stage: 'host-readonly-preflight', harnessSha: process.env.GITHUB_SHA, systemConfigurationWritten: false };
  try {
    report.host = hostGuard(root);
    report.pf = snapshot();
    report.interfaces = report.pf.interfaces;
    if (report.interfaces.status !== 0) throw new Error('NETWORK_INTERFACE_READ_FAILED');
    report.routes = { ipv4: command('/sbin/route', ['-n', 'get', 'default']), ipv6: command('/sbin/route', ['-n', 'get', '-inet6', 'default']) };
    report.dns = command('/usr/sbin/scutil', ['--dns']);
    report.plan = planFrom(report.pf);
    report.baseline = { ipv4: await tcpProbe('1.1.1.1', 4), ipv6: await tcpProbe('2606:4700:4700::1111', 6) };
    if (!report.baseline.ipv4.connected) throw new Error('NETWORK_BASELINE_UNAVAILABLE');
    report.success = true; report.stage = 'readonly-preflight-complete';
  } catch (error) { report.error = error.code || 'NETWORK_PREFLIGHT_REJECTED'; process.exitCode = 1; }
  fs.writeFileSync(path.join(root, 'HOST_NETWORK_PREFLIGHT.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report) + '\n');
}
function ownedProcesses(root) {
  const appPrefix = `${root}/installed/弦外小猫.app/Contents/`, harness = path.join(__dirname, 'macos-dmg-acceptance.cjs');
  return checked('/bin/ps', ['-axo', 'pid=,command=']).split('\n').flatMap(line => {
    const row = line.trim().match(/^(\d+)\s+(.+)$/);
    return row && (row[2].includes(appPrefix) || (row[2].includes(harness) && row[2].includes(root))) ? [{ pid: Number(row[1]), command: row[2] }] : [];
  });
}
async function cleanupOwned(root) {
  for (const row of ownedProcesses(root)) try { process.kill(row.pid, 'SIGTERM'); } catch { /* exited */ }
  await delay(1000);
  for (const row of ownedProcesses(root)) try { process.kill(row.pid, 'SIGKILL'); } catch { /* exited */ }
  await delay(250);
  if (ownedProcesses(root).length) throw new Error('NETWORK_PRODUCT_CLEANUP_FAILED');
}
function journal(root) { return JSON.parse(fs.readFileSync(path.join(root, 'HOST_NETWORK_LEASE_PRIVATE.json'))); }
async function watchdog(input) {
  const root = guardedRoot(input); hostGuard(root);
  const validate = state => {
    if (state.root !== root || state.harnessSha !== process.env.GITHUB_SHA || !Number.isSafeInteger(state.ownerPid) || state.ownerPid <= 0 || !Number.isFinite(state.deadline) || state.deadline - Date.now() > 20 * 60000 || !['pf-anchor', 'uplinks-offline'].includes(state.method) || state.anchor !== `com.apple/000-wordtaker-${process.env.GITHUB_RUN_ID}-${state.ownerPid}` || !Array.isArray(state.interfaces) || !state.interfaces.length || state.interfaces.some(name => !/^[a-z][a-z0-9]*$/.test(name) || /^lo\d+$/.test(name))) throw new Error('NETWORK_WATCHDOG_LEASE_INVALID');
  };
  let retained = retainLease(() => journal(root), null, validate), consecutiveReadErrors = 0, totalReadErrors = 0;
  write(root, 'HOST_NETWORK_WATCHDOG_READY.json', { pid: process.pid, ready: true });
  while (true) {
    retained = retainLease(() => journal(root), retained.state, validate);
    consecutiveReadErrors = retained.readFailed ? consecutiveReadErrors + 1 : 0;
    if (retained.readFailed) totalReadErrors++;
    const state = retained.state;
    let parentAlive = true; try { process.kill(state.ownerPid, 0); } catch { parentAlive = false; }
    if (!parentAlive || state.restoreRequested || Date.now() >= state.deadline || consecutiveReadErrors >= 10) {
      const result = { success: false, timedOut: Date.now() >= state.deadline, parentGone: !parentAlive, watchdogPid: process.pid, method: state.method, leaseReadErrors: totalReadErrors, persistentLeaseReadFailure: consecutiveReadErrors >= 10, cleanupFailures: [] };
      try {
        await restoreWithCleanup({
          cleanup: async () => { await cleanupOwned(root); result.productProcessesAbsentBeforeRestore = true; },
          restore: () => {
            if (state.mutationIntent) {
              if (state.method === 'pf-anchor') checked('/usr/bin/sudo', ['-n', '/sbin/pfctl', '-a', state.anchor, '-f', '-'], { input: '' });
              else for (const name of state.interfaces) checked('/usr/bin/sudo', ['-n', '/sbin/ifconfig', name, 'up']);
            }
          },
          failure: failure => { result.cleanupFailures.push(failure); write(root, 'HOST_NETWORK_WATCHDOG_PROGRESS.json', result); },
          wait: () => delay(500),
        });
        result.success = true;
      } catch (error) { result.error = error.message; }
      write(root, 'HOST_NETWORK_RESTORED.json', result);
      return;
    }
    await delay(500);
  }
}
async function dnsProbe() {
  const resolver = new Resolver({ timeout: 1200, tries: 1 }); resolver.setServers(['1.1.1.1']);
  try { const values = await resolver.resolve4('example.com'); return { reachable: values.length > 0 }; }
  catch (error) { return { reachable: false, code: error.code }; }
}
async function loopbackProbe(family) {
  const server = net.createServer(socket => socket.end('ok')), host = family === 4 ? '127.0.0.1' : '::1';
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  try { return await new Promise(resolve => {
    const client = net.connect({ host, port: server.address().port, family });
    client.once('data', data => { client.destroy(); resolve(data.toString() === 'ok'); });
    client.once('error', () => { client.destroy(); resolve(false); });
    client.setTimeout(2000, () => { client.destroy(); resolve(false); });
  }); } finally { await new Promise(resolve => server.close(resolve)); }
}
async function heldTlsProbe() {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '1.1.1.1', port: 443, servername: 'one.one.one.one' });
    socket.once('secureConnect', () => { socket.setTimeout(0); resolve(socket); });
    socket.once('error', () => { socket.destroy(); reject(new Error('NETWORK_EXISTING_CONNECTION_BASELINE_FAILED')); });
    socket.setTimeout(4000, () => { socket.destroy(); reject(new Error('NETWORK_EXISTING_CONNECTION_BASELINE_FAILED')); });
  });
}
async function existingConnectionBlocked(socket) {
  if (socket.destroyed) throw new Error('NETWORK_EXISTING_CONNECTION_NOT_AVAILABLE');
  return new Promise(resolve => {
    const finish = blocked => { socket.destroy(); resolve(blocked); };
    socket.once('data', () => finish(false)); socket.once('error', () => finish(true)); socket.once('close', () => finish(true));
    socket.setTimeout(2500, () => finish(true));
    socket.write('HEAD / HTTP/1.1\r\nHost: one.one.one.one\r\nConnection: close\r\n\r\n');
  });
}
async function accept(input) {
  const root = guardedRoot(input), host = hostGuard(root), report = { success: false, host, stage: 'baseline', maximumIsolationMinutes: 20, originalPFConfigurationOverwritten: false, electronSandboxDisabled: false };
  const before = snapshot(); write(root, 'HOST_NETWORK_BEFORE.json', before);
  let state, held, application;
  try {
    await withHostIsolation({
      preflight: async () => {
        if (Object.values(before).some(value => value.status !== 0)) throw new Error('NETWORK_INITIAL_CONFIGURATION_READ_FAILED');
        report.baseline = { ipv4: await tcpProbe('1.1.1.1', 4), ipv6: await tcpProbe('2606:4700:4700::1111', 6), dns: await dnsProbe() };
        if (!report.baseline.ipv4.connected) throw new Error('NETWORK_BASELINE_UNAVAILABLE');
        held = await heldTlsProbe();
        const fresh = snapshot(), plan = planFrom(fresh);
        state = { ...plan, root, harnessSha: process.env.GITHUB_SHA, ownerPid: process.pid, deadline: Date.now() + 20 * 60000, anchor: `com.apple/000-wordtaker-${process.env.GITHUB_RUN_ID}-${process.pid}`, mutationIntent: false, active: false, blockedProbesVerified: false, watchdogReady: false, restoreRequested: false };
        report.plan = plan; write(root, 'HOST_NETWORK_LEASE_PRIVATE.json', state);
      },
      watchdog: async () => {
        const output = fs.openSync(path.join(root, 'network-watchdog.log'), 'wx', 0o600);
        let child; try { child = spawn(process.execPath, [__filename, '--watchdog', root], { detached: true, stdio: ['ignore', output, output] }); } finally { fs.closeSync(output); }
        child.unref();
        const deadline = Date.now() + 7000;
        while (!fs.existsSync(path.join(root, 'HOST_NETWORK_WATCHDOG_READY.json')) && Date.now() < deadline) await delay(100);
        const ready = JSON.parse(fs.readFileSync(path.join(root, 'HOST_NETWORK_WATCHDOG_READY.json')));
        if (ready.pid !== child.pid || !ready.ready) throw new Error('NETWORK_WATCHDOG_NOT_READY');
        state.watchdogReady = true; state.watchdogPid = child.pid; write(root, 'HOST_NETWORK_LEASE_PRIVATE.json', state);
      },
      configure: async () => {
        report.stage = 'configure-owned-isolation';
        if (state.method === 'pf-anchor') {
          const rules = `pass quick on lo0 all no state\nblock return out quick on ! lo0 all label "wordtaker-${process.env.GITHUB_RUN_ID}"\n`;
          await prepareOwnedAnchor({
            exists: () => checked('/usr/bin/sudo', ['-n', '/sbin/pfctl', '-a', state.anchor, '-sr']).trim().length > 0,
            validate: () => checked('/usr/bin/sudo', ['-n', '/sbin/pfctl', '-n', '-a', state.anchor, '-f', '-'], { input: rules }),
            markIntent: () => { state.mutationIntent = true; write(root, 'HOST_NETWORK_LEASE_PRIVATE.json', state); },
            install: () => checked('/usr/bin/sudo', ['-n', '/sbin/pfctl', '-a', state.anchor, '-f', '-'], { input: rules }),
          });
        } else {
          state.mutationIntent = true; write(root, 'HOST_NETWORK_LEASE_PRIVATE.json', state);
          for (const name of state.interfaces) checked('/usr/bin/sudo', ['-n', '/sbin/ifconfig', name, 'down']);
        }
        state.active = true; write(root, 'HOST_NETWORK_LEASE_PRIVATE.json', state);
      },
      verifyBlocked: async () => {
        report.stage = 'prove-external-denial';
        if (state.method === 'uplinks-offline' && parseInterfaces(checked('/sbin/ifconfig', ['-a'])).some(item => item.up && !item.loopback)) throw new Error('NETWORK_UPLINK_REMAINED_ACTIVE');
        report.blocked = { existingConnection: await existingConnectionBlocked(held), ipv4: await tcpProbe('1.1.1.1', 4), ipv6: await tcpProbe('2606:4700:4700::1111', 6), dns: await dnsProbe(), loopback4: await loopbackProbe(4), loopback6: await loopbackProbe(6) };
        held = undefined;
        if (report.blocked.ipv4.connected || report.blocked.ipv6.connected || report.blocked.dns.reachable || !report.blocked.existingConnection || !report.blocked.loopback4 || !report.blocked.loopback6) throw new Error('NETWORK_DENIAL_NOT_PROVEN');
        if (state.method === 'pf-anchor') report.pfOwnedRules = pf(['-a', state.anchor, '-vvsr']);
        state.blockedProbesVerified = true; write(root, 'HOST_NETWORK_LEASE_PRIVATE.json', state); report.externalDenialVerified = true;
      },
      runProduct: async () => {
        report.stage = 'real-product-entry';
        application = spawn(process.execPath, [path.join(__dirname, 'macos-dmg-acceptance.cjs'), root], { stdio: 'inherit' });
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; application.kill('SIGTERM'); }, Math.max(1000, state.deadline - Date.now() - 60000));
        const monitor = setInterval(() => {
          const interfaces = state.method === 'uplinks-offline' ? command('/sbin/ifconfig', ['-a']) : null;
          const failed = interfaces ? interfaces.status !== 0 || parseInterfaces(interfaces.stdout).some(item => item.up && !item.loopback) : !pf(['-a', state.anchor, '-sr']).stdout.includes(`wordtaker-${process.env.GITHUB_RUN_ID}`) || !/^Status: Enabled/m.test(pf(['-s', 'info']).stdout);
          if (failed) { timedOut = true; application.kill('SIGTERM'); }
        }, 500);
        try { report.applicationExit = await new Promise(resolve => { application.once('error', () => resolve({ error: 'APPLICATION_HARNESS_START_FAILED' })); application.once('exit', (code, signal) => resolve({ code, signal })); }); }
        finally { clearTimeout(timeout); clearInterval(monitor); }
        if (timedOut || report.applicationExit.code !== 0 || report.applicationExit.signal) throw new Error('NETWORK_PRODUCT_ACCEPTANCE_FAILED');
      },
      cleanupProduct: async () => { await cleanupOwned(root); report.productProcessesAbsentBeforeRestore = true; },
      restore: async () => {
        state.restoreRequested = true; write(root, 'HOST_NETWORK_LEASE_PRIVATE.json', state);
        const deadline = Date.now() + 30000;
        while (!fs.existsSync(path.join(root, 'HOST_NETWORK_RESTORED.json')) && Date.now() < deadline) await delay(200);
        const restored = JSON.parse(fs.readFileSync(path.join(root, 'HOST_NETWORK_RESTORED.json')));
        if (!restored.success) throw new Error('NETWORK_RESTORE_FAILED'); report.watchdogRestoration = restored;
      },
      verifyRestored: async () => {
        const after = snapshot(); write(root, 'HOST_NETWORK_AFTER.json', after);
        if (after.rules.stdout !== before.rules.stdout || after.allRules.stdout !== before.allRules.stdout || /^Status: Enabled/m.test(after.info.stdout) !== /^Status: Enabled/m.test(before.info.stdout)) throw new Error('NETWORK_PF_NOT_RESTORED');
        const original = parseInterfaces(before.interfaces.stdout), current = parseInterfaces(after.interfaces.stdout);
        if (original.some(item => current.find(now => now.name === item.name)?.up !== item.up)) throw new Error('NETWORK_INTERFACES_NOT_RESTORED');
        const deadline = Date.now() + 20000;
        do { report.restoredIPv4 = await tcpProbe('1.1.1.1', 4); if (report.restoredIPv4.connected) break; await delay(1000); } while (Date.now() < deadline);
        if (!report.restoredIPv4.connected) throw new Error('NETWORK_CONNECTIVITY_NOT_RESTORED');
        report.networkAndOriginalRulesRestored = true;
      },
    });
    report.success = true; report.stage = 'complete';
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally {
    if (held) held.destroy();
    if (state?.watchdogReady && state.mutationIntent && !fs.existsSync(path.join(root, 'HOST_NETWORK_RESTORED.json'))) {
      state.restoreRequested = true; write(root, 'HOST_NETWORK_LEASE_PRIVATE.json', state);
      const deadline = Date.now() + 30000;
      while (!fs.existsSync(path.join(root, 'HOST_NETWORK_RESTORED.json')) && Date.now() < deadline) await delay(200);
      report.finallyWatchdogRestoreObserved = fs.existsSync(path.join(root, 'HOST_NETWORK_RESTORED.json'));
    }
    write(root, 'HOST_NETWORK_RESULT.json', report); process.stdout.write(JSON.stringify(report) + '\n');
  }
}
module.exports = { tcpProbe, write };
if (require.main === module) {
  const action = process.argv[2] === '--watchdog' ? watchdog : process.argv[2] === '--accept' ? accept : preflight;
  action(process.argv[3]).catch(() => { process.stderr.write('NETWORK_GUARDED_OPERATION_FAILED\n'); process.exitCode = 1; });
}
