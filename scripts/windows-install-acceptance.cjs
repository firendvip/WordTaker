// Real NSIS/product-entry acceptance, ONLY on an ephemeral GitHub-hosted x64 runner.
// No product switches/backdoors, production requests, signing, or artifact uploads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const SETTINGS_ROOT_SELECTOR = '#settings-root';
const PRODUCT_DISPLAY_PATTERN = '^弦外小猫(?: \\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?)?$';

function assertRunner(platform, arch, env) {
  assert.equal(platform, 'win32', 'Installer acceptance is Windows-only');
  assert.equal(arch, 'x64', 'Only native x64 installation is in scope');
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Refusing to install on a local machine');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted', 'Refusing a persistent/self-hosted runner');
  assert.ok(env.RUNNER_TEMP && path.win32.isAbsolute(env.RUNNER_TEMP), 'Missing absolute runner temp root');
}

function assertScopedPath(target, parent, paths = path) {
  const resolved = paths.resolve(target);
  const relative = paths.relative(paths.resolve(parent), resolved);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative), 'Target must be a strict child of the disposable root');
  return resolved;
}

// NSIS requires /D last and unquoted, including paths containing spaces.
function installerArgs(directory) {
  return ['/S', '/currentuser', `/D=${directory}`];
}

function registeredInstallDir(uninstallString) {
  const match = /^"([^"]+\.exe)"(?:\s.*)?$/i.exec(uninstallString || '');
  assert.ok(match, 'Malformed uninstall registration');
  return path.win32.dirname(match[1]);
}

function assertUiHealth(value, version) {
  assert.equal(value.version, version);
  assert.equal(value.isolated, true, 'Renderer has Node access');
  assert.equal(value.hasRoot, true, 'React root is empty');
  assert.ok(value.bodyText.trim(), 'Renderer has no visible content');
  assert.ok(!value.bodyText.includes('应用出现错误'), 'React error boundary is visible');
  assert.equal(value.loggedIn, false, 'Fresh test profile unexpectedly contains an account');
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}

function ps(script, env = process.env) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env, encoding: 'utf8', timeout: 30000, windowsHide: true }).trim();
}
const quoted = value => `'${String(value).replaceAll("'", "''")}'`;
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', ({ data }) => {
    const value = JSON.parse(String(data));
    if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails.text);
    if (value.id && pending.has(value.id)) {
      const { resolve, reject, timer } = pending.get(value.id);
      clearTimeout(timer);
      pending.delete(value.id);
      if (value.error) reject(new Error(value.error.message));
      else resolve(value.result);
    }
  });
  socket.addEventListener('close', () => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('CDP closed')); }
    pending.clear();
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await call('Runtime.enable');
  return {
    errors,
    call,
    async evaluate(expression) {
      const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert.ok(!result.exceptionDetails, result.exceptionDetails?.text);
      return result.result.value;
    },
    close: () => socket.close(),
  };
}

