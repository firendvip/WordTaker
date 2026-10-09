import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('loads verified local ASR/VAD/punctuation models without a model-hub request', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  expect(() => execFileSync('python3', ['tests/test_funasr_local_models.py'], {
    cwd: root, timeout: 10000, stdio: 'pipe',
  })).not.toThrow();
});
