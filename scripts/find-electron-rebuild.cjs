const path = require('node:path');
const { createRequire } = require('node:module');

function resolveElectronRebuildCli(projectRoot) {
  const project = createRequire(path.join(projectRoot, 'package.json'));
  const builder = createRequire(project.resolve('electron-builder/package.json'));
  const appBuilder = createRequire(builder.resolve('app-builder-lib/package.json'));
  return path.join(path.dirname(appBuilder.resolve('@electron/rebuild')), 'cli.js');
}

module.exports = { resolveElectronRebuildCli };
if (require.main === module) {
  process.stdout.write(`${resolveElectronRebuildCli(path.join(__dirname, '..'))}\n`);
}
