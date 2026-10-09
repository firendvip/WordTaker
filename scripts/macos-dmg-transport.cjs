// Same-repository, contents-read-only CI plus a locally verified short-lived single-file URL.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { PRODUCT, assertHost, assertScopedPath } = require('./macos-dmg-guard.cjs');
const { assertTransportContext, validateSignedUrl, downloadSignedAsset, safeTransportError } = require('./macos-signed-dmg.cjs');
const repositoryApiUrl = endpoint => `https://api.github.com/repos/firendvip/WordTaker${endpoint ? `/${endpoint}` : ''}`;
async function run() {
  const runnerTemp = fs.realpathSync(process.env.RUNNER_TEMP);
  const root = assertScopedPath(fs.mkdtempSync(path.join(runnerTemp, 'wordtaker-macos14-')), runnerTemp);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `root=${root}\n`);
  const report = { success: false, harnessSha: process.env.GITHUB_SHA, candidateSourceSha: PRODUCT.candidateSha, originalMacBuildSha: PRODUCT.originalMacBuildSha, contentsPermission: 'read', stage: 'host-preflight', privateDraftApiRead: 'Not attempted: previous read-draft HTTP403; exact metadata verified locally before and after this run', secretName: 'WORDTAKER_MAC_DMG_ONCE_408254714' };
  let secret = process.env.WORDTAKER_DMG_URL;
  delete process.env.WORDTAKER_DMG_URL;
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GH_TOKEN}`, 'X-GitHub-Api-Version': '2026-03-10' };
  const api = async endpoint => {
    const response = await fetch(repositoryApiUrl(endpoint), { headers, signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, `Read-only GitHub API ${report.stage}: HTTP ${response.status}`);
    return response.json();
  };
  try {
    assertTransportContext(process.env, process.argv[2], process.argv[3]);
    const repository = await api('');
    const stats = fs.statfsSync(root);
    const host = { platform: process.platform, arch: process.arch, version: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(), totalMemory: os.totalmem(), freeDisk: Number(stats.bavail) * Number(stats.bsize), repositoryPublic: repository.private === false, env: process.env };
    report.host = { version: host.version, kernel: os.release(), arch: host.arch, totalMemory: host.totalMemory, freeMemory: os.freemem(), freeDisk: host.freeDisk, imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion, runnerEnvironment: process.env.RUNNER_ENVIRONMENT, uname: execFileSync('/usr/bin/uname', ['-a'], { encoding: 'utf8' }).trim() };
    assertHost(host);
    report.draftId = 408254714;
    report.assetId = PRODUCT.assetId;
    report.stage = 'validate-short-lived-private-url';
    report.signedUrlLifetime = validateSignedUrl(secret);
    report.stage = 'download-signed-single-file';
    const file = assertScopedPath(path.join(root, PRODUCT.dmgName), root);
    const descriptor = fs.openSync(file, 'wx');
    let downloaded;
    try {
      downloaded = await downloadSignedAsset(secret, bytes => {
        let offset = 0;
        while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      });
    } finally { fs.closeSync(descriptor); }
    report.stage = 'download-verified';
    report.artifact = { name: PRODUCT.dmgName, ...downloaded };
    report.success = true;
  } catch (error) {
    report.error = safeTransportError(error);
    process.exitCode = 1;
  } finally {
    secret = undefined;
    fs.writeFileSync(path.join(root, 'TRANSPORT_RESULT.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report) + '\n');
  }
}
module.exports = { repositoryApiUrl };
if (require.main === module) run().catch(error => { process.stderr.write(`${JSON.stringify(safeTransportError(error))}\n`); process.exitCode = 1; });
