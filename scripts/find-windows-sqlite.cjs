const fs = require('node:fs');
const path = require('node:path');

// SQLite <=12 uses better_sqlite3.node; SQLite 13 prefers prebuilds/win32-<arch>.node.
// Return only the target Windows prebuild plus every legacy binary already checked by CI.
function findWindowsSqliteBinaries(root, arch) {
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported Windows architecture: ${arch}`);
  }
  const targetName = `win32-${arch}.node`;
  const pending = [path.resolve(root)];
  const found = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(file);
      } else if (entry.isFile()) {
        const legacy = entry.name === 'better_sqlite3.node';
        const targetPrebuild = entry.name === targetName &&
          path.basename(directory) === 'prebuilds' &&
          path.basename(path.dirname(directory)) === 'better-sqlite3';
        if (legacy || targetPrebuild) found.push(file);
      }
    }
  }
  return found.sort();
}

module.exports = { findWindowsSqliteBinaries };
