import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const roots = [];
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const tools = () => require("../scripts/macOS-python-wheels.js");

function fixture() {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-wheel-pin-"));
  roots.push(site);
  fs.mkdirSync(path.join(site, "example"));
  fs.writeFileSync(path.join(site, "example", "__init__.py"), "# official source\n");
  fs.writeFileSync(path.join(site, "example", "engine.so"), "official native bytes");
  const metadata = "Name: example\nVersion: 1.0.0\n";
  const wheel = "Wheel-Version: 1.0\nTag: cp311-cp311-macosx_14_0_arm64\n";
  const dist = path.join(site, "example-1.0.0.dist-info");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "METADATA"), metadata);
  fs.writeFileSync(path.join(dist, "WHEEL"), wheel);
  const content = `${sha("# official source\n")}  __init__.py\n${sha("official native bytes")}  engine.so\n`;
  return { site, dist, pin: { package: "example", version: "1.0.0", fileCount: 2, contentSHA256: sha(content), metadataSHA256: sha(metadata), wheelMetadataSHA256: sha(wheel) } };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete require.cache[require.resolve("../scripts/macOS-python-wheels.js")];
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("official macOS arm64 wheel freeze", () => {
  it("pins the reviewed ABI family and only the three authorized HTTP updates", () => {
    const pins = tools().MACOS_ARM64_WHEELS;
    expect(pins.map((pin) => [pin.package, pin.version])).toEqual([["onnxruntime", "1.31.0"], ["scipy", "1.17.1"], ["torch", "2.10.0"], ["torchaudio", "2.10.0"], ["torchvision", "0.25.0"], ["fsspec", "2026.9.0"], ["requests", "2.34.2"], ["urllib3", "2.8.0"], ["certifi", "2026.6.17"]]);
    for (const pin of pins) {
      expect(new URL(pin.url).hostname).toBe("files.pythonhosted.org");
      expect(pin.wheelSHA256).toMatch(/^[a-f0-9]{64}$/);
      expect(pin.contentSHA256).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.isFrozen(pin)).toBe(true);
    }
    expect(Object.isFrozen(pins)).toBe(true);
    expect(pins.slice(-3).every((pin) => pin.url.endsWith('-py3-none-any.whl'))).toBe(true);
    const constraints = fs.readFileSync(new URL('../scripts/macOS-arm64-python-constraints.txt', import.meta.url), 'utf8');
    for (const pin of pins.slice(-3)) expect(constraints.split(/\r?\n/)).toContain(`${pin.package}==${pin.version}`);
    expect(pins.some((pin) => ['idna', 'charset_normalizer', 'modelscope', 'llama_cpp'].includes(pin.package))).toBe(false);
  });

  it("ships the literal punctuation adapter beside the unpacked Python entrypoint", () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.build.files).toContain('funasr_punctuation.py');
    expect(manifest.build.asarUnpack).toContain('funasr_punctuation.py');
    expect(manifest.version).toBe('1.29.5');
    expect(manifest.build.mac.minimumSystemVersion).toBe('14.0');
  });

  it("hashes exact installed package files in deterministic path order", () => {
    const { site, pin } = fixture();
    expect(tools().hashPackageContents(path.join(site, "example"))).toEqual({ fileCount: 2, contentSHA256: pin.contentSHA256 });
    expect(tools().verifyPinnedPackage(site, pin)).toMatchObject({ package: "example", version: "1.0.0", fileCount: 2 });
  });

  it.each(["__init__.py", "engine.so"])("rejects changed %s even when version metadata and imports could pass", (filename) => {
    const { site, pin } = fixture();
    fs.writeFileSync(path.join(site, "example", filename), "changed bytes");
    expect(() => tools().verifyPinnedPackage(site, pin)).toThrow(/content|字节/i);
  });

  it.each(["unexpected.so", "__pycache__/cached.pyc"])("rejects stale or injected %s rather than trusting dist-info", (filename) => {
    const { site, pin } = fixture();
    fs.mkdirSync(path.dirname(path.join(site, "example", filename)), { recursive: true });
    fs.writeFileSync(path.join(site, "example", filename), "unexpected bytes");
    expect(() => tools().verifyPinnedPackage(site, pin)).toThrow(/content|字节/i);
  });

  it.each(["METADATA", "WHEEL"])("rejects modified or incompatible %s", (filename) => {
    const { site, dist, pin } = fixture();
    fs.appendFileSync(path.join(dist, filename), "wrong version or target\n");
    expect(() => tools().verifyPinnedPackage(site, pin)).toThrow(/metadata|元数据/i);
  });

  it("rejects missing or duplicate distribution metadata", () => {
    const { site, dist, pin } = fixture();
    fs.mkdirSync(path.join(site, "example-0.9.0.dist-info"));
    expect(() => tools().verifyPinnedPackage(site, pin)).toThrow(/distribution|版本/i);
    fs.rmSync(path.join(site, "example-0.9.0.dist-info"), { recursive: true });
    fs.rmSync(dist, { recursive: true });
    expect(() => tools().verifyPinnedPackage(site, pin)).toThrow(/distribution|版本/i);
  });

  it("rejects package and metadata symlinks, including internal aliases", () => {
    const { site, dist, pin } = fixture();
    fs.symlinkSync("engine.so", path.join(site, "example", "alias.so"));
    expect(() => tools().verifyPinnedPackage(site, pin)).toThrow(/symlink|链接/i);
    fs.unlinkSync(path.join(site, "example", "alias.so"));
    fs.renameSync(dist, `${dist}.saved`);
    fs.symlinkSync(`${dist}.saved`, dist);
    expect(() => tools().verifyPinnedPackage(site, pin)).toThrow(/symlink|链接/i);
  });

  it("rejects a missing package and propagates filesystem failures", () => {
    const { site, pin } = fixture();
    fs.rmSync(path.join(site, "example"), { recursive: true });
    expect(() => tools().verifyPinnedPackage(site, pin)).toThrow();
    expect(() => tools().hashPackageContents(path.join(site, "missing"))).toThrow();
  });

  it("does not apply arm64 wheel pins to x64, or silently accept an unknown architecture", () => {
    expect(tools().verifyMacOSPythonWheels("unused", { arch: "x64" })).toEqual({ skipped: true, arch: "x64" });
    expect(() => tools().verifyMacOSPythonWheels("unused", { arch: "ia32" })).toThrow(/architecture/);
    expect(() => tools().verifyMacOSPythonWheels("missing", { arch: "arm64" })).toThrow();
  });

  it("installs exact hashed URLs for cp311/macOS14 arm64, without a dependency resolver or compilation", () => {
    const { site } = fixture();
    const exec = vi.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.alloc(0));
    // No production package is installed by this spy: do not run retirement.
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    tools().installMacOSPythonWheels({ pythonPath: "/python path/bin/python3.11", sitePackagesPath: site, env: { PYTHONHOME: "/prefix" } });
    exists.mockRestore();
    expect(exec).toHaveBeenCalledTimes(1);
    const [binary, args, options] = exec.mock.calls[0];
    expect(binary).toBe("/python path/bin/python3.11");
    for (const flag of ["--no-deps", "--require-hashes", "--no-compile", "--only-binary=:all:", "--no-cache-dir", "--upgrade", "--force-reinstall", "--isolated"]) expect(args).toContain(flag);
    expect(args.slice(args.indexOf("--platform"), args.indexOf("--platform") + 2)).toEqual(["--platform", "macosx_14_0_arm64"]);
    expect(args.slice(args.indexOf("--python-version"), args.indexOf("--python-version") + 2)).toEqual(["--python-version", "3.11"]);
    expect(args.slice(args.indexOf("--target"), args.indexOf("--target") + 2)).toEqual(["--target", site]);
    for (const pin of tools().MACOS_ARM64_WHEELS) expect(args).toContain(`${pin.url}#sha256=${pin.wheelSHA256}`);
    expect(options).toMatchObject({ stdio: "inherit", env: { PYTHONHOME: "/prefix" } });
  });

  it("does not retry a hash or installation failure with unpinned wheels", () => {
    const exec = vi.spyOn(childProcess, "execFileSync").mockImplementation(() => { throw new Error("hash mismatch"); });
    expect(() => tools().installMacOSPythonWheels({ pythonPath: "python", sitePackagesPath: "site", env: {} })).toThrow("hash mismatch");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("retires only obsolete pinned metadata after verifying the new official bytes, without deleting it", () => {
    const { site, pin } = fixture();
    fs.mkdirSync(path.join(site, "example-0.9.0.dist-info"));
    fs.writeFileSync(path.join(site, "example-0.9.0.dist-info", "METADATA"), "old metadata");
    fs.mkdirSync(path.join(site, "unrelated-0.1.dist-info"));
    const retired = tools().retireObsoletePinnedMetadata(site, [pin]);
    roots.push(retired);
    expect(fs.readFileSync(path.join(retired, "example-0.9.0.dist-info", "METADATA"), "utf8")).toBe("old metadata");
    expect(fs.existsSync(path.join(site, "unrelated-0.1.dist-info"))).toBe(true);
    expect(tools().verifyPinnedPackage(site, pin)).toMatchObject({ version: "1.0.0" });
    expect(tools().retireObsoletePinnedMetadata(site, [pin])).toBe(null);
  });

  it("leaves old metadata in place if new wheel bytes fail verification", () => {
    const { site, pin } = fixture();
    fs.mkdirSync(path.join(site, "example-0.9.0.dist-info"));
    fs.writeFileSync(path.join(site, "example", "engine.so"), "wrong bytes");
    expect(() => tools().retireObsoletePinnedMetadata(site, [pin])).toThrow(/content/);
    expect(fs.existsSync(path.join(site, "example-0.9.0.dist-info"))).toBe(true);
  });

  it("rejects stale metadata symlinks before moving anything", () => {
    const { site, dist, pin } = fixture();
    fs.symlinkSync(dist, path.join(site, "example-0.9.0.dist-info"));
    expect(() => tools().retireObsoletePinnedMetadata(site, [pin])).toThrow(/symlink/);
    expect(fs.lstatSync(path.join(site, "example-0.9.0.dist-info")).isSymbolicLink()).toBe(true);
  });
});
