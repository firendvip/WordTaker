// Actual frozen bundle entry, only on a disposable native macOS14 hosted runner.
// No package mutation, permission consent, TCC/Keychain reset or Gatekeeper bypass.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { PRODUCT, assertHost, assertDownloadedDmg, assertFreshHost, assertScopedPath, assertUiHealth, assertWorkerHealth, pollIpcProbe } = require('./macos-dmg-guard.cjs');
const { assertNetworkLease } = require('./macos-host-isolation.cjs');
const { assertFirstUseReadiness, assertPreparedReadiness, waitForWorkerReadiness } = require('./macos-readiness-policy.cjs');
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
  const scenario = process.env.WORDTAKER_MODEL_SCENARIO || 'unprepared';
  assert.ok(['unprepared', 'prepared'].includes(scenario));
  const prepared = scenario === 'prepared';
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
  if (prepared) {
    const priorRoot = assertScopedPath(fs.realpathSync(process.env.WORDTAKER_SCENARIO_A_ROOT), fs.realpathSync(process.env.RUNNER_TEMP));
    const prior = JSON.parse(fs.readFileSync(path.join(priorRoot, 'MAC_RUNTIME_ACCEPTANCE.json')));
    assert.equal(prior.success, true); assert.equal(prior.firstUseReadinessPassed, true); assert.equal(prior.cleanExit, true);
    assert.deepEqual(existing, []); assert.deepEqual(productPids(), []);
    assert.equal(fs.existsSync(legacy), true, 'Only the prior test-owned profile may be reused');
    const preparation = JSON.parse(fs.readFileSync(path.join(root, 'MODEL_PREPARATION.json')));
    assert.equal(preparation.success, true); assert.equal(preparation.verifiedFiles, 14);
    assert.equal(preparation.verifiedBytes, 1186817247);
  } else {
    assertFreshHost({ installations: existing, pids: productPids(), legacyDataExists: fs.existsSync(legacy) });
  }
  const mount = assertScopedPath(path.join(root, 'mounted'), root), install = assertScopedPath(path.join(root, 'installed'), root);
  assert.ok(!fs.existsSync(mount) && !fs.existsSync(install));
  const report = { success: false, harnessSha: process.env.GITHUB_SHA, candidateSourceSha: PRODUCT.candidateSha, originalMacBuildSha: PRODUCT.originalMacBuildSha,
    version: PRODUCT.version, actualHost: transport.host, draftId: transport.draftId, assetId: transport.assetId,
    scope: prepared ? 'Prepared-cache worker and two sequential real engine inferences' : 'Fresh-install missing-model UI, bounded import processes and normal lifecycle', scenario,
    installation: false, productionEntry: false, realSettingsUi: false, database: false, pythonWorkerReady: false, cleanExit: false, installationDirectoryRemoved: false,
    fullModelReadyAcceptance: false, modelPreparationPerformed: prepared, safetySettingsSeeded: true,
    realMicrophoneTested: false, accessibilityGranted: false, keychainCredentialPersistenceTested: false, actualMacOS14Point0DeviceTested: false,
    permissionsAutomaticallyGranted: false, tccOrKeychainReset: false, gatekeeperDisabled: false, quarantineRemoved: false,
    networkRestrictions: { scope: 'Disposable hosted VM', method: lease.method, externalDenialVerifiedBeforeEntry: lease.blockedProbesVerified, independentWatchdog: lease.watchdogReady },
    safeExistingSettings: { launch_at_login: false, recording_trigger: { type: 'accelerator', accelerator: 'F8' }, translate_trigger: { type: 'none' }, polish_engine: 'cloud' },
    productPackageModified: false, stage: 'mount-readonly', quarantineBefore: quarantine(dmg) };
  let mounted = false, child, exited, connection, recorderConnection, metricsTimer, descendants = [], app, cleanExit = false;
  report.processObservations = [];
  const saveReport = () => fs.writeFileSync(path.join(root, 'MAC_RUNTIME_ACCEPTANCE.json'), JSON.stringify(report, null, 2) + '\n');
  const observeProcesses = () => {
    const rows = command('/bin/ps', ['-axo', 'pid=,ppid=,rss=,etime=,command=']).split('\n').flatMap(line => {
      const row = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d:-]+)\s+(.+)$/);
      return row && app && row[5].includes(`${app}/Contents/`) ? [{ pid: Number(row[1]), parent: Number(row[2]), rssKiB: Number(row[3]), elapsed: row[4], command: row[5].slice(0, 600) }] : [];
    });
    report.processObservations.push({ time: new Date().toISOString(), freeMemory: os.freemem(), pendingImportProcessCount: rows.filter(row => /\s-c\s+import funasr/.test(row.command)).length, productProcesses: rows });
  };
  const domExpression = rootId => `(()=>({hasRoot:Boolean(document.querySelector(${JSON.stringify(rootId)})?.children.length),hasPreload:Boolean(window.electronAPI),isolated:typeof require==='undefined'&&typeof process==='undefined',bodyText:document.body.innerText,buttons:[...document.querySelectorAll('button,[role="button"]')].map(x=>({text:x.innerText,aria:x.getAttribute('aria-label'),title:x.getAttribute('title'),disabled:x.disabled,visible:x.getBoundingClientRect().width>0&&x.getBoundingClientRect().height>0})),titles:[...document.querySelectorAll('[title]')].map(x=>x.getAttribute('title'))}))()`;
  const capture = async (client, filename) => {
    const screenshot = await client.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(root, filename), Buffer.from(screenshot.data, 'base64'));
    return hash(path.join(root, filename));
  };
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
    report.initialModelCache = { legacyDamo: fs.existsSync(path.join(os.homedir(), '.cache/modelscope/hub/damo')), userDataDamo: fs.existsSync(path.join(root, 'electron-data/models/damo')), bundledSenseVoice: fs.existsSync(path.join(app, 'Contents/Resources/app.asar.unpacked/models/sensevoice/model_quant.onnx')) };
    // Fresh disposable VM only: seed real settings schema, not a fake backend/model.
    fs.mkdirSync(legacy, { recursive: true });
    const database = path.join(legacy, 'transcriptions.db');
    const sql = 'CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);' + Object.entries(report.safeExistingSettings).map(([key, setting]) => `INSERT INTO settings(key,value) VALUES('${key}','${JSON.stringify(setting).replaceAll("'", "''")}');`).join('');
    if (!prepared) command('/usr/bin/sqlite3', [database, sql]);
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
    if (prepared) {
      const page = await waitFor(async () => (await pages()).find(item => item.url.includes('index.html') && !item.url.includes('panel=control')), 'prepared recorder renderer', 90000);
      const opener = await cdp(page.webSocketDebuggerUrl);
      try { await opener.evaluate('window.electronAPI.openSettingsWindow()'); } finally { opener.close(); }
    }
    const settings = await waitFor(async () => (await pages()).find(page => page.type === 'page' && page.url.includes('settings.html')), 'real first-run settings', 90000);
    report.productionEntry = true;
    const actualUserData = fs.readFileSync(path.join(root, 'startup.log'), 'utf8').match(/ELECTRON_USER_DATA:\s*'([^']+)'/);
    assert.ok(actualUserData, 'Missing actual app.getPath(userData) startup evidence');
    assert.equal(actualUserData[1], userData);
    report.actualUserDataPath = actualUserData[1];
    observeProcesses();
    metricsTimer = setInterval(() => { try { observeProcesses(); } catch { report.processObservationError = true; } }, 5000);
    connection = await cdp(settings.webSocketDebuggerUrl);
    report.stage = 'independent-real-settings-ui';
    const ui = await waitFor(async () => { const value = await connection.evaluate(domExpression('#settings-root')); return value.hasRoot && value.hasPreload && value.bodyText.trim() ? value : null; }, 'real settings DOM and preload', 60000);
    report.initialSettingsDom = ui; saveReport();
    report.screenshotSha256 = await capture(connection, 'settings.png'); saveReport();
    const version = await pollIpcProbe(connection.evaluate, 'version', 'getAppVersion');
    report.versionProbe = version; saveReport();
    assert.equal(version.status, 'fulfilled'); ui.version = version.value;
    const auth = await pollIpcProbe(connection.evaluate, 'auth', 'getAuthState');
    report.authProbe = auth; saveReport();
    assert.equal(auth.status, 'fulfilled'); assert.equal(auth.value.success, true); ui.loggedIn = auth.value.loggedIn;
    assertUiHealth(ui);
    const login = await pollIpcProbe(connection.evaluate, 'login-setting', 'getSetting', ['launch_at_login']);
    const onboarding = await pollIpcProbe(connection.evaluate, 'onboarding-setting', 'getSetting', ['onboarding_completed']);
    assert.equal(login.status, 'fulfilled'); assert.equal(login.value, false);
    assert.equal(onboarding.status, 'fulfilled'); assert.equal(onboarding.value, true);
    assert.equal(command('/usr/bin/sqlite3', [database, 'PRAGMA integrity_check;']), 'ok');
    assert.equal(command('/usr/bin/sqlite3', [database, 'SELECT count(*) FROM transcriptions;']), '0');
    report.database = true;
    report.realSettingsUi = true;
    report.observedUi = { version: ui.version, isolated: ui.isolated, hasPreload: ui.hasPreload, bodyTextLength: ui.bodyText.length, loggedIn: ui.loggedIn };
    saveReport();
    assert.deepEqual(connection.errors, []);
    const recorder = (await pages()).find(page => page.url.includes('index.html') && !page.url.includes('panel=control'));
    assert.ok(recorder, 'Missing real recorder renderer');
    recorderConnection = await cdp(recorder.webSocketDebuggerUrl);
    if (!prepared) await recorderConnection.evaluate('window.electronAPI.showWindow()');
    report.initialRecorderDom = await recorderConnection.evaluate(domExpression('#root'));
    report.initialRecorderScreenshotSha256 = await capture(recorderConnection, 'recorder-before-model.png'); saveReport();
    report.stage = 'independent-model-diagnostic';
    report.modelFilesProbe = await pollIpcProbe(connection.evaluate, 'model-files', 'checkModelFiles'); saveReport();
    if (prepared) {
      report.workerReadiness = await waitForWorkerReadiness(async (index, remaining) => {
        report.workerProbe = await pollIpcProbe(connection.evaluate, `worker-startup-${index}`, 'checkFunASRStatus', [], { timeout: remaining, interval: 1000 });
        saveReport(); return report.workerProbe;
      }, { timeout: 120000, interval: 5000 });
      assert.equal(report.workerReadiness.ready, true, 'Worker did not become ready within the bounded startup window');
    } else {
      report.workerProbe = await pollIpcProbe(connection.evaluate, 'worker', 'checkFunASRStatus', [], { timeout: 120000, interval: 1000 });
    }
    if (report.workerProbe.status === 'fulfilled' && report.workerProbe.value.server_ready === true && report.workerProbe.value.models_initialized === true) {
      assertWorkerHealth(report.workerProbe.value); report.pythonWorkerReady = true;
    }
    if (!prepared) {
      // A normal user wait remains a download prompt beyond the old 60-second timeout.
      await delay(65000);
    } else {
      assert.equal(report.pythonWorkerReady, true);
      const audio = Buffer.alloc(64044);
      audio.write('RIFF', 0); audio.writeUInt32LE(64036, 4); audio.write('WAVEfmt ', 8);
      audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
      audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
      audio.write('data', 36); audio.writeUInt32LE(64000, 40);
      for (let i = 0; i < 32000; i++) audio.writeInt16LE(Math.round(1000 * Math.sin(2 * Math.PI * 440 * i / 16000)), 44 + i * 2);
      report.engineInferences = [];
      for (const engine of ['sensevoice', 'paraformer']) {
        const probe = await pollIpcProbe(connection.evaluate, `engine-${engine}`, 'transcribeAudio', [audio.toString('base64'), { engine }], { timeout: 120000, interval: 500 });
        assert.equal(probe.status, 'fulfilled');
        report.engineInferences.push(probe.value); saveReport();
      }
      assertPreparedReadiness({ worker: report.workerProbe.value, engines: report.engineInferences, modelsVerified: true });
    }
    report.afterModelRecorderDom = await recorderConnection.evaluate(domExpression('#root'));
    report.afterModelRecorderScreenshotSha256 = await capture(recorderConnection, 'recorder-after-model.png');
    report.afterModelSettingsDom = await connection.evaluate(domExpression('#settings-root'));
    report.afterModelSettingsScreenshotSha256 = await capture(connection, 'settings-after-model.png');
    report.downloadUiObserved = { explicitNeedDownload: /需要下载|请先下载/.test(report.afterModelRecorderDom.bodyText + report.afterModelSettingsDom.bodyText), modelTooltipMentionsDownload: /需要下载|请先下载/.test([...report.afterModelRecorderDom.titles, ...report.afterModelSettingsDom.titles].join(' ')), enabledDownloadControls: [...report.afterModelRecorderDom.buttons, ...report.afterModelSettingsDom.buttons].filter(button => button.visible && !button.disabled && /下载/.test([button.text, button.aria, button.title].join(' '))) };
    observeProcesses(); saveReport();
    assert.ok(report.processObservations.every(sample => sample.pendingImportProcessCount <= 1), 'Installation probes accumulated');
    if (!prepared) {
      assertFirstUseReadiness({ models: report.modelFilesProbe, controls: report.afterModelRecorderDom.buttons, samples: report.processObservations,
        cacheAbsent: !report.initialModelCache.legacyDamo && !report.initialModelCache.userDataDamo });
      assert.ok(!fs.existsSync(path.join(userData, 'models/damo')), 'Scenario A unexpectedly acquired models');
      report.firstUseReadinessPassed = true;
    }
    fs.writeFileSync(path.join(root, 'MAC_MODEL_DIAGNOSTIC.json'), JSON.stringify({ scenario, initialCache: report.initialModelCache, models: report.modelFilesProbe, worker: report.workerProbe, downloadUi: report.downloadUiObserved, engineInferences: report.engineInferences || [], processObservations: report.processObservations, modelPreparationPerformed: prepared, preparedModelAcceptanceAttempted: prepared }, null, 2) + '\n');
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
    report.fullModelReadyAcceptance = prepared && report.pythonWorkerReady && report.realSettingsUi && report.cleanExit && report.database;
    report.success = true;
  } catch (error) { report.error = String(error.message); process.exitCode = 1; }
  finally {
    if (metricsTimer) clearInterval(metricsTimer);
    if (recorderConnection) recorderConnection.close();
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
