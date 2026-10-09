// Packaged renderer + original production IPC/DB/session logic in an isolated host.
// NOT a normal product-entry/OS secure-storage test: no main.js, mic, hooks or real backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { createOfflineFixture } = require('./desktop-ui-fixtures.cjs');

if (!process.versions.electron) {
  const env = { ...process.env, NODE_ENV: 'production' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'pipe', encoding: 'utf8', timeout: 90000, windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  const receipt = result.stdout?.split('\n').find(line => line.startsWith('{"success":true,'));
  process.exit(result.status === 0 && receipt ? 0 : 1);
}

const electron = require('electron');
const { app, BrowserWindow, ipcMain, session } = electron;
const appRoot = path.resolve(process.argv[2] || '');
assert.ok(process.argv[2] && appRoot.endsWith('app.asar') && fs.existsSync(appRoot), 'Supply an actual candidate app.asar');
const appRequire = createRequire(path.join(appRoot, 'package.json'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wordtaker-packaged-ui-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
// Keep the test host alive while windows are deliberately destroyed/reopened.
app.on('window-all-closed', () => {});
const fixture = createOfflineFixture();
const handled = new Set();
const crashes = [];
const rendererErrors = [];
const blockedNetwork = [];
const fingerprints = {};
let phase = 'setup';
const deadline = setTimeout(() => app.exit(1), 80000);
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function packagedModules() {
  const cache = new Map();
  const fakeElectron = {
    ...electron,
    safeStorage: fixture.safeStorage,
    ipcMain: {
      handle(channel, handler) { handled.add(channel); ipcMain.handle(channel, handler); },
      on: ipcMain.on.bind(ipcMain),
    },
  };
  function load(file) {
    file = path.resolve(file);
    assert.ok(file.startsWith(`${appRoot}${path.sep}`), 'Module escaped app.asar');
    if (!path.extname(file)) {
      if (fs.existsSync(`${file}.js`)) file += '.js';
      else if (fs.existsSync(`${file}.cjs`)) file += '.cjs';
      else file += '.json';
    }
    if (cache.has(file)) return cache.get(file).exports;
    const source = fs.readFileSync(file, 'utf8');
    fingerprints[path.relative(appRoot, file)] = crypto.createHash('sha256').update(source).digest('hex');
    const module = { exports: {} };
    cache.set(file, module);
    if (file.endsWith('.json')) { module.exports = JSON.parse(source); return module.exports; }
    const localRequire = name => {
      if (name === 'electron') return fakeElectron;
      if (name === './backendConfig') return { AI_BACKEND_URL: 'https://fixture.invalid', API_PREFIX: '/api/v1', CLIENT_PLATFORM: 'mac', BACKEND_REQUEST_TIMEOUT_MS: 1000 };
      if (name === './deviceIdentity') return { getDeviceId: () => 'offline-qa-device-only' };
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name));
      return appRequire(name);
    };
    const context = { Buffer, Date, URL, AbortController, module, exports: module.exports, require: localRequire, __filename: file, __dirname: path.dirname(file), process, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: fixture.fetch };
    vm.runInNewContext(source, context, { filename: file });
    return module.exports;
  }
  return load;
}

let db;
let manager;
let load;
function setup() {
  for (const channel of handled) ipcMain.removeHandler(channel);
  handled.clear();
  load = packagedModules();
  const DatabaseManager = load(path.join(appRoot, 'src/helpers/database.js'));
  db = new DatabaseManager(logger);
  db.initialize(userData);
  const WindowManager = load(path.join(appRoot, 'src/helpers/windowManager.js'));
  manager = new WindowManager(logger);
  manager.setDatabaseManager(db);
  const IPCHandlers = load(path.join(appRoot, 'src/helpers/ipcHandlers.js'));
  new IPCHandlers({ databaseManager: db, windowManager: manager, logger, environmentManager: {}, clipboardManager: {}, hotkeyManager: {}, funasrManager: {}, llmManager: { getModelsStatus: () => ({}) } });
}

async function open(tab) {
  phase = `open-${tab}`;
  const win = await manager.createSettingsWindow(tab);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('render-process-gone', (_event, detail) => { if (!['clean-exit', 'killed'].includes(detail.reason)) crashes.push(detail.reason); });
  win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
  await wait(win, `document.querySelector('#settings-root')?.children.length > 0 && !document.body.innerText.includes('加载中')`);
  return win;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(win, expression, timeout = 15000) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) {
    const result = await win.webContents.executeJavaScript(expression);
    if (result) return result;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}
async function click(win, label) {
  phase = `click-${label}`;
  await wait(win, `[...document.querySelectorAll('button')].some(node => node.textContent.trim() === ${JSON.stringify(label)} && !node.disabled)`);
  return win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(label)});
    if (!button || button.disabled) throw new Error('Missing/enabled button: ' + ${JSON.stringify(label)});
    button.click(); return true;
  })()`);
}
const textHas = (win, text) => wait(win, `document.body.innerText.includes(${JSON.stringify(text)})`);

app.whenReady().then(async () => {
  if (process.platform === 'darwin') await app.dock.hide();
  // Both Chromium and VM backend paths fail closed. Never grant media permissions.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = /^(file|data|blob):/.test(details.url);
    if (!allowed) blockedNetwork.push(new URL(details.url).protocol);
    callback({ cancel: !allowed });
  });
  setup();
  let win = await open('role');
  await textHas(win, 'VibeCoding专用');
  assert.deepEqual(await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].filter(node => node.querySelector('label')).map(node => node.querySelector('label').textContent)`), ['常规', 'VibeCoding专用']);
  assert.equal(await win.webContents.executeJavaScript(`document.body.innerText.includes('高情商')`), false);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node => node.querySelector('label')?.textContent === 'VibeCoding专用').click()`);
  await wait(win, `window.electronAPI.getSetting('llm_active_role').then(value => value === 'vibecoding')`);
  assert.equal(db.getSetting('llm_active_role'), 'vibecoding');
  win.destroy();
  win = await open('account');
  await textHas(win, '未登录 · 点此登录');
  assert.equal((await win.webContents.executeJavaScript('window.electronAPI.getAuthState()')).loggedIn, false);
  await click(win, '未登录 · 点此登录');
  await wait(win, `!!document.getElementById('login-phone')`);
  await win.webContents.executeJavaScript(`(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const [id, value] of [['login-phone', '13800138000'], ['login-code', '123456']]) {
      const input = document.getElementById(id); set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  })()`);
  await click(win, '登录 / 注册');
  await textHas(win, '离线验收账号');
  const state = await win.webContents.executeJavaScript('window.electronAPI.getAuthState()');
  assert.equal(state.loggedIn, true);
  assert.ok(!('accessToken' in state) && !('refreshToken' in state), 'Token exposed over IPC');
  const tokenFile = path.join(userData, 'backend-token.json');
  const stored = fs.readFileSync(tokenFile, 'utf8');
  for (const secret of ['offline-fixture-access', 'offline-fixture-refresh', '13800138000']) assert.ok(!stored.includes(secret), 'Fixture plaintext persisted');
  // Recreate production module contexts and reopen the real packaged window.
  // This tests disk restoration without touching macOS Keychain; not a full product restart.
  win.destroy();
  db.close();
  setup();
  win = await open('account');
  await textHas(win, '离线验收账号');
  assert.equal(db.getSetting('llm_active_role'), 'vibecoding');
  await textHas(win, '离线验收套餐');
  await click(win, '微信支付');
  await wait(win, `!!document.querySelector('img[alt="微信付款二维码"]')?.src.startsWith('data:image/png;base64,')`);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('iframe') !== null`), false);
  assert.equal(await win.webContents.executeJavaScript(`document.body.innerText.includes('支付成功，已到账')`), false);
  fixture.payStatus = 'paid';
  fixture.wrongOrder = true;
  await click(win, '我已完成支付 · 刷新额度');
  await textHas(win, '暂未检测到到账');
  assert.equal(await win.webContents.executeJavaScript(`document.body.innerText.includes('支付成功，已到账')`), false);
  fixture.wrongOrder = false;
  await click(win, '我已完成支付 · 刷新额度');
  await textHas(win, '支付成功，已到账');
  await wait(win, `![...document.querySelectorAll('span')].some(node => node.textContent.trim() === '微信扫码支付')`);
  fixture.payStatus = 'pending';
  await click(win, '微信支付');
  await textHas(win, '微信扫码支付');
  await click(win, '取消');
  const pollsAfterCancel = fixture.calls.filter(call => call.route === '/payment/order/17').length;
  await delay(5500);
  assert.equal(fixture.calls.filter(call => call.route === '/payment/order/17').length, pollsAfterCancel, 'Polling survived cancellation');
  await click(win, '退出');
  await textHas(win, '未登录 · 点此登录');
  assert.ok(!fs.existsSync(tokenFile), 'Logout did not remove fixture session');
  assert.equal((await win.webContents.executeJavaScript(`window.electronAPI.createOrder('qa_only', 'wechat')`)).code, 'UNAUTHORIZED');
  assert.equal(await win.webContents.executeJavaScript(`typeof require === 'undefined' && typeof process === 'undefined'`), true);
  assert.equal(await win.webContents.executeJavaScript('window.electronAPI.getAppVersion()'), app.getVersion());
  assert.ok((await win.webContents.executeJavaScript('document.title')).includes(app.getVersion()));
  assert.deepEqual(crashes, []);
  assert.deepEqual(rendererErrors, []);
  assert.deepEqual(blockedNetwork, [], 'Packaged UI attempted an external resource');
  const candidateVersion = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
  win.destroy();
  db.close();
  clearTimeout(deadline);
  process.stdout.write(`${JSON.stringify({ success: true, candidateVersion, runtimeHostVersion: app.getVersion(), electron: process.versions.electron, roles: 'two choices + persisted VibeCoding', session: 'fixture login + encrypted disk + new module context restore + logout', payment: 'local QR + pending + wrong-order refusal + paid + cancellation + login gate', productionIpc: true, actualPackagedRenderer: true, packagedModulesSha256: fingerprints, offlineRoutes: fixture.calls, osSecureStorageTested: false, normalProductEntryTested: false, realBackendTested: false, microphoneTested: false, globalHotkeysTested: false, userDataIsolated: true })}\n`);
  app.exit(0);
}).catch(error => {
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  if (db) db.close();
  clearTimeout(deadline);
  process.stderr.write(`${JSON.stringify({ phase, rendererErrors, crashes })}\n${error.stack || error}\n`);
  app.exit(1);
});
