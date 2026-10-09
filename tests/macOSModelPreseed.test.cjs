const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { assertPreparationPreconditions, verifyModelBytes, isolatedEnvironment, DOWNLOAD_PROGRAM, MANIFEST_SHA256 } = require('../scripts/macos-model-preseed.cjs');
const { PRODUCT } = require('../scripts/macos-dmg-guard.cjs');
const prior = () => ({ success: true, scenario: 'unprepared', firstUseReadinessPassed: true, cleanExit: true, candidateSourceSha: PRODUCT.candidateSha });
const network = () => ({ success: true, productProcessesAbsentBeforeRestore: true, networkAndOriginalRulesRestored: true });
test('model preparation only follows genuine completed A and restored networking', () => assert.doesNotThrow(() => assertPreparationPreconditions(prior(), network(), [])));
for (const [key, value] of [['success', false], ['scenario', 'prepared'], ['firstUseReadinessPassed', false], ['cleanExit', false], ['candidateSourceSha', 'old']]) {
  test(`refuses incomplete or different-source A ${key}`, () => assert.throws(() => assertPreparationPreconditions({ ...prior(), [key]: value }, network(), [])));
}
for (const key of ['success', 'productProcessesAbsentBeforeRestore', 'networkAndOriginalRulesRestored']) {
  test(`refuses unconfirmed restoration ${key}`, () => assert.throws(() => assertPreparationPreconditions(prior(), { ...network(), [key]: false }, [])));
}
test('refuses active product processes before downloads', () => assert.throws(() => assertPreparationPreconditions(prior(), network(), [123])));
test('Python preparation clears credentials and inherited runtime options without forcing ONNX', () => {
  const env = isolatedEnvironment({ HOME: '/fixture', GH_TOKEN: 'secret', API_SECRET: 'secret', PASSWORD: 'secret', NODE_OPTIONS: '--unsafe', ELECTRON_RUN_AS_NODE: '1', WORDTAKER_ONNX_ONLY: '1', PYTHONPATH: '/wrong', PYTHONUSERBASE: '/wrong', VIRTUAL_ENV: '/wrong' }, '/verified/python');
  assert.equal(env.HOME, '/fixture'); assert.equal(env.PYTHONHOME, '/verified/python');
  assert.equal(env.PYTHONNOUSERSITE, '1'); assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  for (const key of ['GH_TOKEN', 'API_SECRET', 'PASSWORD', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'WORDTAKER_ONNX_ONLY', 'PYTHONPATH', 'PYTHONUSERBASE', 'VIRTUAL_ENV']) assert.equal(env[key], undefined);
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wordtaker-model-byte-test-'));
  const data = Buffer.from('trusted bytes'), directory = path.join(root, 'repository'); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'model.pt'), data);
  return { root, manifest: { models: { repository: { files: { 'model.pt': { size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') } } } } } };
}
test('hashes actual pinned model bytes with a no-extra-files inventory', () => {
  const value = fixture(); try { assert.deepEqual(verifyModelBytes(value.root, value.manifest), { verifiedFiles: 1, verifiedBytes: 13 }); } finally { fs.rmSync(value.root, { recursive: true }); }
});
for (const label of ['hash', 'size', 'extra', 'symlink']) test(`rejects ${label} model contamination before any loading`, () => {
  const value = fixture(); try {
    const file = path.join(value.root, 'repository/model.pt');
    if (label === 'hash') fs.writeFileSync(file, 'changed bytes');
    if (label === 'size') fs.writeFileSync(file, 'short');
    if (label === 'extra') fs.writeFileSync(path.join(value.root, 'extra.py'), 'not allowed');
    if (label === 'symlink') { fs.unlinkSync(file); fs.symlinkSync('/does/not/exist', file); }
    assert.throws(() => verifyModelBytes(value.root, value.manifest));
  } finally { fs.rmSync(value.root, { recursive: true }); }
});
test('download policy uses packaged verified downloader, fixed manifest and hard aggregate budget', () => {
  assert.equal(MANIFEST_SHA256, '972d65c4fe8ea08cb7a0d1d5ee841e5dbbce065a2d88bb590bff7bec745172d4');
  assert.match(DOWNLOAD_PROGRAM, /download_verified_model/); assert.match(DOWNLOAD_PROGRAM, /HTTPSRedirectHandler/);
  assert.match(DOWNLOAD_PROGRAM, /1186817247/); assert.match(DOWNLOAD_PROGRAM, /MODEL_DOWNLOAD_BUDGET_EXCEEDED/);
  assert.doesNotMatch(DOWNLOAD_PROGRAM, /import torch|import funasr|retry|latest|trust_remote_code/);
});
test('embedded download program compiles using only Python standard library', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync('python3', ['-I', '-c', `compile(${JSON.stringify(DOWNLOAD_PROGRAM)}, '<QA bounded download>', 'exec')`]);
});
for (const [label, budget, length, expected] of [['complete', 3, 3, true], ['budget', 2, 3, false], ['header', 3, 4, false]]) {
  test(`real Python bound-response code ${label} uses in-memory fixtures and no network`, () => {
    const { spawnSync } = require('node:child_process');
    const fixtureProgram = `
import sys, types, urllib.request
sys.argv = ['fixture', '/verified/resources', '/private/test/cache']
record = {'repository': 'damo/fixture', 'commit': 'fixed', 'files': {'model.pt': {'size': 3}}}
class Response:
    headers = {'Content-Length': '${length}'}
    def __init__(self): self.data = b'abc'
    def read(self, size): value, self.data = self.data[:size], self.data[size:]; return value
    def close(self): pass
    def geturl(self): return 'https://www.modelscope.cn/fixture'
class Opener:
    def open(self, *_args, **_kwargs): return Response()
urllib.request.build_opener = lambda *_args: Opener()
def fixture_download(_root, _repository, *, manifest, opener):
    request = urllib.request.Request('https://www.modelscope.cn/api/v1/models/damo/fixture/repo?Revision=fixed&FilePath=model.pt')
    with opener(request, timeout=60) as response:
        while response.read(1024): pass
download = types.ModuleType('download_models')
download.download_verified_model = fixture_download
download.HTTPSRedirectHandler = urllib.request.HTTPRedirectHandler
sys.modules['download_models'] = download
security = types.ModuleType('pytorch_model_security')
security.load_manifest = lambda: {'models': {'fixture': record}}
sys.modules['pytorch_model_security'] = security
`;
    const result = spawnSync('python3', ['-I', '-c', fixtureProgram + '\n' + DOWNLOAD_PROGRAM.replace('budget = 1186817247', `budget = ${budget}`)], { encoding: 'utf8', timeout: 10000 });
    assert.equal(JSON.parse(result.stdout).success, expected); assert.equal(result.status, expected ? 0 : 1);
    assert.doesNotMatch(result.stdout + result.stderr, /TOKEN|secret|Traceback|https:/);
  });
}
