import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createReleaseReceipt,
  defaultRun,
  extractMacCertificateFingerprint,
  findSingleApplication,
  findWindowsExecutable,
  installWindowsArtifact,
  mountMacArtifact,
  normalizeFingerprint,
  normalizeRuntimeExecution,
  parseMacSignatureDetails,
  readJsonFile,
  readManifest,
  requirePath,
  runPackagedRuntime,
  runSignedArtifactGateCli,
  safeArtifactSummary,
  safeRuntimeSummary,
  safeSignatureSummaries,
  safeSignerSummary,
  sha256File,
  validateMacAssessment,
  validateMacProtocolVariant,
  validateProtocolVariant,
  validateReleaseVariant,
  validateRuntimeResult,
  validateWindowsProtocolVariant,
  validateWindowsSignature,
  verifyManifestProvenance,
  verifyMacArtifact,
  verifyWindowsArtifact,
  verifyWindowsSignature,
  windowsSignatureCommand,
  writeReceipt,
} = require("../scripts/signed-artifact-gate.js");

const FINGERPRINT = "A1".repeat(32);
const TEAM_ID = "ABCDE12345";
const tempDirectories = [];

function tempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-signed-gate-"));
  tempDirectories.push(directory);
  return directory;
}

function writeRuntimeResult(filePath, arch = "arm64", variant = "passport-candidate") {
  fs.writeFileSync(filePath, JSON.stringify({
    success: true,
    version: "43.3.0",
    appVersion: "1.29.0",
    arch,
    variant,
    storage: { backend: arch === "arm64" ? "keychain" : "dpapi", encryptedBytes: 32 },
    native: {
      credentials: { persisted: true, accessTokenPersisted: false, reloaded: true },
      database: { legacyText: "legacy preserved", migratedColumns: 6 },
      uiohook: { loaded: true },
    },
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(validateMacAssessment([
      "/Volumes/弦外小猫/弦外小猫.app: accepted",
      "source=Notarized Developer ID",
      `origin=Developer ID Application: Wangsan (${TEAM_ID})`,
    ].join("\n")))
      .toBe("Notarized Developer ID");
    expect(() => parseMacSignatureDetails("Authority=Apple Development\nTeamIdentifier=not-valid"))
      .toThrow(/Developer ID|TeamIdentifier/);
    expect(() => validateMacAssessment("rejected\nsource=Unnotarized Developer ID"))
      .toThrow(/notarized/i);
    expect(() => validateMacAssessment("maliciousaccepted\nsource=Notarized Developer ID"))
      .toThrow(/notarized/i);
    expect(parseMacSignatureDetails([
      "ignored line",
      "Identifier=com.kittyecho.app",
      "Identifier=evil.example",
      "Authority=Developer ID Application: Wangsan (ABCDE12345)",
      "TeamIdentifier=ABCDE12345",
    ].join("\n")).identifier).toBe("com.kittyecho.app");
    expect(() => parseMacSignatureDetails([
      "Identifier=com.kittyecho.app",
      "Authority=Developer ID Application: Wangsan (ABCDE12345)",
      "TeamIdentifier=ZYXWV98765",
    ].join("\n"))).toThrow(/do not match/i);
    expect(() => parseMacSignatureDetails([
      "Identifier=evil.example",
      "Authority=Developer ID Application: Wangsan (ABCDE12345)",
      "TeamIdentifier=ABCDE12345",
    ].join("\n"))).toThrow(/Identifier/i);
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
    expect(validateWindowsSignature({
      Status: "Valid",
      SignerSha256: FINGERPRINT,
      TimestampSha256: "B2".repeat(32),
    }, FINGERPRINT)).toMatchObject({ signerFingerprint: FINGERPRINT });
    expect(() => validateWindowsSignature(null, FINGERPRINT)).toThrow(/Authenticode/i);
  });

  it("validates file boundaries, bounded JSON, hashes and atomic receipt permissions", () => {
    const directory = tempDirectory();
    const jsonPath = path.join(directory, "value.json");
    const receiptPath = path.join(directory, "receipt.json");
    fs.writeFileSync(jsonPath, '{"ok":true}');
    expect(requirePath(jsonPath, "JSON", "file")).toBe(jsonPath);
    expect(() => requirePath("relative.json", "JSON", "file")).toThrow(/absolute/i);
    expect(() => requirePath(directory, "JSON", "file")).toThrow(/file/i);
    expect(() => requirePath(jsonPath, "directory", "directory")).toThrow(/directory/i);
    if (process.platform !== "win32") {
      const symlinkPath = path.join(directory, "value-link.json");
      fs.symlinkSync(jsonPath, symlinkPath);
      expect(() => requirePath(symlinkPath, "JSON", "file")).toThrow(/symbolic/i);
    }
    expect(readJsonFile(jsonPath, "JSON")).toEqual({ ok: true });
    expect(readManifest(jsonPath)).toEqual({ ok: true });
    expect(sha256File(jsonPath)).toMatch(/^[a-f0-9]{64}$/);
    fs.writeFileSync(jsonPath, "not-json");
    expect(() => readJsonFile(jsonPath, "JSON")).toThrow(/valid JSON/i);
    fs.writeFileSync(jsonPath, "");
    expect(() => readJsonFile(jsonPath, "JSON")).toThrow(/size/i);
    fs.writeFileSync(jsonPath, Buffer.alloc(1024 * 1024 + 1));
    expect(() => readJsonFile(jsonPath, "JSON")).toThrow(/size/i);

    const receipt = { schemaVersion: 1, success: true };
    writeReceipt(receiptPath, receipt);
    expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toEqual(receipt);
    if (process.platform !== "win32") {
      expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
    }
    expect(() => writeReceipt("relative.json", receipt)).toThrow(/absolute/i);
    expect(writeReceipt(undefined, receipt)).toBeUndefined();
  });

  it("hashes large release artifacts in bounded chunks", () => {
    const directory = tempDirectory();
    const artifactPath = path.join(directory, "large-artifact.bin");
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 17, 0x5a);
    fs.writeFileSync(artifactPath, bytes);
    const expected = crypto.createHash("sha256").update(bytes).digest("hex");
    const readFile = vi.spyOn(fs, "readFileSync");
    expect(sha256File(artifactPath)).toBe(expected);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("executes child commands without a shell and fails closed on a non-zero exit", () => {
    expect(defaultRun(process.execPath, ["-e", "process.stdout.write('ok')"]).stdout).toBe("ok");
    expect(() => defaultRun(process.execPath, ["-e", "process.exit(7)"]))
      .toThrow(/exit code 7/i);
    expect(() => defaultRun(path.join(os.tmpdir(), "missing-wordtaker-command"), []))
      .toThrow();
  });

  it("pins local package, Electron, variant, commit and tree provenance", () => {
    const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    const commit = childProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
    const tree = childProcess.execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
    const manifest = {
      version: "1.29.2",
      electronVersion: "43.3.0",
      variant: "default",
      arch: "arm64",
      commit,
      tree,
    };
    expect(verifyManifestProvenance(manifest, { rootDir })).toMatchObject({ commit, tree });
    expect(() => verifyManifestProvenance({ ...manifest, tree: "f".repeat(40) }, { rootDir }))
      .toThrow(/commit\/tree/i);
    expect(() => verifyManifestProvenance({ ...manifest, version: "1.28.6" }, { rootDir }))
      .toThrow(/version/i);
    expect(() => verifyManifestProvenance({ ...manifest, electronVersion: "43.3.1" }, { rootDir }))
      .toThrow(/Electron/i);
    expect(() => verifyManifestProvenance({ ...manifest, arch: "ia32" }, { rootDir }))
      .toThrow(/architecture/i);
    expect(() => validateReleaseVariant("pilot")).toThrow(/variant/i);
  });

  it("matches protocol registration exactly to default and Passport candidate artifacts", () => {
    expect(validateProtocolVariant([], "default")).toEqual([]);
    expect(validateProtocolVariant(null, "default")).toEqual([]);
    expect(validateProtocolVariant([null], "default")).toEqual([]);
    expect(validateProtocolVariant(["wangsan-wordtaker"], "passport-candidate"))
      .toEqual(["wangsan-wordtaker"]);
    expect(() => validateProtocolVariant(["wangsan-wordtaker"], "default"))
      .toThrow(/protocol/i);
    expect(() => validateProtocolVariant(["wangsan-wordtaker", "wangsan-wordtaker"], "passport-candidate"))
      .toThrow(/protocol/i);

    const directory = tempDirectory();
    const appPath = path.join(directory, "Candidate.app");
    const plistPath = path.join(appPath, "Contents", "Info.plist");
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, "plist");
    const plist = JSON.stringify({
      CFBundleURLTypes: [{ CFBundleURLSchemes: ["wangsan-wordtaker"] }],
    });
    expect(validateMacProtocolVariant(appPath, "passport-candidate", () => ({ stdout: plist })))
      .toEqual(["wangsan-wordtaker"]);
    const installedAppPath = "C:\\Users\\runner\\KittyEcho.exe";
    expect(validateWindowsProtocolVariant(installedAppPath, "passport-candidate", () => ({
      stdout: JSON.stringify({
        Exists: true,
        UrlProtocolPresent: true,
        Command: `"${installedAppPath}" "%1"`,
      }),
    })))
      .toEqual(["wangsan-wordtaker"]);
    expect(validateWindowsProtocolVariant(null, "default", () => ({
      stdout: JSON.stringify({ Exists: false, UrlProtocolPresent: false, Command: null }),
    }))).toEqual([]);
    expect(() => validateWindowsProtocolVariant(installedAppPath, "passport-candidate", () => ({
      stdout: JSON.stringify({
        Exists: true,
        UrlProtocolPresent: true,
        Command: '"C:\\Stale\\KittyEcho.exe" "%1"',
      }),
    }))).toThrow(/command/i);
    expect(() => validateWindowsProtocolVariant(null, "default", () => ({ stdout: "maybe" })))
      .toThrow(/invalid/i);
    expect(validateMacProtocolVariant(appPath, "default", () => ({ stdout: "{}" })))
      .toEqual([]);
    expect(() => validateMacProtocolVariant(appPath, "default", () => ({ stdout: "{" })))
      .toThrow(/decoded/i);
  });

  it("mounts a verified read-only DMG, derives one app, and always detaches", () => {
    const directory = tempDirectory();
    const artifactPath = path.join(directory, "candidate.dmg");
    fs.writeFileSync(artifactPath, "dmg");
    const calls = [];
    const run = vi.fn((command, args) => {
      calls.push([command, ...args]);
      if (args.includes("attach")) {
        const mountPath = args[args.indexOf("-mountpoint") + 1];
        fs.mkdirSync(path.join(mountPath, "Candidate.app"));
      }
      return { stdout: "", stderr: "" };
    });
    const mounted = mountMacArtifact(artifactPath, run);
    expect(findSingleApplication(path.dirname(mounted.appPath))).toBe(mounted.appPath);
    mounted.cleanup();
    expect(calls.some(([, ...args]) => args.includes("verify"))).toBe(true);
    expect(calls.some(([, ...args]) => args.includes("-readonly"))).toBe(true);
    expect(calls.some(([, ...args]) => args.includes("detach"))).toBe(true);

    const failedCalls = [];
    expect(() => mountMacArtifact(artifactPath, (command, args) => {
      failedCalls.push([command, ...args]);
      if (args.includes("attach")) {
        const mountPath = args[args.indexOf("-mountpoint") + 1];
        fs.mkdirSync(path.join(mountPath, "One.app"));
        fs.mkdirSync(path.join(mountPath, "Two.app"));
      }
      if (args.includes("detach")) throw new Error("detach failed");
      return { stdout: "", stderr: "" };
    })).toThrow(/exactly one/i);
    expect(failedCalls.some(([, ...args]) => args.includes("detach"))).toBe(true);
    const emptyRoot = tempDirectory();
    expect(() => findSingleApplication(emptyRoot)).toThrow(/exactly one/i);
  });

  it("runs packaged macOS and Windows apps with isolated runtime evidence", () => {
    const directory = tempDirectory();
    const appPath = path.join(directory, "Candidate.app");
    const exePath = path.join(directory, "Candidate.exe");
    fs.mkdirSync(appPath);
    fs.writeFileSync(exePath, "exe");
    const manifest = { version: "1.29.0", electronVersion: "43.3.0", arch: "arm64" };
    const macExecution = runPackagedRuntime(appPath, manifest, (_command, args) => {
      const resultEnv = args.find((value) => value.startsWith("WORDTAKER_RUNTIME_SMOKE_RESULT="));
      fs.writeFileSync(resultEnv.split("=").slice(1).join("="), "{}");
      return { stdout: "", stderr: "" };
    }, "darwin");
    expect(readJsonFile(macExecution.resultPath, "runtime")).toEqual({});
    macExecution.cleanup();

    const windowsExecution = runPackagedRuntime(exePath, { ...manifest, arch: "x64" },
      (_command, _args, options) => {
        fs.writeFileSync(options.env.WORDTAKER_RUNTIME_SMOKE_RESULT, "{}");
        return { stdout: "", stderr: "" };
      }, "win32");
    expect(fs.existsSync(windowsExecution.resultPath)).toBe(true);
    windowsExecution.cleanup();
    expect(() => runPackagedRuntime(exePath, manifest, vi.fn(), "linux"))
      .toThrow(/macOS and Windows/i);
    expect(() => runPackagedRuntime(exePath, manifest, () => {
      throw new Error("launch failed");
    }, "win32")).toThrow(/launch failed/i);
    expect(normalizeRuntimeExecution("/tmp/result.json")).toMatchObject({
      resultPath: "/tmp/result.json",
    });
    expect(() => normalizeRuntimeExecution({})).toThrow(/receipt path/i);
    const normalized = normalizeRuntimeExecution({ resultPath: "/tmp/result.json" });
    expect(normalized.cleanup()).toBeUndefined();
  });

  it("derives installed Windows executables and uninstalls them in cleanup", () => {
    const directory = tempDirectory();
    const installerPath = path.join(directory, "setup.exe");
    fs.writeFileSync(installerPath, "installer");
    const calls = [];
    const run = vi.fn((command, args) => {
      calls.push([command, ...args]);
      if (command === installerPath) {
        const installPath = args.find((value) => value.startsWith("/D=")).slice(3);
        fs.mkdirSync(installPath, { recursive: true });
        fs.writeFileSync(path.join(installPath, "KittyEcho.exe"), "app");
        fs.writeFileSync(path.join(installPath, "Uninstall.exe"), "uninstall");
      }
      return { stdout: "", stderr: "" };
    });
    const installation = installWindowsArtifact(installerPath, run);
    expect(findWindowsExecutable(path.dirname(installation.installedAppPath)))
      .toBe(installation.installedAppPath);
    expect(findWindowsExecutable(path.dirname(installation.installedAppPath), { uninstall: true }))
      .toMatch(/Uninstall\.exe$/);
    installation.cleanup();
    expect(calls.some(([command, arg]) => /Uninstall\.exe$/.test(command) && arg === "/S"))
      .toBe(true);

    const emptyRoot = tempDirectory();
    expect(() => findWindowsExecutable(emptyRoot)).toThrow(/app was not found/i);
    expect(() => findWindowsExecutable(emptyRoot, { uninstall: true }))
      .toThrow(/uninstaller was not found/i);

    const failingCalls = [];
    expect(() => installWindowsArtifact(installerPath, (command, args) => {
      failingCalls.push([command, ...args]);
      if (command === installerPath) {
        const installPath = args.find((value) => value.startsWith("/D=")).slice(3);
        fs.mkdirSync(installPath, { recursive: true });
        fs.writeFileSync(path.join(installPath, "Uninstall.exe"), "uninstall");
      }
      return { stdout: "", stderr: "" };
    })).toThrow(/app was not found/i);
    expect(failingCalls.some(([command, arg]) => /Uninstall\.exe$/.test(command) && arg === "/S"))
      .toBe(true);
  });

  it("extracts the macOS leaf certificate fingerprint without exposing certificate bytes", () => {
    const directory = tempDirectory();
    const appPath = path.join(directory, "Signed.app");
    fs.mkdirSync(appPath);
    const fingerprint = extractMacCertificateFingerprint(appPath, (_command, args) => {
      fs.writeFileSync(`${args[2]}0`, "leaf-certificate");
      return { stdout: "", stderr: "" };
    });
    expect(fingerprint).toBe(
      crypto.createHash("sha256").update("leaf-certificate").digest("hex"),
    );
  });

  it("accepts only matching packaged runtime receipts without token leakage", () => {
    const result = {
      success: true,
      version: "43.3.0",
      appVersion: "1.29.0",
      arch: "arm64",
      variant: "default",
      storage: { backend: "keychain", encryptedBytes: 32 },
      native: {
        credentials: { persisted: true, accessTokenPersisted: false, reloaded: true },
        database: { legacyText: "legacy preserved", migratedColumns: 6 },
        uiohook: { loaded: true },
      },
    };
    expect(validateRuntimeResult(result, {
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "arm64",
      variant: "default",
    })).toEqual(result);
    for (const mutation of [
      { success: false },
      { version: "42.0.0" },
      { appVersion: "1.28.6" },
      { arch: "x64" },
      { variant: "passport-candidate" },
      { native: {
        ...result.native,
        credentials: { persisted: true, accessTokenPersisted: true, reloaded: true },
      } },
    ]) {
      expect(() => validateRuntimeResult({ ...result, ...mutation }, {
        version: "1.29.0",
        electronVersion: "43.3.0",
        arch: "arm64",
        variant: "default",
      })).toThrow(/runtime/i);
    }
    expect(() => validateRuntimeResult({
      ...result,
      storage: { ...result.storage, backend: "dpapi" },
    }, {
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "arm64",
      variant: "default",
      platform: "macos",
    })).toThrow(/platform storage/i);
    expect(() => validateRuntimeResult({
      ...result,
      native: {
        ...result.native,
        database: { ...result.native.database, legacyText: "changed" },
      },
    }, {
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "arm64",
      variant: "default",
    })).toThrow(/legacy database/i);
  });

  it("allowlists receipt summaries and rejects secret-shaped or incomplete evidence", () => {
    expect(safeRuntimeSummary(null)).toBeUndefined();
    expect(safeRuntimeSummary({ success: true })).toEqual({ success: true });
    expect(safeRuntimeSummary({
      success: true,
      version: "43.3.0",
      appVersion: "1.29.0",
      arch: "arm64",
      variant: "default",
      storage: { backend: "keychain" },
      native: {
        credentials: { persisted: true, reloaded: true, accessTokenPersisted: false },
        database: { legacyText: "legacy preserved" },
        uiohook: { loaded: true },
      },
      refreshToken: "must-not-escape",
    })).not.toHaveProperty("refreshToken");
    expect(safeRuntimeSummary({ success: true, variant: "passport-candidate" }))
      .toEqual({ success: true, variant: "passport-candidate" });
    expect(safeArtifactSummary({ name: "KittyEcho.dmg", sha256: "ab".repeat(32) }))
      .toEqual({ name: "KittyEcho.dmg", sha256: "ab".repeat(32) });
    for (const artifact of [
      { name: "../escape.dmg", sha256: "ab".repeat(32) },
      { name: "ok.dmg", sha256: "bad" },
    ]) {
      expect(() => safeArtifactSummary(artifact)).toThrow(/artifact/i);
    }
    expect(safeSignerSummary({
      fingerprint: FINGERPRINT,
      teamId: TEAM_ID,
      authority: `Developer ID Application: Wangsan (${TEAM_ID})`,
    })).toMatchObject({ teamId: TEAM_ID });
    expect(() => safeSignerSummary({
      fingerprint: FINGERPRINT,
      authority: "Apple Development",
    })).toThrow(/authority/i);
    expect(() => safeSignatureSummaries({
      installer: { signerFingerprint: FINGERPRINT, timestamped: true },
    })).toThrow(/portable/i);
    expect(safeSignatureSummaries({
      installer: { signerFingerprint: FINGERPRINT, timestamped: true },
      installedApp: { signerFingerprint: FINGERPRINT, timestamped: true },
    }, "passport-candidate")).toEqual({
      installer: { signerFingerprint: FINGERPRINT, timestamped: true },
      installedApp: { signerFingerprint: FINGERPRINT, timestamped: true },
    });
    expect(() => createReleaseReceipt({
      platform: "macos",
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "arm64",
      variant: "default",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      notarization: { accepted: true, appStapled: false, artifactStapled: true },
    })).toThrow(/notarization/i);
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
      artifactPath,
      receiptPath,
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "arm64",
      variant: "passport-candidate",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      expectedTeamId: TEAM_ID,
      expectedSignerFingerprint: FINGERPRINT,
    }, {
      run,
      verifyProvenance: vi.fn(),
      validateProtocolVariant: vi.fn(),
      mountArtifact: () => ({
        appPath,
        cleanup: vi.fn(),
      }),
      runPackagedRuntime: () => runtimeResultPath,
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

  it("uses the default macOS mount, protocol, certificate and packaged-runtime gates", () => {
    const directory = tempDirectory();
    const artifactPath = path.join(directory, "KittyEcho-1.29.0-arm64.dmg");
    fs.writeFileSync(artifactPath, "signed-dmg");
    const certificateBytes = Buffer.from("wordtaker-test-leaf-certificate");
    const expectedSignerFingerprint = crypto.createHash("sha256")
      .update(certificateBytes)
      .digest("hex");
    const run = vi.fn((command, args) => {
      if (command === "hdiutil" && args.includes("attach")) {
        const mountPath = args[args.indexOf("-mountpoint") + 1];
        const plistPath = path.join(mountPath, "KittyEcho.app", "Contents", "Info.plist");
        fs.mkdirSync(path.dirname(plistPath), { recursive: true });
        fs.writeFileSync(plistPath, "plist");
      }
      if (command === "plutil") {
        return { stdout: JSON.stringify({
          CFBundleURLTypes: [{ CFBundleURLSchemes: ["wangsan-wordtaker"] }],
        }), stderr: "" };
      }
      if (command === "codesign" && args.includes("--extract-certificates")) {
        fs.writeFileSync(`${args[2]}0`, certificateBytes);
      }
      if (command === "codesign" && args.includes("--verbose=4")) {
        return { stdout: "", stderr: [
          "Identifier=com.kittyecho.app",
          `Authority=Developer ID Application: Wangsan (${TEAM_ID})`,
          `TeamIdentifier=${TEAM_ID}`,
        ].join("\n") };
      }
      if (command === "spctl") {
        return { stdout: "accepted\nsource=Notarized Developer ID", stderr: "" };
      }
      if (command === "open") {
        const resultEnv = args.find((value) => value.startsWith("WORDTAKER_RUNTIME_SMOKE_RESULT="));
        writeRuntimeResult(resultEnv.split("=").slice(1).join("="), "arm64");
      }
      return { stdout: "", stderr: "" };
    });

    const receipt = verifyMacArtifact({
      artifactPath,
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "arm64",
      variant: "passport-candidate",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      expectedTeamId: TEAM_ID,
      expectedSignerFingerprint,
    }, { run, verifyProvenance: vi.fn() });

    expect(receipt).toMatchObject({
      platform: "macos",
      signer: { fingerprint: expectedSignerFingerprint.toUpperCase() },
      runtime: { storage: { backend: "keychain" } },
    });
    expect(run.mock.calls.some(([command, args]) => command === "hdiutil" && args.includes("detach")))
      .toBe(true);
  });

  it("fails closed on mismatched macOS release team and signer certificate", () => {
    const directory = tempDirectory();
    const artifactPath = path.join(directory, "KittyEcho.dmg");
    const appPath = path.join(directory, "KittyEcho.app");
    fs.writeFileSync(artifactPath, "dmg");
    fs.mkdirSync(appPath);
    const baseManifest = {
      artifactPath,
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "arm64",
      variant: "default",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      expectedTeamId: TEAM_ID,
      expectedSignerFingerprint: FINGERPRINT,
    };
    const signatureRun = (teamId) => vi.fn((command, args) => {
      if (command === "codesign" && args.includes("--verbose=4")) {
        return { stdout: [
          "Identifier=com.kittyecho.app",
          `Authority=Developer ID Application: Wangsan (${teamId})`,
          `TeamIdentifier=${teamId}`,
        ].join("\n"), stderr: "" };
      }
      return { stdout: "accepted\nsource=Notarized Developer ID", stderr: "" };
    });
    const mountCleanup = vi.fn();
    const commonDependencies = {
      verifyProvenance: vi.fn(),
      validateProtocolVariant: vi.fn(),
      mountArtifact: () => ({ appPath, cleanup: mountCleanup }),
      runPackagedRuntime: vi.fn(),
    };
    expect(() => verifyMacArtifact(baseManifest, {
      ...commonDependencies,
      run: signatureRun("ZYXWV98765"),
      extractCertificateFingerprint: () => FINGERPRINT,
    })).toThrow(/TeamIdentifier/i);
    expect(() => verifyMacArtifact(baseManifest, {
      ...commonDependencies,
      run: signatureRun(TEAM_ID),
      extractCertificateFingerprint: () => "C3".repeat(32),
    })).toThrow(/signer fingerprint/i);
    expect(mountCleanup).toHaveBeenCalledTimes(2);
  });

  it("always detaches a mounted DMG even when runtime cleanup fails", () => {
    const directory = tempDirectory();
    const artifactPath = path.join(directory, "KittyEcho.dmg");
    const appPath = path.join(directory, "KittyEcho.app");
    const runtimePath = path.join(directory, "runtime.json");
    const receiptPath = path.join(directory, "receipt.json");
    fs.writeFileSync(artifactPath, "dmg");
    fs.mkdirSync(appPath);
    writeRuntimeResult(runtimePath, "arm64", "default");
    const runtimeCleanup = vi.fn(() => { throw new Error("runtime cleanup failed"); });
    const mountCleanup = vi.fn();
    const run = vi.fn((command, args) => {
      if (command === "codesign" && args.includes("--verbose=4")) {
        return { stdout: [
          "Identifier=com.kittyecho.app",
          `Authority=Developer ID Application: Wangsan (${TEAM_ID})`,
          `TeamIdentifier=${TEAM_ID}`,
        ].join("\n"), stderr: "" };
      }
      return { stdout: "accepted\nsource=Notarized Developer ID", stderr: "" };
    });
    expect(() => verifyMacArtifact({
      artifactPath,
      receiptPath,
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "arm64",
      variant: "default",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      expectedTeamId: TEAM_ID,
      expectedSignerFingerprint: FINGERPRINT,
    }, {
      run,
      verifyProvenance: vi.fn(),
      validateProtocolVariant: vi.fn(),
      mountArtifact: () => ({ appPath, cleanup: mountCleanup }),
      runPackagedRuntime: () => ({ resultPath: runtimePath, cleanup: runtimeCleanup }),
      extractCertificateFingerprint: () => FINGERPRINT,
    })).toThrow(/runtime cleanup failed/i);
    expect(runtimeCleanup).toHaveBeenCalledOnce();
    expect(mountCleanup).toHaveBeenCalledOnce();
    expect(fs.existsSync(receiptPath)).toBe(false);
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
    writeRuntimeResult(installedRuntimeResultPath, "x64", "default");
    writeRuntimeResult(portableRuntimeResultPath, "x64", "default");
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
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "x64",
      variant: "default",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      expectedSignerFingerprint: FINGERPRINT,
    }, {
      run,
      verifyProvenance: vi.fn(),
      validateProtocolVariant: vi.fn(),
      validateProtocolRemoval: vi.fn(),
      installArtifact: () => ({ installedAppPath, cleanup: vi.fn() }),
      runPackagedRuntime: (targetPath) => targetPath === portablePath
        ? portableRuntimeResultPath
        : installedRuntimeResultPath,
    });

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

  it("binds the Passport candidate registry command to its installed executable and removes it", () => {
    const directory = tempDirectory();
    const installerPath = path.join(directory, "KittyEcho-1.29.0-x64-setup.exe");
    fs.writeFileSync(installerPath, "installer");
    let registeredAppPath = null;
    const run = vi.fn((command, args, options = {}) => {
      if (command === installerPath) {
        const installPath = args.find((value) => value.startsWith("/D=")).slice(3);
        fs.mkdirSync(installPath, { recursive: true });
        registeredAppPath = path.join(installPath, "KittyEcho.exe");
        fs.writeFileSync(registeredAppPath, "installed");
        fs.writeFileSync(path.join(installPath, "Uninstall.exe"), "uninstall");
      } else if (/Uninstall\.exe$/.test(command)) {
        registeredAppPath = null;
      } else if (command === "powershell.exe") {
        if (args.join(" ").includes("URL Protocol")) {
          return { stdout: JSON.stringify({
            Exists: Boolean(registeredAppPath),
            UrlProtocolPresent: Boolean(registeredAppPath),
            Command: registeredAppPath ? `"${registeredAppPath}" "%1"` : null,
          }), stderr: "" };
        }
        return { stdout: JSON.stringify({
          Status: "Valid",
          SignerSha256: FINGERPRINT,
          TimestampSha256: "B2".repeat(32),
        }), stderr: "" };
      } else if (options.env?.WORDTAKER_RUNTIME_SMOKE_RESULT) {
        writeRuntimeResult(
          options.env.WORDTAKER_RUNTIME_SMOKE_RESULT,
          "x64",
          "passport-candidate",
        );
      }
      return { stdout: "", stderr: "" };
    });

    const receipt = verifyWindowsArtifact({
      installerPath,
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "x64",
      variant: "passport-candidate",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      expectedSignerFingerprint: FINGERPRINT,
    }, { run, verifyProvenance: vi.fn() });

    expect(receipt).toMatchObject({
      platform: "windows",
      runtime: {
        installed: { storage: { backend: "dpapi" } },
      },
      signatures: {
        installer: { timestamped: true },
        installedApp: { timestamped: true },
      },
    });
    expect(receipt.artifacts).not.toHaveProperty("portable");
    expect(receipt.runtime).not.toHaveProperty("portable");
    expect(run.mock.calls.some(([command, args]) => /Uninstall\.exe$/.test(command) && args[0] === "/S"))
      .toBe(true);
    expect(run.mock.calls.filter(([command, args]) =>
      command === "powershell.exe" && args.join(" ").includes("URL Protocol")))
      .toHaveLength(3);
  });

  it("refuses a portable Passport candidate before executing release artifacts", () => {
    const directory = tempDirectory();
    const installerPath = path.join(directory, "setup.exe");
    const portablePath = path.join(directory, "portable.exe");
    fs.writeFileSync(installerPath, "installer");
    fs.writeFileSync(portablePath, "portable");
    const run = vi.fn();

    expect(() => verifyWindowsArtifact({
      installerPath,
      portablePath,
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "x64",
      variant: "passport-candidate",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      expectedSignerFingerprint: FINGERPRINT,
    }, { run, verifyProvenance: vi.fn() })).toThrow(/portable/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("verifies Windows distributable signatures before executing the installer", () => {
    const directory = tempDirectory();
    const installerPath = path.join(directory, "setup.exe");
    const portablePath = path.join(directory, "portable.exe");
    fs.writeFileSync(installerPath, "installer");
    fs.writeFileSync(portablePath, "portable");
    const installArtifact = vi.fn(() => {
      throw new Error("installer must not execute");
    });
    const run = vi.fn((command) => command === "powershell.exe"
      ? { stdout: JSON.stringify({ Status: "NotSigned" }), stderr: "" }
      : { stdout: "", stderr: "" });
    expect(() => verifyWindowsArtifact({
      installerPath,
      portablePath,
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "x64",
      variant: "default",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      expectedSignerFingerprint: FINGERPRINT,
    }, { run, verifyProvenance: vi.fn(), installArtifact })).toThrow(/Authenticode/i);
    expect(installArtifact).not.toHaveBeenCalled();
  });

  it("always uninstalls Windows artifacts when either runtime cleanup fails", () => {
    const directory = tempDirectory();
    const installerPath = path.join(directory, "setup.exe");
    const portablePath = path.join(directory, "portable.exe");
    const installedAppPath = path.join(directory, "KittyEcho.exe");
    const runtimePath = path.join(directory, "runtime.json");
    const receiptPath = path.join(directory, "receipt.json");
    for (const filePath of [installerPath, portablePath, installedAppPath]) fs.writeFileSync(filePath, "x");
    writeRuntimeResult(runtimePath, "x64", "default");
    const installedCleanup = vi.fn(() => { throw new Error("installed cleanup failed"); });
    const portableCleanup = vi.fn();
    const installationCleanup = vi.fn();
    const run = vi.fn((command) => command === "powershell.exe"
      ? { stdout: JSON.stringify({
        Status: "Valid",
        SignerSha256: FINGERPRINT,
        TimestampSha256: "B2".repeat(32),
      }), stderr: "" }
      : { stdout: "", stderr: "" });
    expect(() => verifyWindowsArtifact({
      installerPath,
      portablePath,
      receiptPath,
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "x64",
      variant: "default",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      expectedSignerFingerprint: FINGERPRINT,
    }, {
      run,
      verifyProvenance: vi.fn(),
      validateProtocolVariant: vi.fn(),
      validateProtocolRemoval: vi.fn(),
      installArtifact: () => ({ installedAppPath, cleanup: installationCleanup }),
      runPackagedRuntime: (target) => ({
        resultPath: runtimePath,
        cleanup: target === installedAppPath ? installedCleanup : portableCleanup,
      }),
    })).toThrow(/installed cleanup failed/i);
    expect(installedCleanup).toHaveBeenCalledOnce();
    expect(portableCleanup).toHaveBeenCalledOnce();
    expect(installationCleanup).toHaveBeenCalledOnce();
    expect(fs.existsSync(receiptPath)).toBe(false);
  });

  it("rejects malformed Authenticode JSON and generates the SHA-256 signer command", () => {
    expect(windowsSignatureCommand("C:\\KittyEcho.exe").join(" "))
      .toMatch(/SHA256/);
    expect(() => verifyWindowsSignature("C:\\KittyEcho.exe", FINGERPRINT, () => ({
      stdout: "not-json",
      stderr: "",
    }))).toThrow(/valid JSON/i);
  });

  it("creates deterministic secret-free receipts and exposes fail-closed CLI outcomes", async () => {
    const receipt = createReleaseReceipt({
      platform: "macos",
      version: "1.29.0",
      electronVersion: "43.3.0",
      arch: "arm64",
      variant: "passport-candidate",
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

    processLike.exitCode = 0;
    const windowsVerified = { platform: "windows", version: "1.29.0" };
    expect(await runSignedArtifactGateCli({
      argv: ["--manifest", "/tmp/manifest.json"],
      processLike,
      readManifest: () => ({ platform: "windows" }),
      verifyWindows: () => windowsVerified,
    })).toBe(windowsVerified);

    processLike.exitCode = 0;
    expect(await runSignedArtifactGateCli({
      argv: ["--manifest", "/tmp/manifest.json"],
      processLike,
      readManifest: () => ({ platform: "linux" }),
    })).toBeNull();
    expect(processLike.exitCode).toBe(1);

    processLike.exitCode = 0;
    expect(await runSignedArtifactGateCli({
      argv: ["--manifest", "/tmp/manifest.json"],
      processLike,
      readManifest: () => ({ platform: "macos" }),
      verifyMac: () => {
        throw new Error("signature gate failed");
      },
    })).toBeNull();
    expect(processLike.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("signature gate failed"),
    );
  });
});
