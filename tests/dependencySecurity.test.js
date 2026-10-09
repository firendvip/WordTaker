import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// 已确认公告的最低修复版本；实时扫描仍以 pnpm audit 为准。
const lockfile = fs.readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
const packages = lockfile.split('\npackages:\n')[1].split('\nsnapshots:\n')[0];
const locked = [...packages.matchAll(/^  '?([^\n']+?)@(\d+\.\d+\.\d+)'?:$/gm)]
  .map(([, name, version]) => ({ name, version }));
const atLeast = (version, minimum) => {
  const actual = version.split('.').map(Number);
  const required = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
};

describe('security-patched dependency baseline', () => {
  it('keeps CI on the same package manager with a frozen lockfile and security gate', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.packageManager).toBe('pnpm@11.5.3');
    expect(manifest.scripts['audit:security']).toBe('pnpm audit --audit-level high');
    for (const file of ['ci.yml', 'build-windows.yml']) {
      const workflow = fs.readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
      expect(workflow).toContain('version: 11.5.3');
      expect(workflow).toContain('pnpm install --frozen-lockfile --ignore-scripts');
      expect(workflow).toContain('pnpm audit:security');
    }
  });
  it('does not retain the vulnerable legacy Electron zip extractor', () => {
    for (const { version } of locked.filter((entry) => entry.name === 'extract-zip')) {
      expect(atLeast(version, '2.0.2')).toBe(true);
    }
  });
  it.each([
    ['electron', '43.7.8'],
    ['axios', '1.20.0'],
    ['vite', '8.3.0'],
    ['@vitejs/plugin-react', '6.1.1'],
    ['rolldown', '1.2.9'],
    ['electron-builder', '26.15.7'],
    ['better-sqlite3', '13.0.3'],
    ['vitest', '4.1.11'],
    ['shell-quote', '1.11.0'],
    ['tar', '7.5.22'],
    ['builder-util-runtime', '9.7.0'],
    ['postcss', '8.5.23'],
    ['source-map-js', '1.2.2'],
  ])('does not resolve %s below %s', (name, minimum) => {
    const versions = locked.filter((entry) => entry.name === name);
    expect(versions.length).toBeGreaterThan(0);
    for (const { version } of versions) {
      expect(atLeast(version, minimum), `${name}@${version}`).toBe(true);
    }
  });
  it('validates patched Rollup when present without adding it to the Vite 8 Rolldown graph', () => {
    for (const { version } of locked.filter(entry => entry.name === 'rollup')) {
      expect(atLeast(version, '4.59.0'), `rollup@${version}`).toBe(true);
    }
  });
});
