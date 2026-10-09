import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tempDirectories = [];
const cpuTypes = { arm64: 0x0100000c, x64: 0x01000007 };

function thin(version = "12.0", { arch = "arm64", legacy = false, bigEndian = false, platform = 1 } = {}) {
  const bytes = Buffer.alloc(32 + (legacy ? 16 : 24));
  const write = (value, offset) => bytes[bigEndian ? "writeUInt32BE" : "writeUInt32LE"](value, offset);
  const [major, minor = 0, patch = 0] = version.split(".").map(Number);
  write(0xfeedfacf, 0);
  write(cpuTypes[arch], 4);
  write(6, 12);
  write(1, 16);
  write(bytes.length - 32, 20);
  write(legacy ? 0x24 : 0x32, 32);
  write(bytes.length - 32, 36);
  if (!legacy) write(platform, 40);
  write((major << 16) | (minor << 8) | patch, legacy ? 40 : 44);
  return bytes;
}

function fat(slices, { fat64 = false, littleEndian = false } = {}) {
  const entrySize = fat64 ? 32 : 20;
  const headerSize = 8 + slices.length * entrySize;
  const bytes = Buffer.alloc(headerSize + slices.reduce((sum, slice) => sum + slice.bytes.length, 0));
  const write = (value, offset) => bytes[littleEndian ? "writeUInt32LE" : "writeUInt32BE"](value, offset);
  const write64 = (value, offset) => bytes[littleEndian ? "writeBigUInt64LE" : "writeBigUInt64BE"](BigInt(value), offset);
  write(fat64 ? 0xcafebabf : 0xcafebabe, 0);
  write(slices.length, 4);
  let offset = headerSize;
  slices.forEach((slice, index) => {
    const start = 8 + index * entrySize;
    write(cpuTypes[slice.arch], start);
    if (fat64) { write64(offset, start + 8); write64(slice.bytes.length, start + 16); }
    else { write(offset, start + 8); write(slice.bytes.length, start + 12); }
    slice.bytes.copy(bytes, offset);
    offset += slice.bytes.length;
  });
  return bytes;
}

function directory(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-mac-runtime-"));
  tempDirectories.push(root);
  for (const [name, bytes] of Object.entries(files)) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
    fs.chmodSync(filename, 0o755);
  }
  return root;
}

function tools() { return require("../scripts/macOS-runtime-compatibility.js"); }

