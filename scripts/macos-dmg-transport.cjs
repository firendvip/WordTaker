// Same-repository, contents-read-only draft transport. Never log credentials or signed URLs.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { PRODUCT, assertHost, assertDraftAsset, assertDownloadedDmg, assertScopedPath } = require('./macos-dmg-guard.cjs');
async function run() {
  const runnerTemp = fs.realpathSync(process.env.RUNNER_TEMP);
  const root = assertScopedPath(fs.mkdtempSync(path.join(runnerTemp, 'wordtaker-macos14-')), runnerTemp);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `root=${root}\n`);
  const report = { success: false, harnessSha: process.env.GITHUB_SHA, candidateSourceSha: PRODUCT.candidateSha, originalMacBuildSha: PRODUCT.originalMacBuildSha, contentsPermission: 'read', stage: 'host-preflight' };
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GH_TOKEN}`, 'X-GitHub-Api-Version': '2026-03-10' };
  const api = async endpoint => {
    const response = await fetch(`https://api.github.com/repos/firendvip/WordTaker/${endpoint}`, { headers, signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, `Read-only GitHub API ${report.stage}: HTTP ${response.status}`);
    return response.json();
  };
  try {
    const repository = await api('');
    const stats = fs.statfsSync(root);
    const host = { platform: process.platform, arch: process.arch, version: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(), totalMemory: os.totalmem(), freeDisk: Number(stats.bavail) * Number(stats.bsize), repositoryPublic: repository.private === false, env: process.env };
    report.host = { version: host.version, kernel: os.release(), arch: host.arch, totalMemory: host.totalMemory, freeMemory: os.freemem(), freeDisk: host.freeDisk, imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion, runnerEnvironment: process.env.RUNNER_ENVIRONMENT, uname: execFileSync('/usr/bin/uname', ['-a'], { encoding: 'utf8' }).trim() };
    assertHost(host);
    assert.match(process.argv[2] || '', /^[1-9]\d*$/);
    assert.match(process.argv[3] || '', /^[1-9]\d*$/);
    report.stage = 'read-draft';
    const release = await api(`releases/${process.argv[2]}`);
    const asset = release.assets.find(asset => String(asset.id) === process.argv[3]);
    assert.ok(asset, 'Exact DMG asset ID not in the selected draft');
    assertDraftAsset(release, asset);
    report.draftId = release.id;
    report.assetId = asset.id;
    report.stage = 'download-private-draft-asset';
    let response = await fetch(`https://api.github.com/repos/firendvip/WordTaker/releases/assets/${asset.id}`, { headers: { ...headers, Accept: 'application/octet-stream' }, redirect: 'manual', signal: AbortSignal.timeout(300000) });
    if (response.status === 302) {
      const redirect = new URL(response.headers.get('location'));
      assert.equal(redirect.protocol, 'https:');
      assert.equal(redirect.hostname, 'release-assets.githubusercontent.com');
      // Credentials deliberately do not follow the signed download redirect.
      response = await fetch(redirect, { signal: AbortSignal.timeout(300000) });
    }
    assert.equal(response.status, 200, `Read-only draft asset: HTTP ${response.status}`);
    const file = assertScopedPath(path.join(root, PRODUCT.dmgName), root);
    const descriptor = fs.openSync(file, 'wx');
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
      for await (const bytes of response.body) {
        size += bytes.length;
        assert.ok(size <= PRODUCT.dmgSize, 'Downloaded asset exceeds exact approved size');
        hash.update(bytes);
        let offset = 0;
        while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      }
    } finally { fs.closeSync(descriptor); }
    const digest = hash.digest('hex');
    assertDownloadedDmg(size, digest);
    const again = await api(`releases/${release.id}`);
    assertDraftAsset(again, again.assets.find(item => item.id === asset.id));
    report.stage = 'download-verified';
    report.artifact = { name: PRODUCT.dmgName, size, sha256: digest };
    report.success = true;
  } catch (error) {
    report.error = String(error.message);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(root, 'TRANSPORT_RESULT.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report) + '\n');
  }
}
if (require.main === module) run().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
