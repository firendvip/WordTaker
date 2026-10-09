// Actual frozen bundle entry, only on a disposable native macOS14 hosted runner.
// No package mutation, permission consent, TCC/Keychain reset or Gatekeeper bypass.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { PRODUCT, assertHost, assertDownloadedDmg, assertFreshHost, assertScopedPath, assertUiHealth } = require('./macos-dmg-guard.cjs');
const { assertNetworkLease } = require('./macos-host-isolation.cjs');
const command = (exe, args, options = {}) => execFileSync(exe, args, { encoding: 'utf8', timeout: 30000, ...options }).trim();
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(250); }
  throw new Error(`Timed out: ${label}`);
}
function processes() {
  return command('/bin/ps', ['-axo', 'pid=,ppid=,command=']).split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match && { pid: Number(match[1]), parent: Number(match[2]), command: match[3] };
  }).filter(Boolean);
}
function productPids() { return processes().filter(row => /\/Contents\/MacOS\/(?:弦外小猫|KittyEcho|WordTaker)(?:\s|$)/.test(row.command)).map(row => row.pid); }
function tree(rootPid) {
  const rows = processes(), ids = new Set([rootPid]);
  let changed;
  do { changed = false; for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; } } while (changed);
  return [...ids];
}
function quarantine(file) {
  const result = spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file], { encoding: 'utf8' });
  return { present: result.status === 0, value: result.status === 0 ? result.stdout.trim() : null };
}
async function cdp(url) {
  const socket = new WebSocket(url), pending = new Map(), errors = [];
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  socket.addEventListener('message', ({ data }) => {
    const value = JSON.parse(String(data));
    if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails.text);
    if (pending.has(value.id)) {
      const item = pending.get(value.id); clearTimeout(item.timer); pending.delete(value.id);
      if (value.error) item.reject(new Error(value.error.message)); else item.resolve(value.result);
    }
  });
  socket.addEventListener('close', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP closed')); } pending.clear(); });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  await call('Runtime.enable');
  return { call, errors, close: () => socket.close(), evaluate: async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.text);
    return result.result.value;
  } };
}
async function run() {
  const root = assertScopedPath(fs.realpathSync(assertScopedPath(process.argv[2], fs.realpathSync(process.env.RUNNER_TEMP))), fs.realpathSync(process.env.RUNNER_TEMP));
  const transport = JSON.parse(fs.readFileSync(path.join(root, 'TRANSPORT_RESULT.json')));
  assert.equal(transport.success, true);
  assertHost({ platform: process.platform, arch: process.arch, version: command('/usr/bin/sw_vers', ['-productVersion']), totalMemory: os.totalmem(), freeDisk: Number(fs.statfsSync(root).bavail) * Number(fs.statfsSync(root).bsize), repositoryPublic: true, env: process.env });
  const networkLease = () => {
    const lease = JSON.parse(fs.readFileSync(path.join(root, 'HOST_NETWORK_LEASE_PRIVATE.json')));
    assertNetworkLease(lease, root, process.env.GITHUB_SHA);
    process.kill(lease.watchdogPid, 0);
    return lease;
  };
  const lease = networkLease();
  const dmg = assertScopedPath(path.join(root, PRODUCT.dmgName), root);
  assertDownloadedDmg(fs.statSync(dmg).size, hash(dmg));
  const legacy = path.join(os.homedir(), 'Library/Application Support/WordTaker');
  const existing = ['/Applications', path.join(os.homedir(), 'Applications')].flatMap(dir => ['弦外小猫.app', 'KittyEcho.app', 'WordTaker.app'].map(name => path.join(dir, name))).filter(file => fs.existsSync(file));
  assertFreshHost({ installations: existing, pids: productPids(), legacyDataExists: fs.existsSync(legacy) });
  const mount = assertScopedPath(path.join(root, 'mounted'), root), install = assertScopedPath(path.join(root, 'installed'), root);
  assert.ok(!fs.existsSync(mount) && !fs.existsSync(install));
  const report = { success: false, harnessSha: process.env.GITHUB_SHA, candidateSourceSha: PRODUCT.candidateSha, originalMacBuildSha: PRODUCT.originalMacBuildSha,
    version: PRODUCT.version, actualHost: transport.host, draftId: transport.draftId, assetId: transport.assetId,
    installation: false, productionEntry: false, realSettingsUi: false, database: false, pythonWorkerReady: false, cleanExit: false, installationDirectoryRemoved: false,
    realMicrophoneTested: false, accessibilityGranted: false, keychainCredentialPersistenceTested: false, actualMacOS14Point0DeviceTested: false,
    permissionsAutomaticallyGranted: false, tccOrKeychainReset: false, gatekeeperDisabled: false, quarantineRemoved: false,
    networkRestrictions: { scope: 'Disposable hosted VM', method: lease.method, externalDenialVerifiedBeforeEntry: lease.blockedProbesVerified, independentWatchdog: lease.watchdogReady },
    safeExistingSettings: { launch_at_login: false, recording_trigger: { type: 'accelerator', accelerator: 'F8' }, translate_trigger: { type: 'none' }, polish_engine: 'cloud' },
    productPackageModified: false, stage: 'mount-readonly', quarantineBefore: quarantine(dmg) };
  let mounted = false, child, exited, connection, descendants = [], app, cleanExit = false;
  try {
    fs.mkdirSync(mount);
    report.mountPlist = command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, '-plist', dmg]);
    mounted = true;
    const bundles = fs.readdirSync(mount).filter(name => name.endsWith('.app'));
    assert.deepEqual(bundles, ['弦外小猫.app']);
    assert.ok(fs.lstatSync(path.join(mount, bundles[0])).isDirectory());
    fs.mkdirSync(install);
    app = assertScopedPath(path.join(install, bundles[0]), install);
    command('/usr/bin/ditto', [path.join(mount, bundles[0]), app], { timeout: 180000 });
    const plist = path.join(app, 'Contents/Info.plist');
    const value = key => command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]);
    assert.equal(value('CFBundleShortVersionString'), PRODUCT.version);
    assert.equal(value('CFBundleIdentifier'), 'com.kittyecho.app');
    assert.equal(value('LSMinimumSystemVersion'), '14.0');
    const exe = assertScopedPath(path.join(app, 'Contents/MacOS', value('CFBundleExecutable')), app);
    const asar = path.join(app, 'Contents/Resources/app.asar');
    assert.equal(hash(asar), PRODUCT.asarSha256);
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { timeout: 180000 });
    report.installedHashes = { executable: hash(exe), asar: hash(asar) };
    report.installation = true;
    report.installedQuarantine = quarantine(app);
    // Fresh disposable VM only: seed real settings schema, not a fake backend/model.
    fs.mkdirSync(legacy, { recursive: true });
    const database = path.join(legacy, 'transcriptions.db');
    const sql = 'CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);' + Object.entries(report.safeExistingSettings).map(([key, setting]) => `INSERT INTO settings(key,value) VALUES('${key}','${JSON.stringify(setting).replaceAll("'", "''")}');`).join('');
    command('/usr/bin/sqlite3', [database, sql]);
    const env = { ...process.env, NODE_ENV: 'production' };
    for (const key of Object.keys(env)) if (/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i.test(key) || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
    // The separate VM controller proves external denial; keep Chromium's own sandbox unchanged.
    networkLease();
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const userData = assertScopedPath(path.join(root, 'electron-data'), root);
    report.stage = 'actual-bundle-main-entry';
    const output = fs.openSync(path.join(root, 'startup.log'), 'wx');
    try {
      child = spawn(exe, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { cwd: root, env, stdio: ['ignore', output, output] });
    } finally { fs.closeSync(output); }
    let launchError;
    exited = new Promise(resolve => { child.once('error', error => { launchError = error; resolve({ error: error.message }); }); child.once('exit', (code, signal) => resolve({ code, signal })); });
    const pages = async () => {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Actual product entry exited early (${child.exitCode}/${child.signalCode}); no OS bypass attempted`);
      try { return await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json(); } catch { return []; }
    };
    const settings = await waitFor(async () => (await pages()).find(page => page.type === 'page' && page.url.includes('settings.html')), 'real first-run settings', 90000);
    report.productionEntry = true;
    connection = await cdp(settings.webSocketDebuggerUrl);
    const ui = await waitFor(async () => connection.evaluate(`(async()=>{ const api=window.electronAPI; if(!api||!document.querySelector('#settings-root')?.children.length) return null; const ready=await api.checkFunASRStatus(); if(!ready.server_ready||!ready.models_initialized) return null; return {version:await api.getAppVersion(),isolated:typeof require==='undefined'&&typeof process==='undefined',hasRoot:true,bodyText:document.body.innerText,loggedIn:(await api.getAuthState()).loggedIn,...ready}; })()`), 'real UI and bundled Python readiness', 240000);
    assertUiHealth(ui);
    assert.equal(await connection.evaluate('window.electronAPI.getSetting("launch_at_login")'), false);
    assert.equal(await connection.evaluate('window.electronAPI.getSetting("onboarding_completed")'), true);
    assert.equal(command('/usr/bin/sqlite3', [database, 'PRAGMA integrity_check;']), 'ok');
    assert.equal(command('/usr/bin/sqlite3', [database, 'SELECT count(*) FROM transcriptions;']), '0');
    report.database = true;
    report.realSettingsUi = true;
    report.pythonWorkerReady = true;
    report.observedUi = { version: ui.version, isolated: ui.isolated, bodyTextLength: ui.bodyText.length, loggedIn: ui.loggedIn, worker: { server_ready: ui.server_ready, models_initialized: ui.models_initialized } };
    const screenshot = await connection.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(root, 'settings.png'), Buffer.from(screenshot.data, 'base64'));
    report.screenshotSha256 = hash(path.join(root, 'settings.png'));
    assert.deepEqual(connection.errors, []);
    assert.ok((await pages()).some(page => page.url.includes('index.html')), 'Missing real recorder renderer');
    descendants = tree(child.pid);
    report.processTreeBeforeExit = descendants;
    report.stage = 'normal-browser-lifecycle-quit';
    try { await connection.call('Browser.close'); } catch (error) { if (!/CDP closed/.test(error.message)) throw error; }
    const exit = await waitFor(async () => child.exitCode !== null || child.signalCode !== null, 'normal exit', 30000).then(() => exited);
    assert.deepEqual(exit, { code: 0, signal: null });
    await waitFor(() => !processes().some(row => descendants.includes(row.pid) || row.command.includes(`${app}/Contents/`)), 'all tracked bundle/Python processes exited');
    cleanExit = true;
    report.cleanExit = true;
    assert.equal(hash(asar), report.installedHashes.asar);
    assert.equal(hash(exe), report.installedHashes.executable);
    assertDownloadedDmg(fs.statSync(dmg).size, hash(dmg));
    assert.deepEqual(quarantine(dmg), report.quarantineBefore);
    const trust = spawnSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { encoding: 'utf8', timeout: 30000 });
    report.trustedGatekeeperAssessment = { status: trust.status, output: String(trust.stderr).trim(), trusted: trust.status === 0 };
    report.stage = 'remove-exact-temp-installation';
    assertScopedPath(install, root);
    assert.ok(fs.lstatSync(install).isDirectory() && !fs.lstatSync(install).isSymbolicLink());
    fs.rmSync(install, { recursive: true });
    assert.ok(!fs.existsSync(install));
    report.installationDirectoryRemoved = true;
    report.stage = 'complete';
    report.success = true;
  } catch (error) { report.error = String(error.message); process.exitCode = 1; }
  finally {
    if (connection) connection.close();
    // Failure cleanup is scoped to owned PIDs/installation only; never claim a forced exit passed.
    if (child && !cleanExit && child.exitCode === null && child.signalCode === null) {
      const owned = () => processes().filter(row => row.command.includes(`${app}/Contents/`) || (row.pid === child.pid && child.exitCode === null && child.signalCode === null)).map(row => row.pid).filter(pid => pid !== process.pid);
      for (const pid of owned().reverse()) try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
      await delay(1000);
      for (const pid of owned()) try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      report.forcedFailureCleanup = true;
    }
    if (mounted) { try { command('/usr/bin/hdiutil', ['detach', mount]); report.readonlyMountDetached = true; } catch (error) { report.detachError = error.message; report.success = false; process.exitCode = 1; } }
    // Retain failed installation diagnostics inside the disposable VM; never delete its home/profile/TCC.
    fs.writeFileSync(path.join(root, 'MAC_RUNTIME_ACCEPTANCE.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report) + '\n');
  }
}
module.exports = { run };
if (require.main === module) run().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
