import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const acceptance = require('../scripts/windows-install-acceptance.cjs');
const ci = fs.readFileSync(new URL('../.github/workflows/build-windows.yml', import.meta.url), 'utf8');

describe('isolated Windows installation acceptance', () => {
  const trusted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: 'D:\\runner\\temp' };
  it('refuses local machines, other platforms, architectures and missing runner roots', () => {
    expect(() => acceptance.assertRunner('darwin', 'arm64', trusted)).toThrow();
    expect(() => acceptance.assertRunner('win32', 'arm64', trusted)).toThrow();
    expect(() => acceptance.assertRunner('win32', 'x64', {})).toThrow();
    expect(() => acceptance.assertRunner('win32', 'x64', { ...trusted, RUNNER_ENVIRONMENT: 'self-hosted' })).toThrow();
    expect(() => acceptance.assertRunner('win32', 'x64', { ...trusted, RUNNER_TEMP: '' })).toThrow();
    expect(() => acceptance.assertRunner('win32', 'x64', trusted)).not.toThrow();
  });
  it('uses only a unique child of the runner temp root for disposable state', () => {
    const root = path.win32.join(trusted.RUNNER_TEMP, 'wordtaker-install-123');
    expect(acceptance.assertScopedPath(root, trusted.RUNNER_TEMP, path.win32)).toBe(root);
    for (const unsafe of [trusted.RUNNER_TEMP, 'D:\\', 'D:\\runner\\other', 'D:\\runner\\temp-escape']) {
      expect(() => acceptance.assertScopedPath(unsafe, trusted.RUNNER_TEMP, path.win32)).toThrow();
    }
  });
  it('keeps the unquoted NSIS install-dir parameter last, without disabling CRC or auto-launching', () => {
    expect(acceptance.installerArgs('D:\\runner\\temp\\with spaces')).toEqual(['/S', '/currentuser', '/D=D:\\runner\\temp\\with spaces']);
  });
  it('checks the real settings mount and uninstall registration rather than invented fields', () => {
    const html = fs.readFileSync(new URL('../src/settings.html', import.meta.url), 'utf8');
    expect(html).toContain(`id="${acceptance.SETTINGS_ROOT_SELECTOR.slice(1)}"`);
    expect(acceptance.registeredInstallDir('"D:\\runner\\temp\\installed\\Uninstall 弦外小猫.exe" /currentuser')).toBe('D:\\runner\\temp\\installed');
    expect(() => acceptance.registeredInstallDir('D:\\wrong.exe')).toThrow();
  });
  it('does not accept process presence or an empty/errored renderer as UI health', () => {
    const healthy = { version: '1.29.5', isolated: true, hasRoot: true, bodyText: '弦外小猫', loggedIn: false };
    expect(() => acceptance.assertUiHealth(healthy, '1.29.5')).not.toThrow();
    for (const bad of [{ ...healthy, version: '1.29.4' }, { ...healthy, isolated: false }, { ...healthy, hasRoot: false }, { ...healthy, bodyText: '' }, { ...healthy, bodyText: '应用出现错误' }, { ...healthy, loggedIn: true }]) {
      expect(() => acceptance.assertUiHealth(bad, '1.29.5')).toThrow();
    }
  });
  it('only enables installation acceptance for x64 and preserves publication/upload guards', () => {
    expect(ci).toMatch(/name: Accept x64 NSIS install, runtime and uninstall\s+if:.*matrix\.arch == 'x64'/);
    expect(ci).toContain('node scripts/windows-install-acceptance.cjs');
    expect(ci).toContain('contents: read');
    expect(ci).toMatch(/name: Publish to GitHub Release\s+if: \$\{\{ false \}\}/);
    expect(ci).toMatch(/name: Upload Windows artifacts \(short retention\)\s+if: \$\{\{ false \}\}/);
  });
});
