# WordTaker — Windows Build Status

Last updated: 2026-06-19
Environment of record: macOS arm64 (no Wine). A final `.exe` that *runs on Windows*
**cannot be produced on this Mac**; it must be built on a `windows-latest` runner
(GitHub Actions) or a real Windows machine. See "What still needs Windows" below.

---

## What was changed and why

All changes are additive and platform-guarded. The macOS build is unaffected.

### 1. `src/helpers/funasrManager.js` — cross-platform embedded Python paths
The embedded CPython layout differs by OS:
- macOS/Linux (`python-build-standalone` install_only): `python/bin/python3.11`,
  stdlib + `lib/python3.11/site-packages`, native libs in `python/lib`.
- Windows (`python-build-standalone` install_only): `python/python.exe`,
  `python/Lib/site-packages`, native DLLs resolved from the `python/` root on `PATH`.

Previously `getEmbeddedPythonPath()` was hardcoded to `python/bin/python3.11` and the
site-packages path to `lib/python3.11/site-packages`, so on Windows the app would never
find its embedded Python and FunASR would fail to start.

Added helpers `getEmbeddedPythonDir()`, `getEmbeddedPythonPath()`,
`getEmbeddedSitePackages()` and updated `setupIsolatedEnvironment()` /
`buildPythonEnvironment()` to branch on `process.platform`. On Windows we prepend the
`python/` root (and `Scripts`) to `PATH` for native DLL resolution instead of setting
`LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH`.

### 2. `scripts/prepare-embedded-python.js` — fetch Windows CPython, install to Windows layout
- New `buildRuntimeFilename()` selects the correct `python-build-standalone` asset per
  target platform. Windows uses
  `cpython-3.11.6+20231002-x86_64-pc-windows-msvc-shared-install_only.tar.gz`
  (Windows install_only ships **x86_64 only** — no arm64).
- New helpers `pythonExecPath()`, `sitePackagesPath()`, `pythonEnv()` centralize the
  per-OS paths and the pip env (Windows gets `PATH`-based DLL resolution; Unix gets
  `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH`).
- `pip install --target` site-packages dir is created up front (Windows may not have it).
- Optional `--platform=win32|darwin|linux` flag to override the target (mainly for
  inspection; cross-OS dependency prep is not generally meaningful because of native wheels).

### 3. `scripts/test-embedded-python.js` — cross-platform exe + site-packages paths
Same path fix so `npm run test:python` works on Windows.

### 4. `package.json` — Windows electron-builder config
- `win.target`: `nsis` (installer) + `portable`, both `x64` only (matches the
  x64-only embedded Python).
- Added `nsis` block (non-one-click, user can choose install dir, desktop + start-menu
  shortcuts) and `portable` block.
- Added `models/**/*` to both `files` and `asarUnpack`. `funasr_server.py` loads the
  SenseVoice ONNX model from `<dir of funasr_server.py>/models/sensevoice`, i.e.
  `app.asar.unpacked/models/sensevoice` in production. This was previously **not bundled
  on any platform** (`models/` is gitignored and was absent from `files`); now it is
  unpacked next to the script. This benefits macOS too — additive, no regression.
- Added `uiohook-napi` to `asarUnpack`. It loads a prebuilt `.node` from disk; native
  modules are more reliable unpacked. Required for the bare-modifier hotkey trigger.

### 5. `.github/workflows/build-windows.yml` — CI to produce a real `.exe`
Runs on `windows-latest`: checkout → pnpm + Node 20 → Python 3.11 → `pnpm install`
(postinstall rebuilds native deps for Electron) → `prepare:python:embedded` (downloads
Windows CPython + deps) → `test:python` (verify) → `build:renderer` →
`electron-builder --win --publish never` → upload `dist/*.exe` as an artifact.

> Note: the task brief specified `npm ci`. This repo has **only** `pnpm-lock.yaml`
> (no `package-lock.json`) and the existing `ci.yml` uses pnpm, so the workflow uses the
> pnpm equivalent (`pnpm install --no-frozen-lockfile`). Using `npm ci` would fail.

### Platform branches audited (already correct, no change needed)
- `main.js`: Windows PATH setup + Windows default trigger (double-tap Left Alt) already present.
- `src/helpers/clipboard.js`: `pasteWindows` / `_pressPaste` use PowerShell SendKeys
  `^v`; the cached/throttled serial paste chain (`_pasteChain`) and clipboard
  restore-verify logic are platform-agnostic and apply on Windows too. The expensive
  per-paste accessibility check is macOS-only (correctly skipped elsewhere).
- `src/helpers/triggerManager.js`: `uiohook-napi` keycodes map Left/Right Alt/Ctrl;
  Windows defaults are sensible (double Left Alt to record, Left Ctrl for raw-stop).
