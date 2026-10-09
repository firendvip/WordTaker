import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

describe('clean Python CI source-dispatch contract', () => {
  it('runs the same main/PR jobs on a read-only candidate dispatch without release uploads', () => {
    expect(ci).toMatch(/on:\s+workflow_dispatch:/);
    expect(ci).toContain('branches: [main]');
    expect(ci).toMatch(/permissions:\s+contents: read/);
    expect(ci).not.toMatch(/upload-artifact|gh release|publish never|contents: write/);
    expect(ci).toContain('python -m pytest tests/python -q');
  });

  it('installs the exact official FunASR source-only wheel with hash checking and no AI dependency resolver', () => {
    const requirement = fs.readFileSync(new URL('./python/funasr-source-requirements.txt', import.meta.url), 'utf8');
    expect(requirement).toContain('https://files.pythonhosted.org/packages/f7/6f/491bc744f9d23be35d848479dd21ba6576788e4a2cffbdd410725669fe5c/funasr-1.2.7-py3-none-any.whl');
    expect(requirement).toContain('--hash=sha256:b53f748e479e5bf6af172407c50eccaa6818ed91bdf8656abcd7ea6c5e3d2b0d');
    expect(ci).toContain('python -m pip --isolated install --no-deps --no-compile --only-binary=:all: --require-hashes -r tests/python/funasr-source-requirements.txt');
    expect(ci).not.toMatch(/pip.*(?:install|download).*\b(?:torch|torchaudio|modelscope|transformers)\b/);
    expect(ci).not.toMatch(/pytest[^\n]*(?:--ignore|-k\s|--deselect)/);
  });
});
