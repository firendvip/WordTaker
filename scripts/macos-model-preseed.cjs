// QA-only preparation on the approved disposable runner, between A and offline B.
// Raw immutable official bytes only; never imports a checkpoint or product worker.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { PRODUCT, assertHost, assertScopedPath, assertDownloadedDmg } = require('./macos-dmg-guard.cjs');
const { assertTransportContext } = require('./macos-signed-dmg.cjs');
const { MODEL_BYTES, assertModelBudget } = require('./macos-readiness-policy.cjs');
const MANIFEST_SHA256 = '972d65c4fe8ea08cb7a0d1d5ee841e5dbbce065a2d88bb590bff7bec745172d4';
function assertPreparationPreconditions(prior, network, productPids) {
  assert.equal(prior.success, true); assert.equal(prior.scenario, 'unprepared');
  assert.equal(prior.firstUseReadinessPassed, true); assert.equal(prior.cleanExit, true);
  assert.equal(prior.candidateSourceSha, PRODUCT.candidateSha);
  assert.equal(network.success, true); assert.equal(network.productProcessesAbsentBeforeRestore, true);
  assert.equal(network.networkAndOriginalRulesRestored, true); assert.deepEqual(productPids, []);
}
function isolatedEnvironment(source, pythonHome) {
  const env = { ...source };
  for (const key of Object.keys(env)) if (/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i.test(key) || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'WORDTAKER_ONNX_ONLY', 'PYTHONPATH', 'PYTHONUSERBASE', 'PYTHONSTARTUP', 'VIRTUAL_ENV', 'CONDA_PREFIX'].includes(key)) delete env[key];
  return { ...env, PYTHONHOME: pythonHome, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
}
function inventory(root) {
  const result = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      assert.ok(!stat.isSymbolicLink(), 'Model symlink rejected');
      if (stat.isDirectory()) walk(file); else { assert.ok(stat.isFile()); result.push(path.relative(root, file)); }
    }
  }
  assert.ok(fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink()); walk(root);
  return result.sort();
}
function hashFile(file) {
  const hash = crypto.createHash('sha256'), descriptor = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
  try { let size; while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size)); }
  finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}
