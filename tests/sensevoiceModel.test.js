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
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("SenseVoice model preparation", () => {
  it("pins the official ONNX snapshot and every runtime file by size and SHA-256", async () => {
    const { SENSEVOICE_MODEL_MANIFEST } = await import(modelToolsPath);

    expect(SENSEVOICE_MODEL_MANIFEST.modelId).toBe("iic/SenseVoiceSmall-onnx");
    expect(SENSEVOICE_MODEL_MANIFEST.revision).toBe("v2.0.5");
    expect(SENSEVOICE_MODEL_MANIFEST.files.map(({ name }) => name)).toEqual([
      "model_quant.onnx",
      "tokens.json",
      "config.yaml",
      "am.mvn",
    ]);
    for (const file of SENSEVOICE_MODEL_MANIFEST.files) {
      expect(file.size).toBeGreaterThan(0);
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
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
    const httpGet = vi.fn((_url, callback) => {
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

  it("wires macOS packaging to prepare before build and verify app.asar.unpacked after pack", async () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));

    expect(packageJson.scripts["prepare:sensevoice"]).toBe("node scripts/sensevoice-model.js --prepare");
    expect(packageJson.scripts["verify:sensevoice"]).toBe("node scripts/sensevoice-model.js --verify");
    expect(packageJson.scripts["prebuild:mac"]).toContain("npm run prepare:sensevoice");
    expect(packageJson.build.afterPack).toBe("scripts/verify-sensevoice-pack.js");
  });

  it("limits the afterPack assertion to macOS so existing Windows/Linux flows stay unchanged", async () => {
    delete require.cache[require.resolve("../scripts/verify-sensevoice-pack.js")];
    const verifySenseVoicePack = require("../scripts/verify-sensevoice-pack.js");

    await expect(verifySenseVoicePack({
      electronPlatformName: "linux",
      appOutDir: path.join(makeTempDir(), "missing-linux-app"),
    })).resolves.toBeUndefined();
  });
});