function runNsis(executable, args, env) {
  const result = spawnSync(executable, args, { env, windowsHide: true, windowsVerbatimArguments: true, timeout: 300000, stdio: 'pipe' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `NSIS failed (${result.status})`);
  assert.equal(result.signal, null);
}

async function run() {
  assertRunner(process.platform, process.arch, process.env);
  const version = require('../package.json').version;
  const installer = path.resolve(process.argv[2] || `dist/KittyEcho-${version}-x64-setup.exe`);
  const source = path.resolve('dist/win-unpacked');
  const reportPath = path.resolve(process.argv[3] || 'dist/install-runtime-x64.json');
  assert.ok(fs.existsSync(installer) && fs.existsSync(source), 'Installer/build output is missing');
  const root = assertScopedPath(fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'wordtaker-install-')), process.env.RUNNER_TEMP);
  const installDir = assertScopedPath(path.join(root, 'installed'), root);
  const userData = assertScopedPath(path.join(root, 'electron-data'), root);
  const profile = assertScopedPath(path.join(root, 'profile'), root);
  const temp = assertScopedPath(path.join(root, 'temp'), root);
  const env = { ...process.env, USERPROFILE: profile, APPDATA: path.join(profile, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(profile, 'AppData', 'Local'), TEMP: temp, TMP: temp, NODE_ENV: 'production' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  for (const directory of [profile, temp, userData, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(directory, { recursive: true });
  const exe = path.join(installDir, 'KittyEcho.exe');
  const firewall = `wordtaker-acceptance-${crypto.randomUUID()}`;
  const registration = () => JSON.parse(ps(`$items = @(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match ${quoted(PRODUCT_DISPLAY_PATTERN)} } | Select-Object PSPath,InstallLocation,UninstallString); ConvertTo-Json -InputObject $items -Compress`));
  assert.equal(registration().length, 0, 'Refusing to overwrite an existing product installation');
  assert.equal(ps("@(Get-Process KittyEcho -ErrorAction SilentlyContinue).Count"), '0', 'Unexpected pre-existing product process');
  let child;
  let cleanExit = false;
  let firewallAdded = false;
  const report = { sourceCommit: process.env.GITHUB_SHA, version, platform: os.release(), arch: 'x64', installerSha256: sha256(installer), productionEntry: true, installation: false, runtime: false, cleanExit: false, uninstall: false, productionNetworkBlocked: true, productionNetworkBlockScope: 'KittyEcho.exe outbound only; child processes are not OS-network-isolated', childProcessNetworkBlocked: false, realMicrophoneTested: false, trustedSignatureTested: false };
  try {
    runNsis(installer, installerArgs(installDir), env);
    assert.ok(fs.existsSync(exe), 'NSIS did not install the expected executable');
    const registered = registration();
    assert.equal(registered.length, 1, 'Missing/ambiguous uninstall registration');
    assert.equal(path.resolve(registeredInstallDir(registered[0].UninstallString)), installDir, 'NSIS registered outside the explicit temp directory');
    report.installedHashes = {};
    for (const relative of ['KittyEcho.exe', 'resources/app.asar', 'resources/app.asar.unpacked/python/python.exe', ...['model_quant.onnx', 'tokens.json', 'config.yaml', 'am.mvn'].map(name => `resources/app.asar.unpacked/models/sensevoice/${name}`)]) {
      const installed = path.join(installDir, relative);
      assert.equal(sha256(installed), sha256(path.join(source, relative)), `Installed payload differs: ${relative}`);
      report.installedHashes[relative] = sha256(installed);
    }
    report.installation = true;
    // Additive, exact-program restriction; never disable Windows Firewall/security.
    ps(`$ErrorActionPreference='Stop'; New-NetFirewallRule -DisplayName ${quoted(firewall)} -Direction Outbound -Program ${quoted(exe)} -Action Block -Profile Any | Out-Null`);
    firewallAdded = true;
    const port = await freePort();
    child = spawn(exe, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { env, cwd: root, windowsHide: true, stdio: 'ignore' });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    const endpoint = `http://127.0.0.1:${port}/json/list`;
    const pages = async () => { try { return await (await fetch(endpoint, { signal: AbortSignal.timeout(1000) })).json(); } catch { return []; } };
    const settings = await waitFor(async () => (await pages()).find(page => page.type === 'page' && page.url.includes('settings.html')), 'first-run settings UI', 90000);
    const ui = await connectCdp(settings.webSocketDebuggerUrl);
    const health = await waitFor(async () => ui.evaluate(`(async () => {
      const api = window.electronAPI;
      if (!api || !document.querySelector('${SETTINGS_ROOT_SELECTOR}')?.children.length) return null;
      return { version: await api.getAppVersion(), isolated: typeof require === 'undefined' && typeof process === 'undefined', hasRoot: true, bodyText: document.body.innerText, loggedIn: (await api.getAuthState()).loggedIn };
    })()`), 'rendered React settings');
    assertUiHealth(health, version);
    assert.equal(await ui.evaluate('window.electronAPI.getSetting("onboarding_completed")'), true);
    assert.ok(fs.existsSync(path.join(profile, 'AppData/Roaming/WordTaker/transcriptions.db')), 'App database escaped the isolated USERPROFILE');
    assert.ok(fs.existsSync(path.join(userData, 'logs/app.log')), 'App userData escaped the explicit CLI path');
    await ui.evaluate(`window.electronAPI.setSetting('launch_at_login', false)`);
    await ui.evaluate('window.electronAPI.reloadLaunchAtLogin()');
    const ready = await waitFor(async () => {
      const status = await ui.evaluate('window.electronAPI.checkFunASRStatus()');
      return status.server_ready && status.models_initialized && status;
    }, 'installed Python/SenseVoice worker ready', 180000);
    report.runtime = true;
    report.pythonWorkerReady = ready.server_ready;
    report.screenshotSha256 = null;
    const screenshot = await ui.call('Page.captureScreenshot', { format: 'png' });
    const screenshotFile = path.join(root, 'settings.png');
    fs.writeFileSync(screenshotFile, Buffer.from(screenshot.data, 'base64'));
    report.screenshotSha256 = sha256(screenshotFile);
    assert.deepEqual(ui.errors, [], 'Uncaught renderer errors');
    const mainPage = (await pages()).find(page => page.type === 'page' && page.url.includes('index.html'));
    assert.ok(mainPage, 'No product recorder renderer');
    const main = await connectCdp(mainPage.webSocketDebuggerUrl);
    const descendants = JSON.parse(ps(`$nodes = @(Get-CimInstance Win32_Process); $ids = @(${child.pid}); do { $next = @($nodes | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object { $_.ProcessId }); $ids += $next } while ($next.Count -gt 0); ConvertTo-Json -InputObject @($ids) -Compress`));
    report.processTreeBeforeExit = descendants;
    const safeClose = async (connection, expression) => {
      try { await connection.evaluate(expression); } catch (error) {
        // Closing the target can close CDP before the invoke response arrives.
        if (!/CDP closed/.test(error.message)) throw error;
      }
      connection.close();
    };
    await safeClose(ui, 'window.electronAPI.closeSettingsWindow()');
    await safeClose(main, 'window.electronAPI.closeWindow()');
    const exit = await Promise.race([exited, delay(30000).then(() => { throw new Error('Product did not cleanly exit through its real IPC/window-all-closed path'); })]);
    assert.deepEqual(exit, { code: 0, signal: null });
    cleanExit = true;
    report.cleanExit = true;
    await waitFor(() => ps(`@(Get-Process -Id @(${descendants.join(',')}) -ErrorAction SilentlyContinue).Count`) === '0', 'no tracked native/Python/SendKeys descendants', 30000);
    await waitFor(() => ps(`@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(${quoted(installDir)}, [StringComparison]::OrdinalIgnoreCase) }).Count`) === '0', 'no product/embedded child processes', 30000);
    const uninstallers = fs.readdirSync(installDir).filter(name => /^Uninstall.*\.exe$/i.test(name));
    assert.equal(uninstallers.length, 1, 'Ambiguous/missing NSIS uninstaller');
    const uninstaller = path.join(installDir, uninstallers[0]);
    runNsis(uninstaller, ['/S', '/currentuser', `_?=${installDir}`], env);
    assert.ok(!fs.existsSync(exe) && !fs.existsSync(path.join(installDir, 'resources')), 'Uninstaller left the installed application payload');
    assert.equal(registration().length, 0, 'Uninstaller left its registry registration');
    // _?= makes ExecWait synchronous and intentionally leaves the running uninstaller.
    if (fs.existsSync(uninstaller)) fs.unlinkSync(uninstaller);
    if (fs.existsSync(installDir)) assert.deepEqual(fs.readdirSync(installDir), [], 'Unexpected files remain after uninstall');
    report.uninstall = true;
    report.success = true;
  } finally {
    if (child && !cleanExit && child.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    if (firewallAdded) ps(`Remove-NetFirewallRule -DisplayName ${quoted(firewall)} -ErrorAction Stop`);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    // Keep failed-run diagnostics confined to the ephemeral runner; never upload packages.
  }
}

module.exports = { assertRunner, assertScopedPath, installerArgs, registeredInstallDir, assertUiHealth, SETTINGS_ROOT_SELECTOR, PRODUCT_DISPLAY_PATTERN };
if (require.main === module) run().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
