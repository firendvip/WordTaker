const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Reviewed PyPI cp311 arm64 artifacts, not a lock for the entire legacy Python stack.
// SciPy's official macosx_12_0 wheel has an actual 12.3 minimum and satisfies 14.0.
const MACOS_ARM64_WHEELS = Object.freeze([
  Object.freeze({
    package: 'onnxruntime', version: '1.31.0',
    url: 'https://files.pythonhosted.org/packages/a7/e7/61b2768393646bd12e31eeb71958193f4e02c98c4980cf9289d19bbb4a8f/onnxruntime-1.31.0-cp311-cp311-macosx_14_0_arm64.whl',
    wheelSHA256: 'cbf1a7f6470ddfe9dbc781966af8ce4a10e1858d75a93f93cc6b9367c9587870',
    fileCount: 316, contentSHA256: '4ee42c395ed54733613b952951aff4f75bb9a3bb6bc8d6e32fa5d2f53a4b2d8c',
    metadataSHA256: '49d642d98f88dc138508e87888dea36d54ea9a3cd2865ed0a97ce599a9d39428',
    wheelMetadataSHA256: '9943b52b1b015bb00871d0ffcd0311a6838effd8b306d90992fcf068b8d0b277',
  }),
  Object.freeze({
    package: 'scipy', version: '1.17.1',
    url: 'https://files.pythonhosted.org/packages/f7/58/bccc2861b305abdd1b8663d6130c0b3d7cc22e8d86663edbc8401bfd40d4/scipy-1.17.1-cp311-cp311-macosx_12_0_arm64.whl',
    wheelSHA256: 'e18f12c6b0bc5a592ed23d3f7b891f68fd7f8241d69b7883769eb5d5dfb52696',
    fileCount: 1420, contentSHA256: '2998729baea2aee17590645bcc78f3ab94996eb3507f5595fcb1d42403ccd368',
    metadataSHA256: 'b1cd2c784f6e003c6c71af4c5ee57f6370ee467d17b656250d9fd38cf579d7d0',
    wheelMetadataSHA256: '71dfa1b93eb2edbedfebbe754ce6e61ad5ca16ad25a8b00ab96410c0ed818c9e',
  }),
]);

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function regularDirectory(filename) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink()) throw new Error(`Pinned wheel symlink is not allowed: ${filename}`);
  if (!stat.isDirectory()) throw new Error(`Pinned wheel directory is missing: ${filename}`);
}

function hashPackageContents(root) {
  regularDirectory(root);
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Pinned wheel symlink is not allowed: ${filename}`);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile()) files.push({ name: path.relative(root, filename).split(path.sep).join('/'), hash: sha256(fs.readFileSync(filename)) });
      else throw new Error(`Pinned wheel non-regular file: ${filename}`);
    }
  }
  walk(root);
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { fileCount: files.length, contentSHA256: sha256(files.map(({ name, hash }) => `${hash}  ${name}\n`).join('')) };
}

function verifyPinnedPackage(sitePackages, pin) {
  regularDirectory(sitePackages);
  const expectedDistribution = `${pin.package}-${pin.version}.dist-info`;
  const distributions = fs.readdirSync(sitePackages).filter((name) => name.startsWith(`${pin.package}-`) && name.endsWith('.dist-info'));
  if (distributions.length !== 1 || distributions[0] !== expectedDistribution) throw new Error(`Pinned wheel distribution version mismatch: ${pin.package}`);
  const metadata = path.join(sitePackages, expectedDistribution);
  regularDirectory(metadata);
  for (const [filename, expectedHash] of [['METADATA', pin.metadataSHA256], ['WHEEL', pin.wheelMetadataSHA256]]) {
    const file = path.join(metadata, filename);
    if (!fs.lstatSync(file).isFile() || sha256(fs.readFileSync(file)) !== expectedHash) throw new Error(`Pinned wheel metadata mismatch: ${pin.package}/${filename}`);
  }
  const content = hashPackageContents(path.join(sitePackages, pin.package));
  if (content.fileCount !== pin.fileCount || content.contentSHA256 !== pin.contentSHA256) throw new Error(`Pinned wheel content mismatch: ${pin.package} ${pin.version}`);
  return { package: pin.package, version: pin.version, ...content };
}

function verifyMacOSPythonWheels(root, { arch } = {}) {
  if (arch === 'x64') return { skipped: true, arch };
  if (arch !== 'arm64') throw new Error(`Unsupported macOS architecture: ${arch}`);
  const sitePackages = path.join(root, 'lib', 'python3.11', 'site-packages');
  return { arch, packages: MACOS_ARM64_WHEELS.map((pin) => verifyPinnedPackage(sitePackages, pin)) };
}

function installMacOSPythonWheels({ pythonPath, sitePackagesPath, env }) {
  execFileSync(pythonPath, [
    '-m', 'pip', '--isolated', 'install', '--target', sitePackagesPath,
    '--platform', 'macosx_14_0_arm64', '--python-version', '3.11', '--implementation', 'cp', '--abi', 'cp311',
    '--no-cache-dir', '--only-binary=:all:', '--no-deps', '--require-hashes', '--no-compile', '--upgrade', '--force-reinstall',
    ...MACOS_ARM64_WHEELS.map((pin) => `${pin.url}#sha256=${pin.wheelSHA256}`),
  ], { stdio: 'inherit', env });
}

module.exports = { MACOS_ARM64_WHEELS, hashPackageContents, verifyPinnedPackage, verifyMacOSPythonWheels, installMacOSPythonWheels };
