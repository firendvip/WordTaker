import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { EventEmitter } from "events";
import { PassThrough } from "stream";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..");
const modelToolsPath = path.join(projectRoot, "scripts", "sensevoice-model.js");
const require = createRequire(import.meta.url);

const temporaryDirectories = [];

function makeTempDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-sensevoice-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

afterEach(() => {
  vi.restoreAllMocks();
  delete require.cache[require.resolve("../scripts/verify-sensevoice-pack.js")];
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("SenseVoice model preparation", () => {
  it("pins the official ONNX snapshot and every runtime file by size and SHA-256", async () => {
    const { SENSEVOICE_MODEL_MANIFEST } = await import(modelToolsPath);

    expect(SENSEVOICE_MODEL_MANIFEST.modelId).toBe("iic/SenseVoiceSmall-onnx");
    expect(SENSEVOICE_MODEL_MANIFEST.revision).toBe("v2.0.5");
    expect(SENSEVOICE_MODEL_MANIFEST.files).toEqual([
      { name: "model_quant.onnx", size: 241216270, sha256: "21dc965f689a78d1604717bf561e40d5a236087c85a95584567835750549e822" },
      { name: "tokens.json", size: 352064, sha256: "a2594fc1474e78973149cba8cd1f603ebed8c39c7decb470631f66e70ce58e97" },
      { name: "config.yaml", size: 1855, sha256: "f71e239ba36705564b5bf2d2ffd07eece07b8e3f2bbf6d2c99d8df856339ac19" },
      { name: "am.mvn", size: 11203, sha256: "29b3c740a2c0cfc6b308126d31d7f265fa2be74f3bb095cd2f143ea970896ae5" },
    ]);
  });

  it("detects missing and corrupt files without accepting a partial model", async () => {
    const { verifyModelDirectory } = await import(modelToolsPath);
    const modelDir = makeTempDir();
    const fixtures = [
      { name: "model_quant.onnx", content: "onnx" },
      { name: "tokens.json", content: "[]" },
      { name: "config.yaml", content: "frontend: WavFrontend\n" },
      { name: "am.mvn", content: "cmvn" },
    ];
    const manifest = {
      files: fixtures.map(({ name, content }) => ({
        name,
        size: Buffer.byteLength(content),
        sha256: sha256(content),
      })),
    };

    for (const fixture of fixtures) {
      fs.writeFileSync(path.join(modelDir, fixture.name), fixture.content);
    }
    expect((await verifyModelDirectory(modelDir, manifest)).ok).toBe(true);

    fs.writeFileSync(path.join(modelDir, "tokens.json"), "corrupt");
    const corrupt = await verifyModelDirectory(modelDir, manifest);
    expect(corrupt.ok).toBe(false);
    expect(corrupt.invalid).toEqual([
      expect.objectContaining({ name: "tokens.json", reason: "size-mismatch" }),
    ]);

    fs.rmSync(path.join(modelDir, "am.mvn"));
    const incomplete = await verifyModelDirectory(modelDir, manifest);
    expect(incomplete.ok).toBe(false);
    expect(incomplete.invalid).toContainEqual(
      expect.objectContaining({ name: "am.mvn", reason: "missing" }),
    );
  });

  it("reuses a verified local model and never invokes the downloader", async () => {
    const { prepareModelDirectory } = await import(modelToolsPath);
    const modelDir = makeTempDir();
    const content = "already-valid";
    const manifest = {
      modelId: "fixture/model",
      revision: "fixture-revision",
      files: [{ name: "model_quant.onnx", size: content.length, sha256: sha256(content) }],
    };
    fs.writeFileSync(path.join(modelDir, "model_quant.onnx"), content);
    const downloader = vi.fn();

    const result = await prepareModelDirectory(modelDir, { manifest, downloader });

    expect(result.ok).toBe(true);
    expect(result.downloaded).toEqual([]);
    expect(downloader).not.toHaveBeenCalled();
  });

  it("atomically replaces a corrupt target only after the partial file verifies", async () => {
    const { prepareModelDirectory } = await import(modelToolsPath);
    const modelDir = makeTempDir();
    const validContent = "verified-model";
    const modelPath = path.join(modelDir, "model_quant.onnx");
    fs.writeFileSync(modelPath, "corrupt-model");
    const manifest = {
      modelId: "fixture/model",
      revision: "fixture-revision",
      files: [{
        name: "model_quant.onnx",
        size: Buffer.byteLength(validContent),
        sha256: sha256(validContent),
      }],
    };
    const downloader = vi.fn(async (_url, outputPath) => {
      expect(fs.readFileSync(modelPath, "utf8")).toBe("corrupt-model");
      fs.writeFileSync(outputPath, validContent);
    });

    const result = await prepareModelDirectory(modelDir, { manifest, downloader });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(modelPath, "utf8")).toBe(validContent);
    expect(fs.existsSync(`${modelPath}.part`)).toBe(false);
  });

  it("aborts a download as soon as streamed bytes exceed the manifest size", async () => {
    const { downloadToFile } = await import(modelToolsPath);
    const outputPath = path.join(makeTempDir(), "oversized.part");
    const httpGet = vi.fn((_url, options, callback) => {
      expect(options.headers["User-Agent"]).toContain("WordTaker");
      const request = new EventEmitter();
      request.setTimeout = vi.fn();
      request.destroy = vi.fn((error) => request.emit("error", error));
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = {};
      queueMicrotask(() => {
        callback(response);
        response.write(Buffer.alloc(4));
        response.write(Buffer.alloc(4));
        response.end();
      });
      return request;
    });

    await expect(downloadToFile("https://model.test/model", outputPath, {
      expectedSize: 5,
      httpGet,
    })).rejects.toThrow("超过清单大小");
  });

  it("wires macOS and Windows packaging to prepare before build and verify app.asar.unpacked after pack", async () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));

    expect(packageJson.scripts["prepare:sensevoice"]).toBe("node scripts/sensevoice-model.js --prepare");
    expect(packageJson.scripts["verify:sensevoice"]).toBe("node scripts/sensevoice-model.js --verify");
    expect(packageJson.scripts["prebuild:mac"]).toContain("npm run prepare:sensevoice");
    expect(packageJson.scripts["prebuild:win"]).toContain("npm run prepare:sensevoice");
    expect(packageJson.scripts["prebuild:linux"]).not.toContain("prepare:sensevoice");
    expect(packageJson.build.afterPack).toBe("scripts/verify-sensevoice-pack.js");
    expect(packageJson.build.files).toContain("!models/**/*.part");
  });

  it("leaves Linux packaging unchanged", async () => {
    delete require.cache[require.resolve("../scripts/verify-sensevoice-pack.js")];
    const verifySenseVoicePack = require("../scripts/verify-sensevoice-pack.js");

    await expect(verifySenseVoicePack({
      electronPlatformName: "linux",
      appOutDir: path.join(makeTempDir(), "missing-linux-app"),
    })).resolves.toBeUndefined();
  });

  it("fails closed when the macOS product name is unavailable", () => {
    const { resolveMacModelDir } = require("../scripts/verify-sensevoice-pack.js");
    expect(() => resolveMacModelDir({ appOutDir: makeTempDir() })).toThrow("无法确定 macOS 应用包名称");
  });

  for (const platform of ["darwin", "win32"]) {
    it(`accepts ${platform} packaging only after the shared verifier approves its real resource path`, async () => {
      const modelTools = require("../scripts/sensevoice-model.js");
      const verify = vi.spyOn(modelTools, "verifyModelDirectory").mockResolvedValue({ ok: true, invalid: [] });
      const verifySenseVoicePack = require("../scripts/verify-sensevoice-pack.js");
      const context = {
        electronPlatformName: platform,
        appOutDir: makeTempDir(),
        packager: { appInfo: { productFilename: "弦外小猫" } },
      };
      await expect(verifySenseVoicePack(context)).resolves.toBeUndefined();
      const expected = platform === "darwin"
        ? verifySenseVoicePack.resolveMacModelDir(context)
        : verifySenseVoicePack.resolveWindowsModelDir(context);
      expect(verify).toHaveBeenCalledExactlyOnceWith(expected);
    });
  }

  for (const unpackedDir of ["win-unpacked", "win-arm64-unpacked"]) {
    it(`resolves ${unpackedDir} models from the Windows app.asar.unpacked layout`, () => {
      const { resolveWindowsModelDir } = require("../scripts/verify-sensevoice-pack.js");
      const appOutDir = path.join(makeTempDir(), unpackedDir);
      expect(resolveWindowsModelDir({ appOutDir })).toBe(path.join(
        appOutDir, "resources", "app.asar.unpacked", "models", "sensevoice",
      ));
    });

    it(`rejects all four missing runtime files after packing ${unpackedDir}`, async () => {
      const verifySenseVoicePack = require("../scripts/verify-sensevoice-pack.js");
      await expect(verifySenseVoicePack({
        electronPlatformName: "win32",
        appOutDir: path.join(makeTempDir(), unpackedDir),
      })).rejects.toThrow(/model_quant\.onnx\(missing\).*tokens\.json\(missing\).*config\.yaml\(missing\).*am\.mvn\(missing\)/);
    });

    for (const fileName of ["model_quant.onnx", "tokens.json", "config.yaml", "am.mvn"]) {
      for (const failure of ["missing", "size-mismatch", "sha256-mismatch"]) {
        it(`rejects ${fileName} ${failure} in ${unpackedDir} without weakening other files`, async () => {
          const { verifyModelDirectory } = await import(modelToolsPath);
          const modelDir = path.join(makeTempDir(), unpackedDir, "resources", "app.asar.unpacked", "models", "sensevoice");
          fs.mkdirSync(modelDir, { recursive: true });
          const names = ["model_quant.onnx", "tokens.json", "config.yaml", "am.mvn"];
          const content = "valid fixture";
          const manifest = { files: names.map((name) => ({
            name, size: Buffer.byteLength(content), sha256: sha256(content),
          })) };
          for (const name of names) fs.writeFileSync(path.join(modelDir, name), content);
          expect((await verifyModelDirectory(modelDir, manifest)).ok).toBe(true);
          const target = path.join(modelDir, fileName);
          if (failure === "missing") fs.rmSync(target);
          else fs.writeFileSync(target, failure === "size-mismatch" ? "short" : "bad!! fixture");
          const result = await verifyModelDirectory(modelDir, manifest);
          expect(result.ok).toBe(false);
          expect(result.invalid).toEqual([expect.objectContaining({ name: fileName, reason: failure })]);
        });
      }
    }
  }

  it("resolves the real macOS .app Resources layout used by electron-builder", () => {
    delete require.cache[require.resolve("../scripts/verify-sensevoice-pack.js")];
    const { resolveMacModelDir } = require("../scripts/verify-sensevoice-pack.js");
    const appOutDir = path.join(makeTempDir(), "mac-arm64");

    expect(resolveMacModelDir({
      appOutDir,
      packager: { appInfo: { productFilename: "弦外小猫" } },
    })).toBe(path.join(
      appOutDir,
      "弦外小猫.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "models",
      "sensevoice",
    ));
  });

  it("keeps embedded Python dependency checks aligned with macOS full and Windows ONNX-only runtimes", () => {
    const EmbeddedPythonTester = require("../scripts/test-embedded-python.js");
    const tester = new EmbeddedPythonTester();

    tester.isWindows = false;
    expect(tester.dependencyNames()).toEqual(expect.arrayContaining([
      "torch",
      "librosa",
      "funasr",
      "onnxruntime",
      "soundfile",
    ]));
    expect(tester.dependencyNames()).not.toContain("funasr_onnx");

    tester.isWindows = true;
    expect(tester.dependencyNames()).toEqual([
      "sys",
      "os",
      "json",
      "numpy",
      "onnxruntime",
      "soundfile",
    ]);

    const EmbeddedPythonBuilder = require("../scripts/prepare-embedded-python.js");
    const builder = new EmbeddedPythonBuilder();
    expect(builder.dependencyImportTimeoutMs).toBeGreaterThanOrEqual(60_000);
  });
});
