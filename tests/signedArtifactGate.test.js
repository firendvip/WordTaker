import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createReleaseReceipt,
  normalizeFingerprint,
  parseMacSignatureDetails,
  runSignedArtifactGateCli,
  validateMacAssessment,
  validateRuntimeResult,
  validateWindowsSignature,
  verifyMacArtifact,
  verifyWindowsArtifact,
} = require("../scripts/signed-artifact-gate.js");

const FINGERPRINT = "A1".repeat(32);
const TEAM_ID = "ABCDE12345";
const tempDirectories = [];

function tempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-signed-gate-"));
  tempDirectories.push(directory);
  return directory;
}

function writeRuntimeResult(filePath, arch = "arm64") {
  fs.writeFileSync(filePath, JSON.stringify({
    success: true,
    version: "43.3.0",
    appVersion: "1.29.0",
    arch,
    storage: { backend: arch === "arm64" ? "keychain" : "dpapi" },
    tokenStore: { persisted: true, accessTokenPersisted: false, reloaded: true },
    database: { legacyText: "legacy preserved" },
    uiohook: { loaded: true },
  }));
}

afterEach(() => {
  while (tempDirectories.length) {
    fs.rmSync(tempDirectories.pop(), { recursive: true, force: true });
  }
});

describe("signed packaged artifact gate", () => {
  it("normalizes pinned SHA-256 certificate fingerprints and rejects ambiguity", () => {
    expect(normalizeFingerprint(FINGERPRINT.toLowerCase().match(/../g).join(":")))
      .toBe(FINGERPRINT);
    for (const value of [null, "", "A1".repeat(31), "GG".repeat(32)]) {
      expect(() => normalizeFingerprint(value)).toThrow(/fingerprint/i);
    }
  });

  it("parses and pins Developer ID, TeamIdentifier and notarized assessment", () => {
    expect(parseMacSignatureDetails([
      "Identifier=com.kittyecho.app",
      "Authority=Developer ID Application: Wangsan (ABCDE12345)",
      "TeamIdentifier=ABCDE12345",
    ].join("\n"))).toEqual({
      identifier: "com.kittyecho.app",
      authority: "Developer ID Application: Wangsan (ABCDE12345)",
      teamId: TEAM_ID,
    });
    expect(validateMacAssessment("accepted\nsource=Notarized Developer ID"))
      .toBe("Notarized Developer ID");
    expect(() => parseMacSignatureDetails("Authority=Apple Development\nTeamIdentifier=not-valid"))
      .toThrow(/Developer ID|TeamIdentifier/);
    expect(() => validateMacAssessment("rejected\nsource=Unnotarized Developer ID"))
      .toThrow(/notarized/i);
  });

  it("requires a valid timestamped Authenticode signer with the pinned fingerprint", () => {
    const signature = {
      Status: "Valid",
      SignerCertificate: { Thumbprint: FINGERPRINT },
      TimeStamperCertificate: { Thumbprint: "B2".repeat(32) },
    };
    expect(validateWindowsSignature(signature, FINGERPRINT)).toMatchObject({
      signerFingerprint: FINGERPRINT,
      timestamped: true,
    });
    expect(() => validateWindowsSignature({ ...signature, Status: "UnknownError" }, FINGERPRINT))
      .toThrow(/Authenticode/i);
    expect(() => validateWindowsSignature({ ...signature, TimeStamperCertificate: null }, FINGERPRINT))
      .toThrow(/timestamp/i);
    expect(() => validateWindowsSignature(signature, "C3".repeat(32)))
      .toThrow(/fingerprint/i);
  });

  it("accepts only matching packaged runtime receipts without token leakage", () => {
    const result = {
      success: true,
      version: "43.3.0",
      appVersion: "1.29.0",
      arch: "arm64",
      storage: { backend: "keychain" },
      tokenStore: { persisted: true, accessTokenPersisted: false, reloaded: true },
      database: { legacyText: "legacy preserved" },
      uiohook: { loaded: true },
    };
    expect(validateRuntimeResult(result, {
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "arm64",
    })).toEqual(result);
    for (const mutation of [
      { success: false },
      { version: "42.0.0" },
      { appVersion: "1.28.6" },
      { arch: "x64" },
      { tokenStore: { persisted: true, accessTokenPersisted: true, reloaded: true } },
    ]) {
      expect(() => validateRuntimeResult({ ...result, ...mutation }, {
        version: "1.29.0",
        electronVersion: "43.3.0",
        arch: "arm64",
      })).toThrow(/runtime/i);
    }
  });

  it("executes every macOS signature, notarization, staple and runtime gate", () => {
    const directory = tempDirectory();
    const appPath = path.join(directory, "弦外小猫.app");
    const artifactPath = path.join(directory, "KittyEcho-1.29.0-arm64.dmg");
    const runtimeResultPath = path.join(directory, "runtime.json");
    const receiptPath = path.join(directory, "receipt.json");
    fs.mkdirSync(appPath);
    fs.writeFileSync(artifactPath, "signed-dmg");
    writeRuntimeResult(runtimeResultPath);
    const calls = [];
    const run = vi.fn((command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "codesign" && args.includes("--display")) {
        return { stdout: "", stderr: [
          "Identifier=com.kittyecho.app",
          "Authority=Developer ID Application: Wangsan (ABCDE12345)",
          "TeamIdentifier=ABCDE12345",
        ].join("\n") };
      }
      if (command === "spctl") {
        return { stdout: "", stderr: "accepted\nsource=Notarized Developer ID" };
      }
      return { stdout: "ok", stderr: "" };
    });

    const receipt = verifyMacArtifact({
      appPath,
      artifactPath,
      runtimeResultPath,
      receiptPath,
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "arm64",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      expectedTeamId: TEAM_ID,
      expectedSignerFingerprint: FINGERPRINT,
    }, {
      run,
      extractCertificateFingerprint: () => FINGERPRINT,
    });

    expect(calls).toEqual(expect.arrayContaining([
      expect.stringContaining("codesign --verify --deep --strict"),
      expect.stringContaining("codesign --display --verbose=4"),
      expect.stringContaining("spctl --assess --type execute"),
      expect.stringContaining("xcrun stapler validate"),
    ]));
    expect(calls.filter((value) => value.includes("stapler validate"))).toHaveLength(2);
    expect(receipt).toMatchObject({
      platform: "macos",
      version: "1.29.0",
      signer: { fingerprint: FINGERPRINT, teamId: TEAM_ID },
      notarization: { accepted: true, appStapled: true, artifactStapled: true },
    });
    expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toEqual(receipt);
  });

  it("executes Windows installer, portable and installed-exe Authenticode gates", () => {
    const directory = tempDirectory();
    const installerPath = path.join(directory, "KittyEcho-1.29.0-x64-setup.exe");
    const portablePath = path.join(directory, "KittyEcho-1.29.0-x64-portable.exe");
    const installedAppPath = path.join(directory, "弦外小猫.exe");
    const installedRuntimeResultPath = path.join(directory, "installed-runtime.json");
    const portableRuntimeResultPath = path.join(directory, "portable-runtime.json");
    for (const filePath of [installerPath, portablePath, installedAppPath]) {
      fs.writeFileSync(filePath, `signed:${path.basename(filePath)}`);
    }
    writeRuntimeResult(installedRuntimeResultPath, "x64");
    writeRuntimeResult(portableRuntimeResultPath, "x64");
    const signature = JSON.stringify({
      Status: "Valid",
      SignerCertificate: { Thumbprint: FINGERPRINT },
      TimeStamperCertificate: { Thumbprint: "B2".repeat(32) },
    });
    const run = vi.fn((command) => command === "powershell.exe"
      ? { stdout: signature, stderr: "" }
      : { stdout: "Successfully verified", stderr: "" });

    const receipt = verifyWindowsArtifact({
      installerPath,
      portablePath,
      installedAppPath,
      installedRuntimeResultPath,
      portableRuntimeResultPath,
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "x64",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      expectedSignerFingerprint: FINGERPRINT,
    }, { run });

    expect(run).toHaveBeenCalledTimes(6);
    expect(receipt).toMatchObject({
      platform: "windows",
      signatures: {
        installer: { timestamped: true },
        portable: { timestamped: true },
        installedApp: { timestamped: true },
      },
      runtime: { installed: { success: true }, portable: { success: true } },
    });
  });

  it("creates deterministic secret-free receipts and exposes fail-closed CLI outcomes", async () => {
    const receipt = createReleaseReceipt({
      platform: "macos",
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "arm64",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      artifact: { name: "candidate.dmg", sha256: "c".repeat(64) },
      signer: { fingerprint: FINGERPRINT, teamId: TEAM_ID },
      runtime: { success: true },
    });
    expect(JSON.stringify(receipt)).not.toMatch(/token|password|secret/i);
    expect(receipt).toMatchObject({ schemaVersion: 1, globalLogout: false });

    const processLike = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, exitCode: 0 };
    const verified = { platform: "macos", version: "1.29.0" };
    expect(await runSignedArtifactGateCli({
      argv: ["--manifest", "/tmp/manifest.json"],
      processLike,
      readManifest: () => ({ platform: "macos" }),
      verifyMac: () => verified,
    })).toBe(verified);
    expect(processLike.stdout.write).toHaveBeenCalledWith(expect.stringContaining("1.29.0"));

    processLike.exitCode = 0;
    expect(await runSignedArtifactGateCli({
      argv: [],
      processLike,
      readManifest: () => ({}),
    })).toBeNull();
    expect(processLike.exitCode).toBe(1);
    expect(processLike.stderr.write).toHaveBeenCalled();
  });
});