- `src/helpers/environment.js`: data dir uses `%APPDATA%\WordTaker` on win32 (correct).
- `src/helpers/ipcHandlers.js`: all `osascript`/accessibility paths are guarded by
  `process.platform === "darwin"`; non-mac returns graceful "not supported".
- `funasr_server.py`: model-dir resolution uses `os.path` + `expanduser`, cross-platform.
- Temp audio: `os.tmpdir()` + `path.join` + UUID name; orphan cleanup in `main.js` is
  cross-platform.

---

## Build status (verified on this Mac)

| Step | Command | Result |
|------|---------|--------|
| Renderer build | `npm run build:renderer` | PASS (Vite built in ~1.6s) |
| Unit tests | `npm test` | PASS (8/8) |
| Syntax check | `node -c` on edited JS | PASS |
| Windows pack (dir) | `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win --dir --x64` | **Exit 0** — produced `dist/win-unpacked/WordTaker.exe` |

Observations from the `--dir` dry run on Mac:
- It produced a structurally correct Windows app tree, **including correct Windows-x64
  native binaries**:
  - `better_sqlite3.node` → `PE32+ DLL x86-64, for MS Windows` (electron-builder fetched
    the win32-x64 prebuilt; the `cannot find prebuild-install` line is a benign fallback
    that then succeeded via prebuilt download).
  - `uiohook-napi/prebuilds/win32-x64/uiohook-napi.node` → correct Windows x64 binary.
- `models/sensevoice/*` is correctly unpacked under `app.asar.unpacked/models/sensevoice`.
- `python/` is **absent** locally (expected — `prepare:python:embedded` was not run; on CI
  it downloads the Windows embedded CPython into `python/` before packaging).

This `--dir` output is **for config validation only**. It is NOT a runnable Windows app
because it has no embedded Python. Do not ship it.

---

## How to build a real `.exe`

### Via GitHub Actions (recommended — only reliable path from a Mac)
1. Push this repo to GitHub (the user must authorize this; it was intentionally NOT done).
2. Trigger the **Build Windows** workflow (Actions tab → "Build Windows" → Run workflow),
   or push a `v*` tag.
3. Download the `wordtaker-windows` artifact. It contains:
   - `WordTaker-<version>-x64-setup.exe` (NSIS installer)
   - `WordTaker-<version>-portable.exe` (portable)

### On a real Windows machine (x64, with MSVC Build Tools + Node 20 + pnpm + Python 3.11)
```powershell
pnpm install --no-frozen-lockfile
pnpm run prepare:python:embedded   # downloads Windows CPython + torch/funasr/etc.
pnpm run build:renderer
pnpm exec electron-builder --win --publish never
# Output in dist\*.exe
```
Or the one-shot script already wired in package.json:
```powershell
pnpm run build:win   # = prebuild:win (python + renderer) then electron-builder --win
```

---

## What still needs a real Windows machine / CI

1. **Embedded Python**: `prepare:python:embedded` downloads ~hundreds of MB
   (CPython + torch + funasr) and runs pip on the host. It must run on Windows to get the
   Windows wheels. Cannot be validated on this Mac.
2. **End-to-end runtime smoke test**: launch the `.exe`, confirm FunASR Python subprocess
   spawns and loads SenseVoice, double-Left-Alt starts recording, transcription pastes via
   PowerShell SendKeys. Requires Windows.
3. **Final installer artifacts** (`nsis` + `portable`): only produced by `--win` (not
   `--dir`) on a Windows runner.

## Risks / things to watch on first Windows run
- **Embedded Python DLL resolution**: torch/numpy `.pyd` files need MSVC runtime DLLs.
  `python-build-standalone` "shared" build bundles them; we also prepend `python/` to
  `PATH`. If imports fail at runtime, verify the `*-windows-msvc-shared-install_only`
  asset extracted with the expected `python.exe` + `Lib/site-packages` layout.
- **SmartScreen / unsigned binary**: no code-signing cert in CI
  (`CSC_IDENTITY_AUTO_DISCOVERY=false`). The installer will trigger SmartScreen warnings
  until signed.
- **SendKeys focus timing**: PowerShell `SendKeys ^v` pastes into the *currently focused*
  window. The serial paste chain mitigates overlap, but very fast streaming on slow
  machines may want a small settle delay tuned for Windows (currently shared timing).
- **arm64 Windows**: not targeted (embedded Python is x64-only). x64 app runs on arm64
  Windows via emulation but is not first-class.

## Constraints honored
- Relay config untouched (`src/helpers/relayConfig.js`); DeepSeek key stays server-side;
  nothing hardcoded.
- No push to GitHub. Workflow file created only.
- macOS build path unchanged.
