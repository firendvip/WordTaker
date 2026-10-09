const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
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
  Object.freeze({
    package: 'torch', version: '2.10.0',
    url: 'https://files.pythonhosted.org/packages/0f/8b/4b61d6e13f7108f36910df9ab4b58fd389cc2520d54d81b88660804aad99/torch-2.10.0-2-cp311-none-macosx_11_0_arm64.whl',
    wheelSHA256: '418997cb02d0a0f1497cf6a09f63166f9f5df9f3e16c8a716ab76a72127c714f',
    fileCount: 12173, contentSHA256: '2624e7e3734ebf3da117981fc664b86d72f0600eadb2ec30ead4ef06eba5a917',
    metadataSHA256: '4b0f1217de69037355b4e582905cdb303a56a488ac6fd172f148d88fed634f54',
    wheelMetadataSHA256: '63605a8456175f09690fa641e3eb178ebe15a50cfc0580dfa5c7be51c4437956',
  }),
  Object.freeze({
    package: 'torchaudio', version: '2.10.0',
    url: 'https://files.pythonhosted.org/packages/5c/e7/401fe1d024bf9352371d854be6f339ad9928669e6bc8a5ba08e9dbce81cf/torchaudio-2.10.0-cp311-cp311-macosx_11_0_arm64.whl',
    wheelSHA256: 'bcab0e39eb18da84cba1a0c87f600abb6ce97c882200cb46e841caea106f037f',
    fileCount: 81, contentSHA256: '5fe0448748b47d90e749073ddcaf09e17e77b7650ee977614e921fee4d97753a',
    metadataSHA256: '895675159cf09e83481c0ad5bdd89b90997b233546dfc06db8cf510fd54bd76a',
    wheelMetadataSHA256: 'ab1424761111b46c49cea9d53819ee731d5a5265369f71e6bb361d967fcbc8ec',
  }),
  Object.freeze({
    package: 'torchvision', version: '0.25.0',
    url: 'https://files.pythonhosted.org/packages/3e/be/c704bceaf11c4f6b19d64337a34a877fcdfe3bd68160a8c9ae9bea4a35a3/torchvision-0.25.0-cp311-cp311-macosx_11_0_arm64.whl',
    wheelSHA256: 'db74a551946b75d19f9996c419a799ffdf6a223ecf17c656f90da011f1d75b20',
    fileCount: 195, contentSHA256: 'f9a3ba0350b8da469203ce5a464ea9010313cfcff66131ccc4aef567898fb312',
    metadataSHA256: 'b13b6c09eb07623dd666e6eebd6e4af1c9f5c922cbe8be54802aba7931df4ba4',
    wheelMetadataSHA256: '97ca4bd39bb73f302c04311f1a1ceb685a008d8bc640b3071c34540fb46fc483',
  }),
  Object.freeze({
    package: 'fsspec', version: '2026.9.0',
    url: 'https://files.pythonhosted.org/packages/6c/c0/a98505f18594f1bce828bb159cec0fcf9860562f1a2c85913409fc8f3d9e/fsspec-2026.9.0-py3-none-any.whl',
    wheelSHA256: '8dd6e646e99ea382bd85f97a45e6b526a442d79423a7dc673f1e2756d05fcb5f',
    fileCount: 58, contentSHA256: 'f66f4ee4c1d41228404ece31e02388234c949682ea0e77531a753697a2916fe6',
    metadataSHA256: '68f5a262767510638e9b1933b1493f2baadc9616fe1e696f62aedd59c8c0a37c',
    wheelMetadataSHA256: '4c769fa1bee87cdf8db2e30decc838a99c8769023b2a40fe4257106ad6215cfa',
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
  return verifyPinnedContents(sitePackages, pin);
}

function verifyPinnedContents(sitePackages, pin) {
  const expectedDistribution = `${pin.package}-${pin.version}.dist-info`;
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

function retireObsoletePinnedMetadata(sitePackages, pins = MACOS_ARM64_WHEELS) {
  regularDirectory(sitePackages);
  const obsolete = [];
  for (const pin of pins) {
    // A successful pip exit alone cannot authorize removing stale metadata.
    verifyPinnedContents(sitePackages, pin);
    for (const name of fs.readdirSync(sitePackages)) {
      if (name.startsWith(`${pin.package}-`) && name.endsWith('.dist-info') && name !== `${pin.package}-${pin.version}.dist-info`) {
        regularDirectory(path.join(sitePackages, name));
        obsolete.push(name);
      }
    }
  }
  if (!obsolete.length) return null;
  // Preserve only superseded metadata outside the packaged Python prefix.
  const retired = fs.mkdtempSync(path.join(os.tmpdir(), 'wordtaker-wheel-metadata-'));
  const moved = [];
  try {
    for (const name of obsolete) {
      fs.renameSync(path.join(sitePackages, name), path.join(retired, name));
      moved.push(name);
    }
  } catch (error) {
    for (const name of moved.reverse()) fs.renameSync(path.join(retired, name), path.join(sitePackages, name));
    throw error;
  }
  return retired;
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
  if (fs.existsSync(sitePackagesPath)) return retireObsoletePinnedMetadata(sitePackagesPath);
  return null;
}

module.exports = { MACOS_ARM64_WHEELS, hashPackageContents, verifyPinnedPackage, verifyMacOSPythonWheels, installMacOSPythonWheels, retireObsoletePinnedMetadata };