afterEach(() => {
  vi.restoreAllMocks();
  delete require.cache[require.resolve("../scripts/prepare-embedded-python.js")];
  delete require.cache[require.resolve("../scripts/verify-sensevoice-pack.js")];
  for (const dir of tempDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("macOS target binary metadata", () => {
  it.each([{ legacy: false }, { legacy: true }, { bigEndian: true }])("parses real minimum-system load commands: %j", (options) => {
    expect(tools().parseMachO(thin("12.3.1", options), "arm64").minimumVersion).toBe("12.3.1");
  });

  it.each([{ fat64: false }, { fat64: true }, { littleEndian: true }])("selects the actual arm64 slice in fat binaries: %j", (options) => {
    const bytes = fat([{ arch: "x64", bytes: thin("14.0", { arch: "x64" }) }, { arch: "arm64", bytes: thin("11.0") }], options);
    expect(tools().parseMachO(bytes, "arm64").minimumVersion).toBe("11.0.0");
    expect(tools().parseMachO(bytes, "x64").minimumVersion).toBe("14.0.0");
  });

  it("does not accept an absent target architecture", () => {
    expect(() => tools().parseMachO(thin("12.0", { arch: "x64" }), "arm64")).toThrow(/arm64/);
  });

  it("rejects a 32-bit header falsely declaring a 64-bit target CPU", () => {
    const original = thin("10.13", { legacy: true });
    const bytes = Buffer.concat([original.subarray(0, 28), original.subarray(32)]);
    bytes.writeUInt32LE(0xfeedface, 0);
    expect(() => tools().parseMachO(bytes, "arm64")).toThrow(/Mach-O/);
  });

  it("rejects malformed fat counts, overlaps and unsafe 64-bit offsets", () => {
    const empty = fat([{ arch: "arm64", bytes: thin() }]); empty.writeUInt32BE(0, 4);
    expect(() => tools().parseMachO(empty, "arm64")).toThrow(/Mach-O/);
    const overlap = fat([{ arch: "arm64", bytes: thin() }, { arch: "x64", bytes: thin("12.0", { arch: "x64" }) }]);
    overlap.writeUInt32BE(overlap.readUInt32BE(16), 36);
    expect(() => tools().parseMachO(overlap, "arm64")).toThrow(/Mach-O/);
    const unsafe = fat([{ arch: "arm64", bytes: thin() }], { fat64: true }); unsafe.writeBigUInt64BE(0xffffffffffffffffn, 16);
    expect(() => tools().parseMachO(unsafe, "arm64")).toThrow(/Mach-O/);
  });

  it.each([Buffer.alloc(0), Buffer.from("not Mach-O"), thin().subarray(0, 31), thin().subarray(0, 40)])("rejects empty, nonbinary and truncated data", (bytes) => {
    expect(() => tools().parseMachO(bytes, "arm64")).toThrow(/Mach-O/);
  });

  it("rejects invalid load-command sizes and missing system metadata", () => {
    const invalid = thin(); invalid.writeUInt32LE(0, 36);
    expect(() => tools().parseMachO(invalid, "arm64")).toThrow(/Mach-O/);
    const missing = thin(); missing.writeUInt32LE(0x1, 32);
    expect(() => tools().parseMachO(missing, "arm64")).toThrow(/minimum|最低/i);
  });

  it("rejects a non-macOS LC_BUILD_VERSION instead of borrowing its version", () => {
    expect(() => tools().parseMachO(thin("11.0", { platform: 2 }), "arm64")).toThrow(/macOS/);
  });

  it("rejects fat offset corruption and architecture-table spoofing", () => {
    const invalid = fat([{ arch: "arm64", bytes: thin() }]); invalid.writeUInt32BE(0xffffffff, 16);
    expect(() => tools().parseMachO(invalid, "arm64")).toThrow(/Mach-O/);
    const spoofed = fat([{ arch: "arm64", bytes: thin("12.0", { arch: "x64" }) }]);
    expect(() => tools().parseMachO(spoofed, "arm64")).toThrow(/Mach-O|arm64/);
  });
});

describe("runtime and packed-resource gates", () => {
  const options = { arch: "arm64", minimumVersion: "12.0", requiredFiles: ["bin/python3.11"] };
  it("uses the approved product minimum without changing the candidate version", () => {
    expect(tools().MINIMUM_MAC_OS).toBe("14.0");
    expect(require("../package.json").version).toBe("1.29.5");
  });

  it("accepts actual macOS 14 libraries with the product default gate", () => {
    const root = directory({ "bin/python3.11": thin("11.0"), "lib/engine.so": thin("14.0") });
    expect(tools().verifyMacOSRuntime(root, { arch: "arm64" }).minimumVersion).toBe("14.0");
  });

  it("does not round 14.0.1 or 14.1 down to the approved 14.0 minimum", () => {
    for (const version of ["14.0.1", "14.1"]) {
      const root = directory({ "bin/python3.11": thin("11.0"), "lib/engine.so": thin(version) });
      expect(() => tools().verifyMacOSRuntime(root, { arch: "arm64" })).toThrow(/14\.0\.1|14\.1/);
    }
  });

  it("accepts compatible libraries independently of the host operating system", () => {
    const root = directory({ "bin/python3.11": thin("11.0"), "lib/engine.so": thin("12.0"), "README.txt": "text" });
    expect(tools().verifyMacOSRuntime(root, options).binariesChecked).toBe(2);
  });

  it("rejects a loadable-on-new-host runtime requiring macOS 14", () => {
    const root = directory({ "bin/python3.11": thin("11.0"), "lib/engine.so": thin("14.0") });
    expect(() => tools().verifyMacOSRuntime(root, options)).toThrow(/14\.0.*12\.0|12\.0.*14\.0/);
  });

  it("also rejects a wheel tagged 12 when its actual library requires 12.3", () => {
    const root = directory({ "bin/python3.11": thin("11.0"), "lib/engine.so": thin("12.3") });
    expect(() => tools().verifyMacOSRuntime(root, options)).toThrow(/12\.3.*12\.0|12\.0.*12\.3/);
  });

  it("accepts internal runtime symlinks without following cycles or host libraries", () => {
    const root = directory({ "bin/python3.11": thin("11.0"), "lib/engine.so": thin("12.0") });
    fs.symlinkSync("engine.so", path.join(root, "lib", "alias.so"));
    expect(tools().verifyMacOSRuntime(root, options).binariesChecked).toBe(2);
  });

  it("rejects invalid versions, architecture, paths and an empty binary inspection", () => {
    const root = directory({ "bin/python3.11": thin("11.0") });
    expect(() => tools().verifyMacOSRuntime(root, { ...options, arch: "ia32" })).toThrow(/architecture/);
    for (const minimumVersion of ["12", "12.300", "65536.0"]) {
      expect(() => tools().verifyMacOSRuntime(root, { ...options, minimumVersion })).toThrow(/version/);
    }
    expect(() => tools().verifyMacOSRuntime(root, { ...options, requiredFiles: ["../outside"] })).toThrow();
    expect(() => tools().verifyMacOSRuntime(directory(), { ...options, requiredFiles: [] })).toThrow(/No macOS/);
  });

  it.each([{ "bin/python3.11": thin(), "lib/engine.so": "damaged" }, { "bin/python3.11": thin().subarray(0, 20) }, {}])("fails closed for damaged or missing runtime files", (files) => {
    expect(() => tools().verifyMacOSRuntime(directory(files), options)).toThrow();
  });

  it("propagates filesystem inspection failures", () => {
    expect(() => tools().verifyMacOSRuntime(path.join(directory(), "missing"), options)).toThrow();
    const root = directory({ "bin/python3.11": thin() });
    vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("read failure"); });
    expect(() => tools().verifyMacOSRuntime(root, options)).toThrow("read failure");
  });

  it("refuses symlink escapes instead of validating a host runtime", () => {
    const root = directory({ "bin/python3.11": thin() });
    const outside = directory({ "engine.so": thin() });
    fs.symlinkSync(path.join(outside, "engine.so"), path.join(root, "escaped.so"));
    expect(() => tools().verifyMacOSRuntime(root, options)).toThrow(/symlink|链接/i);
  });

  it("cached imports succeeding on the host cannot override the target gate", async () => {
    const exec = vi.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.from("numpy OK\ntorch OK\nlibrosa OK\nfunasr OK\nonnxruntime OK\nsoundfile OK\n"));
    const Builder = require("../scripts/prepare-embedded-python.js");
    const builder = new Builder();
    builder.targetPlatform = "darwin"; builder.targetArch = "arm64"; builder.crossPrep = false;
    builder.pythonDir = directory({ "bin/python3.11": thin("11.0"), "lib/engine.so": thin("14.1") });
    expect(await builder.validateExistingEnvironment(builder.pythonExecPath())).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("still requires real import success after compatible cache metadata", async () => {
    vi.spyOn(require("../scripts/macOS-python-wheels.js"), "verifyMacOSPythonWheels").mockReturnValue({ packages: [] });
    const exec = vi.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.from("numpy OK\ntorch OK\nlibrosa OK\nfunasr OK\nonnxruntime OK\nsoundfile OK\n"));
    const Builder = require("../scripts/prepare-embedded-python.js");
    const builder = new Builder();
    builder.targetPlatform = "darwin"; builder.targetArch = "arm64"; builder.crossPrep = false;
    builder.pythonDir = directory({ "bin/python3.11": thin("11.0"), "lib/engine.so": thin("12.0") });
    expect(await builder.validateExistingEnvironment(builder.pythonExecPath())).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    exec.mockImplementation(() => { throw new Error("native import failure"); });
    expect(await builder.validateExistingEnvironment(builder.pythonExecPath())).toBe(false);
    exec.mockReturnValue(Buffer.from("numpy OK\n"));
    expect(await builder.validateExistingEnvironment(builder.pythonExecPath())).toBe(false);
  });

  it("rejects an unpinned macOS cache before attempting imports", async () => {
    vi.spyOn(require("../scripts/macOS-runtime-compatibility.js"), "verifyMacOSRuntime").mockReturnValue({ binariesChecked: 1 });
    vi.spyOn(require("../scripts/macOS-python-wheels.js"), "verifyMacOSPythonWheels").mockImplementation(() => { throw new Error("Pinned wheel content mismatch"); });
    const exec = vi.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.from("numpy OK\ntorch OK\nlibrosa OK\nfunasr OK\nonnxruntime OK\nsoundfile OK\n"));
    const Builder = require("../scripts/prepare-embedded-python.js");
    const builder = new Builder();
    builder.targetPlatform = "darwin"; builder.targetArch = "arm64"; builder.crossPrep = false;
    builder.pythonDir = directory({ "bin/python3.11": thin("11.0") });
    expect(await builder.validateExistingEnvironment(builder.pythonExecPath())).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("installs the reviewed native pins after legacy and Metal dependencies, then verifies", async () => {
    const order = [];
    vi.spyOn(require("../scripts/macOS-python-wheels.js"), "installMacOSPythonWheels").mockImplementation(() => { order.push("pins"); });
    const Builder = require("../scripts/prepare-embedded-python.js");
    const builder = new Builder();
    builder.targetPlatform = "darwin"; builder.targetArch = "arm64"; builder.isArm64 = true; builder.onnxOnly = false;
    builder.pythonDir = directory();
    vi.spyOn(builder, "installDependenciesNative").mockImplementation(async () => { order.push("legacy"); });
    vi.spyOn(builder, "installLlamaCppMetal").mockImplementation(async () => { order.push("metal"); });
    vi.spyOn(builder, "verifyDependencies").mockImplementation(async () => { order.push("verify"); });
    await builder.installDependencies();
    expect(order).toEqual(["legacy", "metal", "pins", "verify"]);
  });

  it("constrains transitive native resolution only for macOS arm64", async () => {
    const exec = vi.spyOn(childProcess, "execSync").mockReturnValue(Buffer.alloc(0));
    const Builder = require("../scripts/prepare-embedded-python.js");
    const builder = new Builder();
    builder.pythonDir = directory();
    builder.targetPlatform = "darwin"; builder.targetArch = "arm64";
    await builder.installDependenciesNative("python", "site", [{ spec: "librosa>=0.11.0" }]);
    const installs = exec.mock.calls.filter(([cmd]) => cmd.includes('--target'));
    expect(installs).toHaveLength(2);
    for (const [cmd] of installs) expect(cmd).toContain("macOS-arm64-python-constraints.txt");
    const constraints = fs.readFileSync(path.join(path.dirname(require.resolve("../scripts/prepare-embedded-python.js")), "macOS-arm64-python-constraints.txt"), "utf8");
    expect(constraints.trim().split("\n")).toEqual(["onnxruntime==1.31.0", "scipy==1.17.1"]);
    exec.mockClear();
    builder.targetPlatform = "win32";
    await builder.installDependenciesNative("python", "site", [{ spec: "numpy>=2.3.0" }]);
    for (const [cmd] of exec.mock.calls) expect(cmd).not.toContain("macOS-arm64-python-constraints.txt");
  });

  it("the Python test executable check also enforces target bytes and wheel contents", async () => {
    const native = vi.spyOn(require("../scripts/macOS-runtime-compatibility.js"), "verifyMacOSRuntime").mockReturnValue({ binariesChecked: 1 });
    const wheels = vi.spyOn(require("../scripts/macOS-python-wheels.js"), "verifyMacOSPythonWheels").mockImplementation(() => { throw new Error("Pinned wheel content mismatch"); });
    delete require.cache[require.resolve("../scripts/test-embedded-python.js")];
    const Tester = require("../scripts/test-embedded-python.js");
    const tester = new Tester();
    tester.targetPlatform = "darwin"; tester.targetArch = "arm64";
    tester.pythonDir = directory({ "bin/python3.11": thin("11.0") });
    tester.pythonPath = path.join(tester.pythonDir, "bin/python3.11");
    await expect(tester.testPythonExecutable()).rejects.toThrow("Pinned wheel content mismatch");
    expect(native).toHaveBeenCalledExactlyOnceWith(tester.pythonDir, { arch: "arm64" });
    expect(wheels).toHaveBeenCalledExactlyOnceWith(tester.pythonDir, { arch: "arm64" });
  });

  it("afterPack blocks unpinned Python contents despite compatible Mach-O and valid models", async () => {
    vi.spyOn(require("../scripts/sensevoice-model.js"), "verifyModelDirectory").mockResolvedValue({ ok: true, invalid: [] });
    vi.spyOn(require("../scripts/macOS-runtime-compatibility.js"), "verifyMacOSRuntime").mockReturnValue({ binariesChecked: 1 });
    vi.spyOn(require("../scripts/macOS-python-wheels.js"), "verifyMacOSPythonWheels").mockImplementation(() => { throw new Error("Pinned wheel content mismatch"); });
    const afterPack = require("../scripts/verify-sensevoice-pack.js");
    await expect(afterPack({ electronPlatformName: "darwin", arch: 3, appOutDir: directory(), packager: { appInfo: { productFilename: "弦外小猫" } } })).rejects.toThrow("Pinned wheel content mismatch");
  });

  it("does not add macOS metadata requirements to the Windows runtime", async () => {
    vi.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.from("numpy OK\nonnxruntime OK\nsoundfile OK\nllama_cpp OK\n"));
    const Builder = require("../scripts/prepare-embedded-python.js");
    const builder = new Builder();
    builder.targetPlatform = "win32"; builder.targetArch = "x64";
    builder.isWindows = true; builder.isArm64 = false; builder.onnxOnly = true; builder.crossPrep = false;
    builder.pythonDir = directory({ "python.exe": "PE fixture" });
    expect(await builder.validateExistingEnvironment(builder.pythonExecPath())).toBe(true);
  });

  it("afterPack rejects incompatible actual Python bytes even if models are valid", async () => {
    vi.spyOn(require("../scripts/sensevoice-model.js"), "verifyModelDirectory").mockResolvedValue({ ok: true, invalid: [] });
    const root = directory({ "弦外小猫.app/Contents/Resources/app.asar.unpacked/python/bin/python3.11": thin("11.0"), "弦外小猫.app/Contents/Resources/app.asar.unpacked/python/lib/engine.so": thin("14.1") });
    const afterPack = require("../scripts/verify-sensevoice-pack.js");
    await expect(afterPack({ electronPlatformName: "darwin", arch: 3, appOutDir: root, packager: { appInfo: { productFilename: "弦外小猫" } } })).rejects.toThrow(/14\.1.*14\.0|14\.0.*14\.1/);
  });
});
