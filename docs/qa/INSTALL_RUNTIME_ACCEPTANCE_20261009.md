# Internal candidate installation/runtime acceptance

Scope: macOS arm64 >=14 and native Windows x64. This does not publish a Release,
upload an unsigned installer, or extend support to other platform/device targets.
Application version remains 1.29.5; product runtime source is unchanged.

## Windows x64

`node scripts/windows-install-acceptance.cjs` runs only when Windows x64,
`GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted`, and an absolute
`RUNNER_TEMP` are present. Existing product installations/processes cause refusal.

The x64 CI step installs the real NSIS setup with CRC retained and an explicit
temporary directory; checks uninstall registration and installed executable,
app.asar, Python and four model hashes against the build output; starts the
installed executable through its normal product entry; reads the real React UI
and production IPC over loopback CDP; requires the embedded worker to become
ready; closes the real settings and recorder windows through existing IPC; checks
zero exit and absence of its tracked process tree; and executes the real NSIS
uninstaller, requiring payload and registry removal. A screenshot hash and JSON
receipt appear in runner logs; binaries/screenshots are not uploaded.

User data, the legacy WordTaker database profile and temp audio paths are
redirected to a unique disposable runner directory. A temporary exact-program
outbound firewall block prevents background model downloads/production requests;
Windows Firewall is never disabled. No microphones, synthetic global keys,
accounts, SMS, paid orders or signing keys are used.

Build success alone does not satisfy this acceptance. Final same-SHA CI results
must be collected in the local phase receipt before declaring installation green.

## macOS packaged UI integration

`node scripts/verify-packaged-ui.cjs /absolute/path/to/app.asar` runs an isolated
Electron host, the actual packaged settings renderer/preload/WindowManager and
production IPC/SQLite/backend-client/token-store code. It checks exactly two roles,
VibeCoding persistence, fixture login, encrypted fixture disk storage, restoration
in new module contexts, logout, local payment QR, pending state, rejection of a
different paid order, current-order paid state, cancellation stopping polling,
login gating, runtime-derived title and renderer Node isolation.

Only `.invalid` fixture responses are permitted; Chromium rejects external
resources and permissions. The fixture encryption is AES-GCM in the test harness,
NOT macOS Keychain/safeStorage validation, real SMS/payment, or a full application
restart. The host runtime version and candidate package version are reported
separately. No production security logic is modified or bypassed in a product build.

The normal macOS product entry cannot be launched under this task's restrictions:
`startApp()` unconditionally registers global triggers and calls
`askForMediaAccess('microphone')`, applies login-item settings, and starts background
work. `EnvironmentManager` also uses the OS home directory for its legacy database;
`--user-data-dir` alone is not sufficient isolation. Do not force-launch it on the
user's machine or add a product test backdoor. Full normal startup and OS permissions
remain device acceptance work; the macOS 14 minimum has not been exercised on a
macOS 14 device. Trusted signing/notarization remain separate prerequisites.

## Evidence separation

The previous `dist/qa/torch-security-r1` receipt and package are immutable.
This phase uses `dist/qa/install-runtime-r1`. Product source/renderer bytes must
match the preserved package and final candidate commit; test/CI-only changes do
not turn the old package into a newly built/signed product. Final CI/package
equivalence, logs, hashes and outstanding boundaries belong in the phase receipt.
