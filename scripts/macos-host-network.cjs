// Read-only disposable-VM preflight. Never run system probes before host/ref guards.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawnSync, execFileSync } = require('node:child_process');
const { assertHost, assertScopedPath } = require('./macos-dmg-guard.cjs');
const { assertTransportContext } = require('./macos-signed-dmg.cjs');
const { chooseIsolation } = require('./macos-host-isolation.cjs');
function command(exe, args) { const value = spawnSync(exe, args, { encoding: 'utf8', timeout: 15000 }); return { status: value.status, stdout: value.stdout || '', stderr: value.stderr || '' }; }
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
  assertTransportContext(process.env, '408254714', '625938591');
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('NETWORK_HOST_REJECTED');
  const parent = fs.realpathSync(process.env.RUNNER_TEMP), root = assertScopedPath(fs.mkdtempSync(path.join(parent, 'wordtaker-network-')), parent);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `root=${root}\n`);
  const report = { success: false, stage: 'host-readonly-preflight', harnessSha: process.env.GITHUB_SHA, systemConfigurationWritten: false };
  try {
    const metadata = await (await fetch('https://api.github.com/repos/firendvip/WordTaker', { signal: AbortSignal.timeout(15000) })).json();
    const stats = fs.statfsSync(root), version = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
    assertHost({ platform: process.platform, arch: process.arch, version, totalMemory: os.totalmem(), freeDisk: Number(stats.bavail) * Number(stats.bsize), repositoryPublic: metadata.private === false, env: process.env });
    report.host = { version, arch: process.arch, imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion };
    report.pf = { rules: command('/usr/bin/sudo', ['-n', '/sbin/pfctl', '-sr']), allRules: command('/usr/bin/sudo', ['-n', '/sbin/pfctl', '-a', '*', '-sr']), info: command('/usr/bin/sudo', ['-n', '/sbin/pfctl', '-s', 'info']), states: command('/usr/bin/sudo', ['-n', '/sbin/pfctl', '-ss']), interfaces: command('/usr/bin/sudo', ['-n', '/sbin/pfctl', '-s', 'Interfaces', '-vv']) };
    report.interfaces = command('/sbin/ifconfig', ['-a']);
    if (report.interfaces.status !== 0) throw new Error('NETWORK_INTERFACE_READ_FAILED');
    report.routes = { ipv4: command('/sbin/route', ['-n', 'get', 'default']), ipv6: command('/sbin/route', ['-n', 'get', '-inet6', 'default']) };
    report.dns = command('/usr/sbin/scutil', ['--dns']);
    report.plan = chooseIsolation({ rootRules: report.pf.rules.stdout, states: report.pf.states.stdout, interfaces: report.interfaces.stdout });
    report.baseline = { ipv4: await tcpProbe('1.1.1.1', 4), ipv6: await tcpProbe('2606:4700:4700::1111', 6) };
    if (!report.baseline.ipv4.connected) throw new Error('NETWORK_BASELINE_UNAVAILABLE');
    report.success = true; report.stage = 'readonly-preflight-complete';
  } catch (error) { report.error = error.code || 'NETWORK_PREFLIGHT_REJECTED'; process.exitCode = 1; }
  fs.writeFileSync(path.join(root, 'HOST_NETWORK_PREFLIGHT.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report) + '\n');
}
module.exports = { tcpProbe };
if (require.main === module) preflight().catch(() => { process.stderr.write('NETWORK_PREFLIGHT_FAILED\n'); process.exitCode = 1; });
