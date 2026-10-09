import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const guard = require('../scripts/legacy-release-guard.cjs');
const sha = 'a'.repeat(40);
const request = {
  enabled: true, repository: 'firendvip/WordTaker', eventName: 'workflow_dispatch',
  ref: 'refs/heads/codex/wordtaker-release-candidate', sourceSha: sha, gitSha: sha,
  expectedSha: sha, version: '1.29.5', approvedVersion: '1.29.5',
  acknowledgment: 'I_ACCEPT_UNSIGNED_1.29.5', arch: 'x64',
};
const acceptance = {
  sourceCommit: sha, version: '1.29.5', arch: 'x64', success: true,
  installation: true, productionEntry: true, runtime: true, cleanExit: true, uninstall: true,
  installerSha256: 'b'.repeat(64), trustedSignatureTested: false,
};
const ci = {
  id: 123, head_sha: sha, path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success',
  jobs: [{ name: 'js', conclusion: 'success' }, { name: 'python', conclusion: 'success' }],
};
const artifact = { name: 'KittyEcho-1.29.5-x64-setup.exe', size: 100, sha256: 'b'.repeat(64), signatureStatus: 'NotSigned' };
const originalArgv = process.argv;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.argv = originalArgv; });

describe('explicit legacy unsigned release route', () => {
  it('defaults closed without requesting any export or release', () => {
    expect(guard.validateRequest({ enabled: false })).toBe(false);
    expect(() => guard.validateRequest({})).toThrow();
  });
  it('requires exact repository, manual event, approved ref, full SHA, version and acknowledgment', () => {
    expect(guard.validateRequest(request)).toBe(true);
    expect(guard.validateRequest({ ...request, ref: 'refs/tags/v1.29.5' })).toBe(true);
    for (const bad of [
      { repository: 'other/WordTaker' }, { eventName: 'push' }, { eventName: 'pull_request' },
      { ref: 'refs/heads/main' }, { ref: 'refs/tags/v1.29.6' }, { expectedSha: 'a'.repeat(7) },
      { expectedSha: 'c'.repeat(40) }, { sourceSha: 'c'.repeat(40) }, { gitSha: 'c'.repeat(40) },
      { version: '1.29.4' }, { approvedVersion: '1.29.6' }, { acknowledgment: '' }, { arch: 'arm64' },
    ]) expect(() => guard.validateRequest({ ...request, ...bad })).toThrow();
  });
  it('requires actual same-SHA ordinary JS/Python CI and real installation receipt', () => {
    expect(guard.validateExport(request, ci, acceptance, artifact)).toEqual({ allowed: true, unsigned: true });
    for (const bad of [
      { id: 0 }, { head_sha: 'c'.repeat(40) }, { path: '.github/workflows/build-windows.yml' },
      { status: 'in_progress' }, { conclusion: 'failure' }, { jobs: [{ name: 'js', conclusion: 'success' }] },
      { jobs: [{ name: 'js', conclusion: 'success' }, { name: 'python', conclusion: 'skipped' }] },
    ]) expect(() => guard.validateExport(request, { ...ci, ...bad }, acceptance, artifact)).toThrow();
    for (const key of ['success', 'installation', 'productionEntry', 'runtime', 'cleanExit', 'uninstall']) {
      expect(() => guard.validateExport(request, ci, { ...acceptance, [key]: false }, artifact)).toThrow();
    }
    for (const bad of [{ sourceCommit: 'c'.repeat(40) }, { version: '1.29.4' }, { arch: 'arm64' }, { installerSha256: 'c'.repeat(64) }, { trustedSignatureTested: true }]) {
      expect(() => guard.validateExport(request, ci, { ...acceptance, ...bad }, artifact)).toThrow();
    }
  });
  it('rejects wrong platform assets, empty/truncated metadata, changed bytes and false signing claims', () => {
    for (const bad of [
      { name: 'KittyEcho-1.29.5-arm64-setup.exe' }, { name: 'KittyEcho-1.29.5-x64-portable.exe' },
      { name: '../KittyEcho-1.29.5-x64-setup.exe' }, { size: 0 }, { size: 1.5 },
      { sha256: 'x'.repeat(64) }, { signatureStatus: 'Valid' },
    ]) expect(() => guard.validateExport(request, ci, acceptance, { ...artifact, ...bad })).toThrow();
  });
  it('does not expose candidate files on default dispatch, tags, failure or another architecture', () => {
    const workflow = fs.readFileSync(new URL('../.github/workflows/build-windows.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('export_legacy_unsigned_x64:');
    expect(workflow).toContain('default: false');
    expect(workflow).toContain('node scripts/legacy-release-guard.cjs --request');
    expect(workflow).toContain('node scripts/legacy-release-guard.cjs --validate');
    const upload = workflow.split('- name: Upload Windows artifacts (short retention)')[1];
    expect(upload).toContain("success() && matrix.arch == 'x64' && steps.legacy-validation.outputs.allowed == 'true'");
    expect(upload).toContain('legacy-export/KittyEcho-1.29.5-x64-setup.exe');
    expect(upload).not.toContain('publish/*.exe');
    expect(workflow).toMatch(/name: Publish to GitHub Release\s+if: \$\{\{ false \}\}/);
    expect(workflow).toContain('contents: read');
    expect(workflow).not.toContain('contents: write');
  });
});

describe('legacy export CLI boundaries', () => {
  function cli(mode = '--validate', changes = []) {
    const bytes = Buffer.from('test-owned NSIS bytes');
    const fileHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const output = path.resolve('legacy-export');
    const file = path.resolve('dist', artifact.name);
    const append = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const copy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    vi.spyOn(fs, 'existsSync').mockImplementation(name => name === output ? false : true);
    vi.spyOn(fs, 'statSync').mockImplementation(() => ({ size: bytes.length }));
    const originalRead = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((name, ...args) => {
      if (name === 'dist/install-runtime-x64.json') return JSON.stringify({ ...acceptance, installerSha256: fileHash });
      if (name === file) return bytes;
      return originalRead(name, ...args);
    });
    for (const [name, value] of Object.entries({
      LEGACY_EXPORT: 'true', GITHUB_REPOSITORY: request.repository, GITHUB_EVENT_NAME: request.eventName,
      GITHUB_REF: request.ref, GITHUB_SHA: sha, EXPECTED_SOURCE_SHA: sha, APPROVED_VERSION: '1.29.5',
      UNSIGNED_ACKNOWLEDGMENT: request.acknowledgment, BUILD_ARCH: 'x64', GITHUB_OUTPUT: 'test-owned-output',
      ORDINARY_CI_RUN_ID: '123', GITHUB_RUN_ID: '456',
    })) vi.stubEnv(name, value);
    process.argv = ['node', 'legacy-release-guard.cjs', mode];
    const command = vi.fn((exe, args) => {
      if (exe === 'git' && args[0] === 'rev-parse') return sha;
      if (exe === 'git' && args[0] === 'status') return '';
      if (exe === 'git' && args[0] === 'diff') return changes.join('\n');
      if (exe === 'gh' && args[1].endsWith('/jobs')) return JSON.stringify({ jobs: ci.jobs });
      if (exe === 'gh') return JSON.stringify(ci);
      if (exe === 'powershell.exe') return 'NotSigned';
      throw new Error('Unexpected external command');
    });
    return { command, append, write, copy, output, fileHash };
  }
  it('only reports false on default verify-only requests and does not stage assets', () => {
    const test = cli('--request');
    vi.stubEnv('LEGACY_EXPORT', 'false');
    guard.run(test.command);
    expect(test.append).toHaveBeenCalledWith('test-owned-output', 'allowed=false\n');
    expect(test.copy).not.toHaveBeenCalled();
    expect(test.command).toHaveBeenCalledTimes(1);
  });
  it('checks the reviewed source boundary before enabling a requested route', () => {
    const test = cli('--request', ['docs/MACOS_BUILD.md', 'scripts/legacy-release-guard.cjs']);
    guard.run(test.command);
    expect(test.append).toHaveBeenCalledWith('test-owned-output', 'allowed=true\n');
    expect(test.copy).not.toHaveBeenCalled();
  });
  it('blocks runtime drift and dirty checkouts, not just filenames or caller-supplied SHA', () => {
    const test = cli('--request', ['src/App.jsx']);
    expect(() => guard.run(test.command)).toThrow(/Frozen runtime/);
    expect(test.append).not.toHaveBeenCalled();
    test.command.mockImplementation(() => sha);
    expect(() => guard.run(test.command)).toThrow(/dirty/);
  });
  it('re-fetches actual CI metadata, checks byte hash/signature and stages only the exact NSIS', () => {
    const test = cli();
    guard.run(test.command);
    expect(test.copy).toHaveBeenCalledTimes(1);
    expect(test.copy.mock.calls[0][1]).toBe(path.join(test.output, artifact.name));
    const receipt = JSON.parse(test.write.mock.calls.find(([name]) => name.endsWith('RELEASE_RECEIPT.json'))[1]);
    expect(receipt.sourceCommit).toBe(sha);
    expect(receipt.authenticode).toBe(false);
    expect(receipt.artifact.sha256).toBe(test.fileHash);
    expect(receipt.publicReleaseCreated).toBe(false);
    expect(test.append).toHaveBeenCalledWith('test-owned-output', 'allowed=true\n');
  });
  it('rejects missing ordinary CI, invalid CLI operations and export-dir overwrite', () => {
    const test = cli();
    vi.stubEnv('ORDINARY_CI_RUN_ID', '');
    expect(() => guard.run(test.command)).toThrow();
    vi.stubEnv('ORDINARY_CI_RUN_ID', '123');
    process.argv[2] = '--anything';
    expect(() => guard.run(test.command)).toThrow();
    process.argv[2] = '--validate';
    fs.existsSync.mockImplementation(() => true);
    expect(() => guard.run(test.command)).toThrow(/overwrite/);
    expect(test.copy).not.toHaveBeenCalled();
    expect(test.append).not.toHaveBeenCalled();
  });
});