function verifyModelBytes(root, manifest) {
  const expected = []; let verifiedBytes = 0;
  for (const [repository, model] of Object.entries(manifest.models)) for (const [name, pin] of Object.entries(model.files)) {
    const relative = path.join(repository, name), file = assertScopedPath(path.join(root, relative), root);
    assert.ok(!path.isAbsolute(repository) && !path.isAbsolute(name)); expected.push(relative);
    const stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.size, pin.size); assert.equal(hashFile(file), pin.sha256); verifiedBytes += stat.size;
  }
  assert.deepEqual(inventory(root), expected.sort(), 'Unexpected model resources');
  return { verifiedFiles: expected.length, verifiedBytes };
}
const DOWNLOAD_PROGRAM = String.raw`
import sys, json, urllib.request, urllib.parse
sys.path.insert(0, sys.argv[1])
from download_models import download_verified_model, HTTPSRedirectHandler
from pytorch_model_security import load_manifest
budget = 1186817247
downloaded = 0
authority = load_manifest()
pins = {(record['repository'], record['commit'], name): pin for record in authority['models'].values() for name, pin in record['files'].items()}
open_https = urllib.request.build_opener(HTTPSRedirectHandler()).open
class BoundedResponse:
    def __init__(self, response, size): self.response, self.remaining = response, size
    def __enter__(self): return self
    def __exit__(self, *_): self.response.close()
    def geturl(self): return self.response.geturl()
    def read(self, size):
        global downloaded
        if not self.remaining: return b''
        if downloaded >= budget: raise RuntimeError('MODEL_DOWNLOAD_BUDGET_EXCEEDED')
        data = self.response.read(min(size, self.remaining, budget - downloaded))
        self.remaining -= len(data)
        downloaded += len(data)
        if downloaded > budget: raise RuntimeError('MODEL_DOWNLOAD_BUDGET_EXCEEDED')
        return data
def bounded_open(request, timeout):
    parsed = urllib.parse.urlparse(request.full_url)
    if parsed.scheme != 'https' or parsed.hostname != 'www.modelscope.cn': raise RuntimeError('MODEL_SOURCE_REJECTED')
    query = urllib.parse.parse_qs(parsed.query)
    repository = parsed.path.removeprefix('/api/v1/models/').removesuffix('/repo')
    pin = pins[(repository, query['Revision'][0], query['FilePath'][0])]
    response = open_https(request, timeout=timeout)
    length = response.headers.get('Content-Length')
    if length is not None and int(length) != pin['size']:
        response.close()
        raise RuntimeError('MODEL_LENGTH_REJECTED')
    return BoundedResponse(response, pin['size'])
try:
    for repository in authority['models']:
        download_verified_model(sys.argv[2], repository, manifest=authority, opener=bounded_open)
    if downloaded != budget: raise RuntimeError('MODEL_DOWNLOAD_BUDGET_MISMATCH')
    print(json.dumps({'success': True, 'downloadedBytes': downloaded}))
except Exception:
    print(json.dumps({'success': False, 'code': 'MODEL_PREPARATION_DOWNLOAD_FAILED', 'downloadedBytes': downloaded}))
    sys.exit(1)
`;
function run() {
  assertTransportContext(process.env, '408254714', String(PRODUCT.assetId));
  const runnerTemp = fs.realpathSync(process.env.RUNNER_TEMP);
  const priorRoot = assertScopedPath(fs.realpathSync(assertScopedPath(process.argv[2], runnerTemp)), runnerTemp);
  const command = (exe, args, options = {}) => execFileSync(exe, args, { encoding: 'utf8', timeout: 30000, ...options }).trim();
  const stats = fs.statfsSync(priorRoot), freeDisk = Number(stats.bavail) * Number(stats.bsize);
  assertHost({ platform: process.platform, arch: process.arch, version: command('/usr/bin/sw_vers', ['-productVersion']), totalMemory: os.totalmem(), freeDisk, repositoryPublic: process.env.WORDTAKER_REPOSITORY_PRIVATE === 'false', env: process.env });
  const read = name => JSON.parse(fs.readFileSync(path.join(priorRoot, name)));
  const owned = command('/bin/ps', ['-axo', 'pid=,command=']).split('\n').filter(line => /(?:弦外小猫|KittyEcho|WordTaker)\.app\/Contents\//.test(line) || line.includes(`${priorRoot}/installed/`));
  assertPreparationPreconditions(read('MAC_RUNTIME_ACCEPTANCE.json'), read('HOST_NETWORK_RESULT.json'), owned);
  assertModelBudget({ freeDisk, fileCount: 14, totalBytes: MODEL_BYTES, maximumWaitMs: 900000, symlinks: 0, extraFiles: 0 });
  const root = assertScopedPath(fs.mkdtempSync(path.join(runnerTemp, 'wordtaker-macos14-prepared-')), runnerTemp);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `root=${root}\n`);
  const report = { success: false, scenario: 'prepared', candidateSourceSha: PRODUCT.candidateSha, priorScenarioRoot: priorRoot, startedAt: new Date().toISOString(), maximumWaitMs: 900000, maximumDownloadBytes: MODEL_BYTES, maximumModelTemporaryBytes: 3 * 1024 ** 3, freeDiskBefore: freeDisk, productAbsentBeforePreparation: true, networkRestoredBeforePreparation: true, manifestSha256: MANIFEST_SHA256, remoteCodeExecuted: false, modelLoaded: false, stage: 'copy-verified-dmg' };
  const deadline = Date.now() + 900000, mount = path.join(root, 'model-source'); let mounted = false;
  try {
    const dmg = path.join(root, PRODUCT.dmgName), priorDmg = path.join(priorRoot, PRODUCT.dmgName);
    assertDownloadedDmg(fs.statSync(priorDmg).size, hashFile(priorDmg));
    fs.copyFileSync(priorDmg, dmg, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(path.join(priorRoot, 'TRANSPORT_RESULT.json'), path.join(root, 'TRANSPORT_RESULT.json'), fs.constants.COPYFILE_EXCL);
    fs.mkdirSync(mount);
    command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg]); mounted = true;
    const app = path.join(mount, '弦外小猫.app'), resources = path.join(app, 'Contents/Resources/app.asar.unpacked');
    assert.equal(hashFile(path.join(app, 'Contents/Resources/app.asar')), PRODUCT.asarSha256);
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 180000 });
    const manifestFile = path.join(resources, 'pytorch-model-manifest.json'); assert.equal(hashFile(manifestFile), MANIFEST_SHA256);
    const manifest = JSON.parse(fs.readFileSync(manifestFile)), pins = Object.values(manifest.models).flatMap(model => Object.values(model.files));
    assertModelBudget({ freeDisk, fileCount: pins.length, totalBytes: pins.reduce((total, pin) => total + pin.size, 0), maximumWaitMs: 900000, symlinks: 0, extraFiles: 0 });
    const cache = path.join(root, 'electron-data/models/damo'); fs.mkdirSync(cache, { recursive: true, mode: 0o700 }); assert.deepEqual(fs.readdirSync(cache), []);
    const pythonHome = path.join(resources, 'python'), python = path.join(pythonHome, 'bin/python3.11');
    report.stage = 'bounded-official-raw-byte-download';
    const result = spawnSync(python, ['-I', '-c', DOWNLOAD_PROGRAM, resources, cache], { cwd: root, env: isolatedEnvironment(process.env, pythonHome), encoding: 'utf8', timeout: Math.max(1, deadline - Date.now() - 10000), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    let downloaded; try { downloaded = JSON.parse((result.stdout || '').trim()); } catch { downloaded = { success: false, code: 'MODEL_PREPARATION_NO_RESULT' }; }
    report.download = downloaded; assert.equal(result.status, 0, 'MODEL_PREPARATION_DOWNLOAD_FAILED'); assert.equal(downloaded.success, true); assert.equal(downloaded.downloadedBytes, MODEL_BYTES);
    report.stage = 'independent-actual-byte-reverification'; Object.assign(report, verifyModelBytes(cache, manifest));
    assert.equal(report.verifiedFiles, 14); assert.equal(report.verifiedBytes, MODEL_BYTES); assert.ok(Date.now() < deadline, 'MODEL_PREPARATION_TIME_BUDGET_EXCEEDED');
    report.cachePath = cache; report.success = true; report.stage = 'complete';
  } catch { report.error = 'MODEL_PREPARATION_FAILED'; process.exitCode = 1; }
  finally {
    if (mounted) try { command('/usr/bin/hdiutil', ['detach', mount]); report.readonlySourceDetached = true; } catch { report.success = false; report.detachError = 'MODEL_SOURCE_DETACH_FAILED'; process.exitCode = 1; }
    report.elapsedMs = Date.now() - Date.parse(report.startedAt); report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(root, 'MODEL_PREPARATION.json'), JSON.stringify(report, null, 2) + '\n'); process.stdout.write(JSON.stringify(report) + '\n');
  }
}
module.exports = { assertPreparationPreconditions, verifyModelBytes, isolatedEnvironment, DOWNLOAD_PROGRAM, MANIFEST_SHA256 };
if (require.main === module) { try { run(); } catch { process.stderr.write('MODEL_PREPARATION_GUARD_REJECTED\n'); process.exitCode = 1; } }
