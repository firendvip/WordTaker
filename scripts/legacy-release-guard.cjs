// One explicit, reviewed legacy-no-certificate route. Default candidate CI never exports packages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const VERSION = '1.29.5';
const BASELINE = '1f6e85fedb1dc669a828905ca0bacf0a287b61f3';
const INSTALLER = `KittyEcho-${VERSION}-x64-setup.exe`;
const ALLOWED_CHANGES = new Set([
  '.github/workflows/build-windows.yml', 'scripts/legacy-release-guard.cjs',
  'tests/legacyReleaseGuard.test.js', 'tests/installAcceptance.test.js',
  'tests/windowsSqliteBinaries.test.cjs', 'docs/MACOS_BUILD.md', 'docs/WINDOWS_BUILD.md',
  // Explicitly approved legacy-session bridge; all other runtime/dependencies remain frozen.
  'src/helpers/backendClient.js', 'src/helpers/ipcHandlers.js',
  'src/components/account/AccountPanel.jsx', 'tests/authSessionPersistence.test.js',
  'tests/legacyReauthLifecycle.test.jsx',
  // Reviewed first-use readiness fix; engine dependencies, package metadata and other runtime stay frozen.
  'src/helpers/funasrManager.js', 'src/hooks/useModelStatus.js',
  'src/components/RecorderPill.jsx', 'src/index.css',
  'tests/funasrInstallationSingleflight.test.js', 'tests/modelFirstUse.test.jsx',
  // Explicitly approved sealed-bundle cache repair; no dependency or metadata changes.
  'tests/funasrPythonSecurity.test.js',
]);

function validateRequest(request) {
  assert.equal(typeof request.enabled, 'boolean', 'Export choice must be explicit');
  if (!request.enabled) return false;
  assert.equal(request.repository, 'firendvip/WordTaker');
  assert.equal(request.eventName, 'workflow_dispatch', 'Push/PR/tag events cannot export');
  assert.ok(['refs/heads/codex/wordtaker-release-candidate', `refs/tags/v${VERSION}`].includes(request.ref));
  assert.match(request.expectedSha, /^[a-f0-9]{40}$/);
  assert.equal(request.sourceSha, request.expectedSha);
  assert.equal(request.gitSha, request.expectedSha);
  assert.equal(request.version, VERSION);
  assert.equal(request.approvedVersion, VERSION);
  assert.equal(request.acknowledgment, `I_ACCEPT_UNSIGNED_${VERSION}`);
  assert.equal(request.arch, 'x64');
  return true;
}

function validateExport(request, ci, acceptance, artifact) {
  assert.equal(validateRequest(request), true, 'Verify-only runs cannot export');
  assert.ok(Number.isSafeInteger(ci.id) && ci.id > 0);
  assert.equal(ci.head_sha, request.expectedSha);
  assert.equal(ci.path, '.github/workflows/ci.yml');
  assert.equal(ci.status, 'completed');
  assert.equal(ci.conclusion, 'success');
  assert.deepEqual(ci.jobs.map(job => job.name).sort(), ['js', 'python']);
  assert.ok(ci.jobs.every(job => job.conclusion === 'success'));
  assert.equal(acceptance.sourceCommit, request.expectedSha);
  assert.equal(acceptance.version, VERSION);
  assert.equal(acceptance.arch, 'x64');
  for (const key of ['success', 'installation', 'productionEntry', 'runtime', 'cleanExit', 'uninstall']) assert.equal(acceptance[key], true, key);
  assert.equal(acceptance.trustedSignatureTested, false);
  assert.equal(artifact.name, INSTALLER);
  assert.ok(Number.isSafeInteger(artifact.size) && artifact.size > 0);
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  assert.equal(artifact.sha256, acceptance.installerSha256);
  assert.equal(artifact.signatureStatus, 'NotSigned', 'Do not invent a signing claim');
  return { allowed: true, unsigned: true };
}

function run(command = (exe, args) => execFileSync(exe, args, { encoding: 'utf8' }).trim()) {
  const request = {
    enabled: process.env.LEGACY_EXPORT === 'true', repository: process.env.GITHUB_REPOSITORY,
    eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
    sourceSha: process.env.GITHUB_SHA, gitSha: command('git', ['rev-parse', 'HEAD']),
    expectedSha: process.env.EXPECTED_SOURCE_SHA, version: require('../package.json').version,
    approvedVersion: process.env.APPROVED_VERSION, acknowledgment: process.env.UNSIGNED_ACKNOWLEDGMENT,
    arch: process.env.BUILD_ARCH,
  };
  const allowed = validateRequest(request);
  if (allowed) {
    assert.equal(command('git', ['status', '--porcelain']), '', 'Release checkout is dirty');
    const changed = command('git', ['diff', '--name-only', BASELINE, 'HEAD']).split('\n').filter(Boolean);
    assert.ok(changed.every(file => ALLOWED_CHANGES.has(file)), 'Frozen runtime/dependencies changed');
  }
  if (process.argv[2] === '--request') {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `allowed=${allowed}\n`);
    return;
  }
  assert.equal(process.argv[2], '--validate');
  assert.equal(allowed, true);
  assert.match(process.env.ORDINARY_CI_RUN_ID || '', /^[1-9][0-9]*$/);
  const endpoint = `repos/firendvip/WordTaker/actions/runs/${process.env.ORDINARY_CI_RUN_ID}`;
  const ci = JSON.parse(command('gh', ['api', endpoint]));
  ci.jobs = JSON.parse(command('gh', ['api', `${endpoint}/jobs`, '--paginate'])).jobs;
  const acceptance = JSON.parse(fs.readFileSync('dist/install-runtime-x64.json'));
  const file = path.resolve('dist', INSTALLER);
  const artifact = {
    name: INSTALLER, size: fs.statSync(file).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    signatureStatus: command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${file.replaceAll("'", "''")}').Status.ToString()`]),
  };
  validateExport(request, ci, acceptance, artifact);
  const output = path.resolve('legacy-export');
  assert.equal(fs.existsSync(output), false, 'Refusing to overwrite a prior export');
  fs.mkdirSync(output);
  fs.copyFileSync(file, path.join(output, INSTALLER));
  fs.writeFileSync(path.join(output, 'SHA256SUMS-x64.txt'), `${artifact.sha256}  ${INSTALLER}\n`);
  fs.writeFileSync(path.join(output, 'RELEASE_RECEIPT.json'), JSON.stringify({
    sourceCommit: request.expectedSha, version: VERSION, arch: 'x64', minimumMacOS: '14.0',
    route: 'explicit-reviewed-legacy-no-certificate', authenticode: false,
    artifact, ordinaryCiRunId: ci.id, windowsCiRunId: process.env.GITHUB_RUN_ID,
    installRuntime: acceptance, publicReleaseCreated: false,
    warning: 'Windows package is not Authenticode signed; Windows security/reputation warnings remain. Do not disable SmartScreen.',
  }, null, 2) + '\n');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, 'allowed=true\n');
}

module.exports = { validateRequest, validateExport, run };
if (require.main === module) {
  try { run(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
