const fs = require('fs');
const path = require('path');

const CPU_TYPES = { arm64: 0x0100000c, x64: 0x01000007 };
const MACH_O_MAGICS = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'cafebabf', 'bebafeca', 'bfbafeca']);
const MINIMUM_MAC_OS = require('../package.json').build.mac.minimumSystemVersion;

function packedVersion(value) {
  return `${value >>> 16}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}

function versionNumber(version) {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error(`Invalid macOS version: ${version}`);
  const [major, minor, patch = 0] = version.split('.').map(Number);
  if (major > 0xffff || minor > 0xff || patch > 0xff) throw new Error(`Invalid macOS version: ${version}`);
  return major * 65536 + minor * 256 + patch;
}

function malformed(message) { throw new Error(`Invalid Mach-O: ${message}`); }

function parseThin(bytes, arch) {
  const magic = bytes.subarray(0, 4).toString('hex');
  const littleEndian = magic === 'cefaedfe' || magic === 'cffaedfe';
  const is64 = magic === 'feedfacf' || magic === 'cffaedfe';
  if (!['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe'].includes(magic)) malformed('invalid thin header');
  if (!is64) malformed(`32-bit header does not match target architecture ${arch}`);
  const headerSize = is64 ? 32 : 28;
  if (bytes.length < headerSize) malformed('truncated header');
  const read = (offset) => bytes[littleEndian ? 'readUInt32LE' : 'readUInt32BE'](offset);
  if (read(4) !== CPU_TYPES[arch]) malformed(`missing target architecture ${arch}`);
  const count = read(16);
  const commandBytes = read(20);
  const end = headerSize + commandBytes;
  if (end > bytes.length || count > commandBytes / 8) malformed('truncated load commands');
  const minimums = [];
  let cursor = headerSize;
  for (let index = 0; index < count; index++) {
    if (cursor + 8 > end) malformed('truncated load command');
    const command = read(cursor);
    const size = read(cursor + 4);
    if (size < 8 || size % 4 !== 0 || cursor + size > end) malformed('invalid load-command size');
    if (command === 0x32) {
      if (size < 24 || 24 + read(cursor + 20) * 8 > size) malformed('invalid LC_BUILD_VERSION');
      if (read(cursor + 8) !== 1) throw new Error('Mach-O LC_BUILD_VERSION is not macOS');
      minimums.push(read(cursor + 12));
    } else if (command === 0x24) {
      if (size < 16) malformed('invalid LC_VERSION_MIN_MACOSX');
      minimums.push(read(cursor + 8));
    }
    cursor += size;
  }
  if (cursor !== end) malformed('load-command length mismatch');
  if (minimums.length === 0 || minimums.some((value) => value === 0)) throw new Error('Mach-O missing macOS minimum version');
  return { arch, minimumVersion: packedVersion(Math.max(...minimums)) };
}

function parseMachO(bytes, arch) {
  if (!Object.hasOwn(CPU_TYPES, arch)) throw new Error(`Unsupported macOS architecture: ${arch}`);
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) malformed('missing magic');
  const magic = bytes.subarray(0, 4).toString('hex');
  if (!MACH_O_MAGICS.has(magic)) malformed('unrecognized magic');
  if (!['cafebabe', 'cafebabf', 'bebafeca', 'bfbafeca'].includes(magic)) return parseThin(bytes, arch);
  const littleEndian = magic === 'bebafeca' || magic === 'bfbafeca';
  const is64 = magic === 'cafebabf' || magic === 'bfbafeca';
  if (bytes.length < 8) malformed('truncated fat header');
  const read = (offset) => bytes[littleEndian ? 'readUInt32LE' : 'readUInt32BE'](offset);
  const readOffset = (offset) => {
    const value = is64 ? Number(bytes[littleEndian ? 'readBigUInt64LE' : 'readBigUInt64BE'](offset)) : read(offset);
    if (!Number.isSafeInteger(value)) malformed('unsafe fat offset');
    return value;
  };
  const count = read(4);
  const entrySize = is64 ? 32 : 20;
  const tableEnd = 8 + count * entrySize;
  if (count === 0 || count > 64 || tableEnd > bytes.length) malformed('invalid fat architecture table');
  const ranges = [];
  const selected = [];
  for (let index = 0; index < count; index++) {
    const start = 8 + index * entrySize;
    const offset = readOffset(start + 8);
    const size = readOffset(start + (is64 ? 16 : 12));
    if (offset < tableEnd || size < 4 || offset + size > bytes.length || ranges.some((range) => offset < range.end && offset + size > range.start)) malformed('invalid fat slice bounds');
    ranges.push({ start: offset, end: offset + size });
    if (read(start) === CPU_TYPES[arch]) selected.push(parseThin(bytes.subarray(offset, offset + size), arch));
  }
  if (selected.length === 0) malformed(`missing target architecture ${arch}`);
  return { arch, minimumVersion: packedVersion(Math.max(...selected.map((slice) => versionNumber(slice.minimumVersion)))) };
}

function verifyMacOSRuntime(root, { arch, minimumVersion = MINIMUM_MAC_OS, requiredFiles = ['bin/python3.11'] } = {}) {
  if (!Object.hasOwn(CPU_TYPES, arch)) throw new Error(`Unsupported macOS architecture: ${arch}`);
  const maximum = versionNumber(minimumVersion);
  const realRoot = fs.realpathSync(root);
  if (!fs.statSync(realRoot).isDirectory()) throw new Error(`macOS runtime is not a directory: ${root}`);
  const records = [];
  function inspect(filename) {
    const result = parseMachO(fs.readFileSync(filename), arch);
    if (versionNumber(result.minimumVersion) > maximum) throw new Error(`macOS ${result.minimumVersion} required by ${filename}; declared target is ${minimumVersion}`);
    records.push({ path: path.relative(realRoot, filename), ...result });
  }
  for (const required of requiredFiles) {
    const filename = path.resolve(realRoot, required);
    if (!filename.startsWith(`${realRoot}${path.sep}`) || !fs.statSync(filename).isFile()) throw new Error(`Missing macOS runtime file: ${required}`);
    if (!fs.realpathSync(filename).startsWith(`${realRoot}${path.sep}`)) throw new Error(`macOS runtime symlink escapes root: ${filename}`);
    inspect(filename);
  }
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(filename);
        if (!target.startsWith(`${realRoot}${path.sep}`)) throw new Error(`macOS runtime symlink escapes root: ${filename}`);
        continue;
      }
      if (entry.isDirectory()) { walk(filename); continue; }
      if (!entry.isFile() || records.some((record) => record.path === path.relative(realRoot, filename))) continue;
      const fd = fs.openSync(filename, 'r');
      const header = Buffer.alloc(4);
      try { fs.readSync(fd, header, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (MACH_O_MAGICS.has(header.toString('hex')) || /\.(?:so|dylib|node)$/.test(filename)) inspect(filename);
    }
  }
  walk(realRoot);
  if (records.length === 0) throw new Error('No macOS runtime binaries found');
  return { arch, minimumVersion, binariesChecked: records.length, binaries: records };
}

module.exports = { MINIMUM_MAC_OS, parseMachO, verifyMacOSRuntime };
