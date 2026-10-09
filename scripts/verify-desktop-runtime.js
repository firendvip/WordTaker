// 独立验收 Electron/原生 ABI/preload/WebAudio；不加载主应用、不读用户库、不申请麦克风权限。
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    env, stdio: 'inherit', timeout: 30000, windowsHide: true,
  });
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  if (result.signal) process.stderr.write(`Electron smoke terminated: ${result.signal}\n`);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain } = require('electron');
const { createRequire } = require('node:module');
const projectRoot = path.resolve(__dirname, '..');
const appRoot = process.argv[2] ? path.resolve(process.argv[2]) : projectRoot;
const appRequire = createRequire(path.join(appRoot, 'package.json'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wordtaker-runtime-smoke-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
const deadline = setTimeout(() => app.exit(1), 25000);

app.whenReady().then(async () => {
  if (process.platform === 'darwin') await app.dock.hide();
  assert.equal(process.versions.electron, require('../package.json').devDependencies.electron);
  const Database = appRequire('better-sqlite3');
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE transcript (raw_text TEXT, processed_text TEXT)');
    db.prepare('INSERT INTO transcript VALUES (?, ?)').run('原文', '处理后');
    assert.deepEqual(db.prepare('SELECT * FROM transcript').get(), {
      raw_text: '原文', processed_text: '处理后',
    });
  } finally {
    db.close();
  }
  // 只验证原生模块能加载；不启动全局键盘监听，不触发辅助功能请求。
  const { uIOhook } = appRequire('uiohook-napi');
  assert.equal(typeof uIOhook.start, 'function');
  assert.equal(typeof uIOhook.stop, 'function');

  ipcMain.handle('get-app-version', () => require('../package.json').version);
  ipcMain.handle('get-auth-state', () => ({ success: true, loggedIn: false, account: null }));
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(appRoot, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      partition: 'wordtaker-runtime-smoke',
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadURL('data:text/html,<html><head><meta http-equiv="Content-Security-Policy" content="default-src %27none%27"></head><body>Runtime smoke</body></html>');
  const renderer = await win.webContents.executeJavaScript(`(async () => {
    const api = window.electronAPI;
    const audio = new OfflineAudioContext(1, 1600, 16000);
    const oscillator = audio.createOscillator();
    oscillator.connect(audio.destination);
    oscillator.start();
    const buffer = await audio.startRendering();
    const samples = buffer.getChannelData(0);
    return {
      version: await api.getAppVersion(),
      loggedIn: (await api.getAuthState()).loggedIn,
      phoneLogin: typeof api.authSmsSend === 'function' && typeof api.authSmsLogin === 'function',
      otherLogin: Object.keys(api).some(key => /email|wechat/i.test(key)),
      recorderBridge: typeof api.setRecorderState === 'function' && typeof api.onCancelRecording === 'function',
      isolated: typeof require === 'undefined' && typeof process === 'undefined',
      audioSamples: samples.length,
      audioActive: samples.some(value => Math.abs(value) > 0.1),
    };
  })()`);
  assert.deepEqual(renderer, {
    version: require('../package.json').version, loggedIn: false,
    phoneLogin: true, otherLogin: false, recorderBridge: true, isolated: true,
    audioSamples: 1600, audioActive: true,
  });
  await win.webContents.executeJavaScript(`
    window.cancelResult = new Promise(resolve => window.electronAPI.onCancelRecording(() => resolve(true)));
    true;
  `);
  win.webContents.send('cancel-recording');
  assert.equal(await win.webContents.executeJavaScript('window.cancelResult'), true);
  win.destroy();
  clearTimeout(deadline);
  process.stdout.write(`${JSON.stringify({
    success: true, electron: process.versions.electron, abi: process.versions.modules,
    sqlite: 'pass', uiohookLoad: 'pass', preload: 'pass', webAudio: 'pass', cancelIpc: 'pass',
    packaged: appRoot !== projectRoot,
    userDataIsolated: true, realMicrophoneTested: false, globalHotkeysTested: false,
  })}\n`);
  app.exit(0);
}).catch((error) => {
  clearTimeout(deadline);
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
