import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
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
  it('allows only the specifically reviewed first-use readiness repair files', () => {
    const changes = ['src/helpers/funasrManager.js', 'src/hooks/useModelStatus.js',
      'src/components/RecorderPill.jsx', 'src/index.css',
      'tests/funasrInstallationSingleflight.test.js', 'tests/modelFirstUse.test.jsx'];
    const test = cli('--request', changes);
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
  it('allows the approved sealed-bundle cache repair regression without widening runtime scope', () => {
    const test = cli('--request', ['src/helpers/funasrManager.js', 'tests/funasrPythonSecurity.test.js']);
    guard.run(test.command);
    expect(test.append).toHaveBeenCalledWith('test-owned-output', 'allowed=true\n');
    expect(test.copy).not.toHaveBeenCalled();
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
  it('never exports on a signature-module exception, empty result or non-NotSigned status', () => {
    const test = cli();
    const originalCommand = test.command.getMockImplementation();
    for (const result of [new Error('CouldNotAutoloadMatchingModule'), '', 'UnknownError', 'Valid']) {
      test.command.mockImplementation((exe, args) => {
        if (exe !== 'powershell.exe') return originalCommand(exe, args);
        if (result instanceof Error) throw result;
        return result;
      });
      expect(() => guard.run(test.command)).toThrow();
      expect(test.copy).not.toHaveBeenCalled();
      expect(test.write).not.toHaveBeenCalled();
      expect(test.append).not.toHaveBeenCalled();
    }
  });
});

describe('Windows generated paths and real Git cleanliness', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/build-windows.yml', import.meta.url), 'utf8');
  const compile = workflow.split('- name: Compile sendkeys.exe (native key injector)')[1].split('- name: Assert sendkeys.exe built')[0];
  const stage = workflow.split('- name: Stage per-arch release assets')[1].split('- name: Publish to GitHub Release')[0];
  const cl = compile.match(/(?:run:\s*|^\s*)(cl [^\r\n]+)/m)[1];
  // MSVC defaults the intermediate object to the working directory without /Fo.
  const objectPath = (cl.match(/\/Fo(?::)?([^\s]+)/)?.[1] || 'sendkeys.obj').replaceAll('\\', '/');
  const stagingPath = stage.match(/New-Item -ItemType Directory -Force -Path "([^"]+)"/)[1].replaceAll('\\', '/');

  function fixture(check) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wordtaker-export-cleanliness-'));
    const repo = path.join(temporary, 'repo');
    fs.mkdirSync(repo);
    const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.excludesFile=/dev/null', ...args], { cwd: repo, encoding: 'utf8' }).trim();
    const put = (name, contents = 'test-owned generated bytes') => {
      const file = path.join(repo, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    };
    try {
      put('.gitignore', fs.readFileSync(new URL('../.gitignore', import.meta.url)));
      put('main.js', '// tracked source fixture\n');
      git(['init', '-q']);
      git(['add', '.gitignore', 'main.js']);
      git(['-c', 'user.name=WordTaker QA Fixture', '-c', 'user.email=qa-fixture@example.invalid', 'commit', '-qm', 'fixture']);
      const sourceSha = git(['rev-parse', 'HEAD']);
      const githubOutput = path.join(temporary, 'github-output');
      for (const [name, value] of Object.entries({
        LEGACY_EXPORT: 'true', GITHUB_REPOSITORY: request.repository, GITHUB_EVENT_NAME: request.eventName,
        GITHUB_REF: request.ref, GITHUB_SHA: sourceSha, EXPECTED_SOURCE_SHA: sourceSha,
        APPROVED_VERSION: '1.29.5', UNSIGNED_ACKNOWLEDGMENT: request.acknowledgment,
        BUILD_ARCH: 'x64', GITHUB_OUTPUT: githubOutput,
      })) vi.stubEnv(name, value);
      process.argv = ['node', 'legacy-release-guard.cjs', '--request'];
      const command = vi.fn((exe, args) => {
        expect(exe).toBe('git');
        // The fixture has its own baseline; source-boundary rejection is tested above.
        return git(args[0] === 'diff' ? ['diff', '--name-only', 'HEAD', 'HEAD'] : args);
      });
      check({ repo, git, put, command, githubOutput });
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }

  it('keeps MSVC object output inside an explicitly created dist directory without changing executable/compiler options', () => {
    expect(objectPath).toBe('dist/sendkeys.obj');
    expect(compile).toMatch(/if not exist dist mkdir dist/);
    expect(compile.indexOf('mkdir dist')).toBeLessThan(compile.indexOf('cl /nologo'));
    expect(cl).toContain('/nologo /O1 /W3 build\\win\\sendkeys.c');
    expect(cl).toContain('/Fe:build\\win\\sendkeys.exe /link user32.lib');
  });

  it('stages only under dist and keeps disabled Release references consistent', () => {
    expect(stagingPath).toBe('dist/publish');
    expect(stage).toContain('Copy-Item $f.FullName "dist\\publish\\" -Force');
    expect(stage).toContain('Copy-Item "dist\\SHA256SUMS-$arch.txt" "dist\\publish\\" -Force');
    expect(stage).not.toMatch(/"publish(?:\\|\/|")/);
    const release = workflow.split('- name: Publish to GitHub Release')[1].split('- name: Validate exact legacy unsigned x64 export')[0];
    expect(release).toMatch(/if: \$\{\{ false \}\}/);
    expect(release).toContain('dist/publish/*.exe');
    expect(release).toContain('dist/publish/SHA256SUMS-${{ matrix.arch }}.txt');
  });

  it('accepts actual generated workflow paths through the unchanged guard using real git status', () => fixture(({ git, put, command, githubOutput }) => {
    put(objectPath);
    put(`${stagingPath}/${artifact.name}`);
    put(`${stagingPath}/SHA256SUMS-x64.txt`);
    for (const name of ['dist/install-runtime-x64.json', 'build/win/sendkeys.exe', 'python/python.exe', 'node_modules/generated.bin']) put(name);
    expect(git(['status', '--porcelain'])).toBe('');
    guard.run(command);
    expect(command).toHaveBeenCalledWith('git', ['status', '--porcelain']);
    expect(fs.readFileSync(githubOutput, 'utf8')).toBe('allowed=true\n');
  }));

  it('reproduces the old root outputs and refuses them rather than ignoring or deleting them', () => fixture(({ git, put, command, githubOutput, repo }) => {
    put('sendkeys.obj');
    put(`publish/${artifact.name}`);
    put('publish/SHA256SUMS-x64.txt');
    expect(git(['status', '--porcelain'])).toBe('?? publish/\n?? sendkeys.obj');
    expect(() => guard.run(command)).toThrow(/Release checkout is dirty/);
    expect(fs.existsSync(githubOutput)).toBe(false);
    expect(fs.existsSync(path.join(repo, 'sendkeys.obj'))).toBe(true);
  }));

  it('still refuses untracked source even when every generated output is correctly ignored', () => fixture(({ put, command, githubOutput }) => {
    put('dist/sendkeys.obj');
    put('dist/publish/setup.exe');
    put('src/unreviewed.js');
    expect(() => guard.run(command)).toThrow(/Release checkout is dirty/);
    expect(fs.existsSync(githubOutput)).toBe(false);
  }));

  it('still refuses tracked source edits even when generated output paths are clean', () => fixture(({ put, command, githubOutput }) => {
    put('dist/sendkeys.obj');
    put('main.js', '// unexpected source edit\n');
    expect(() => guard.run(command)).toThrow(/Release checkout is dirty/);
    expect(fs.existsSync(githubOutput)).toBe(false);
  }));

  it('creates the unignored export directory only after the last strict cleanliness check', () => {
    const source = fs.readFileSync(new URL('../scripts/legacy-release-guard.cjs', import.meta.url), 'utf8');
    expect(source).toContain("command('git', ['status', '--porcelain'])");
    expect(source).not.toContain('untracked-files=no');
    expect(source.match(/command\('git', \['status', '--porcelain'\]\)/g)).toHaveLength(1);
    expect(source.indexOf("command('git', ['status', '--porcelain'])")).toBeLessThan(source.indexOf('fs.mkdirSync(output)'));
    fixture(({ git, put, command, githubOutput }) => {
      put('dist/publish/setup.exe');
      guard.run(command);
      expect(fs.readFileSync(githubOutput, 'utf8')).toBe('allowed=true\n');
      put(`legacy-export/${artifact.name}`);
      put('legacy-export/RELEASE_RECEIPT.json');
      expect(git(['status', '--porcelain'])).toBe('?? legacy-export/');
      expect(() => guard.run(command)).toThrow(/Release checkout is dirty/);
    });
  });
});

describe('process-local Windows signature module environment', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/build-windows.yml', import.meta.url), 'utf8');
  const preflightName = '- name: Preflight native Authenticode module loading';
  const preflight = workflow.split(preflightName)[1]?.split('- name: Get pnpm store directory')[0] || '';
  const validate = workflow.split('- name: Validate exact legacy unsigned x64 export')[1].split('- name: Upload Windows artifacts')[0];
  const script = () => {
    const match = preflight.match(/@'\n([\s\S]*?)\n\s*'@ \| node/);
    expect(match, 'Missing executable Node-to-Windows-PowerShell preflight').not.toBeNull();
    return match[1];
  };

  it('clears only the current step module path before the unchanged final guard and preserves nonzero exits', () => {
    expect(validate).toContain('shell: pwsh');
    expect(validate).toContain('$env:PSModulePath = $null');
    expect(validate.indexOf('$env:PSModulePath = $null')).toBeLessThan(validate.indexOf('node scripts/legacy-release-guard.cjs --validate'));
    expect(validate).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
    expect(validate).toContain("success() && matrix.arch == 'x64' && steps.legacy-request.outputs.allowed == 'true'");
    for (const name of ['EXPECTED_SOURCE_SHA', 'ORDINARY_CI_RUN_ID', 'UNSIGNED_ACKNOWLEDGMENT', 'BUILD_ARCH', 'GH_TOKEN']) expect(validate).toContain(`${name}:`);
  });

  it('runs a real native module preflight before expensive setup only for explicitly approved x64 exports', () => {
    expect(preflight).toContain('shell: pwsh');
    expect(preflight).toContain('$env:PSModulePath = $null');
    expect(preflight.indexOf('$env:PSModulePath = $null')).toBeLessThan(preflight.indexOf("@'"));
    expect(preflight).toContain("success() && matrix.arch == 'x64' && steps.legacy-request.outputs.allowed == 'true'");
    expect(preflight).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
    expect(workflow.indexOf(preflightName)).toBeGreaterThan(workflow.indexOf('- name: Check explicit legacy unsigned x64 request'));
    expect(workflow.indexOf(preflightName)).toBeLessThan(workflow.indexOf('- name: Install dependencies'));
    expect(preflight).not.toContain('continue-on-error');
  });

  it('does not persist environment changes or change policy, registry, permissions or other invocation steps', () => {
    expect(workflow.match(/\$env:PSModulePath = \$null/g)).toHaveLength(2);
    expect((preflight + validate).match(/\$env:PSModulePath = \$null/g)).toHaveLength(2);
    expect(preflight + validate).not.toMatch(/GITHUB_ENV|SetEnvironmentVariable|Set-ExecutionPolicy|ExecutionPolicy|HKLM:|HKCU:|Set-ItemProperty/);
    expect(preflight + validate).not.toMatch(/catch|SilentlyContinue|NotSigned/);
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('actions: read');
    expect(workflow).not.toMatch(/contents: write|actions: write/);
  });

  it('executes the inline Node preflight against the native command loader, not a synthetic signature result', () => {
    const execute = vi.fn();
    runInNewContext(script(), { require: name => {
      expect(name).toBe('node:child_process');
      return { execFileSync: execute };
    } });
    expect(execute).toHaveBeenCalledTimes(1);
    const [exe, args, options] = execute.mock.calls[0];
    expect(exe).toBe('powershell.exe');
    expect(Array.from(args).slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(args[3]).toContain('Import-Module Microsoft.PowerShell.Security -ErrorAction Stop');
    expect(args[3]).toContain('Get-Command Get-AuthenticodeSignature -ErrorAction Stop');
    expect(args[3]).toContain('$PSVersionTable.PSVersion');
    expect(options.stdio).toBe('inherit');
    expect(preflight).not.toContain('process.env');
  });

  it('propagates actual child-process command/module failure rather than catching or treating it as unsigned', () => {
    const error = new Error('native module loader failed');
    const execute = vi.fn(() => { throw error; });
    expect(() => runInNewContext(script(), { require: () => ({ execFileSync: execute }) })).toThrow(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('byte-preserving Windows checkout environment', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/build-windows.yml', import.meta.url), 'utf8');
  const checkout = workflow.split('- name: Checkout')[1].split('- name: Setup pnpm')[0];
  const checkoutEnv = Object.fromEntries([...checkout.matchAll(/^\s+(GIT_CONFIG_(?:COUNT|KEY_0|VALUE_0)):\s*'?([^'\r\n]+)'?\s*$/gm)].map(match => [match[1], match[2].trim()]));

  it('overrides autocrlf only for checkout without changing Git configuration files or other steps', () => {
    expect(checkoutEnv).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });
    expect(workflow.match(/GIT_CONFIG_COUNT:/g)).toHaveLength(1);
    expect(checkout).not.toMatch(/git config|GITHUB_ENV|checkout-index|reset --hard/);
    expect(checkout).toContain('fetch-depth: 0');
  });

  it('preserves actual Git blob bytes and asset fingerprints even when the runner default would produce CRLF', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wordtaker-checkout-bytes-'));
    const source = path.join(temporary, 'source');
    const defaults = path.join(temporary, 'fixture-gitconfig');
    const svg = Buffer.from('<svg>\n<path d="M0 0"/>\n</svg>\n');
    const binary = Buffer.from([0, 13, 10, 255, 10]);
    fs.mkdirSync(source);
    fs.writeFileSync(defaults, '[core]\n\tautocrlf = true\n');
    fs.writeFileSync(path.join(source, 'icon.svg'), svg);
    fs.writeFileSync(path.join(source, 'binary.dat'), binary);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: defaults, GIT_CONFIG_NOSYSTEM: '1' };
    for (const key of Object.keys(env)) if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS)/.test(key)) delete env[key];
    const git = (args, cwd = source, extra = {}) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' }).trim();
    try {
      git(['init', '-q']);
      git(['-c', 'core.autocrlf=false', 'add', 'icon.svg', 'binary.dat']);
      git(['-c', 'user.name=WordTaker QA Fixture', '-c', 'user.email=qa-fixture@example.invalid', 'commit', '-qm', 'fixture']);
      const old = path.join(temporary, 'old');
      const current = path.join(temporary, 'current');
      git(['clone', '-q', source, old]);
      expect(fs.readFileSync(path.join(old, 'icon.svg')).equals(svg)).toBe(false);
      expect(fs.readFileSync(path.join(old, 'icon.svg'), 'utf8')).toBe(svg.toString().replaceAll('\n', '\r\n'));
      git(['clone', '-q', source, current], source, checkoutEnv);
      const checkedOut = fs.readFileSync(path.join(current, 'icon.svg'));
      expect(checkedOut.equals(svg)).toBe(true);
      expect(crypto.createHash('sha256').update(checkedOut).digest('hex')).toBe(crypto.createHash('sha256').update(svg).digest('hex'));
      expect(fs.readFileSync(path.join(current, 'binary.dat')).equals(binary)).toBe(true);
      expect(git(['status', '--porcelain'], current)).toBe('');
      expect(() => git(['config', '--local', '--get', 'core.autocrlf'], current)).toThrow();
      expect(fs.readFileSync(defaults, 'utf8')).toBe('[core]\n\tautocrlf = true\n');
      expect(git(['show', 'HEAD:icon.svg'])).toBe(svg.toString().trim());
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
