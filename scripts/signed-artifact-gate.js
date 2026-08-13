"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateRuntimeSmokeResult } = require("./electron-runtime-smoke");

const EXACT_ELECTRON_VERSION = "43.3.0";
const EXACT_APP_VERSION = "1.29.4";
const MAC_APP_IDENTIFIER = "com.kittyecho.app";
const OAUTH_SCHEME = "wangsan-wordtaker";
const SHA256_PATTERN = /^[A-F0-9]{64}$/;

function normalizeFingerprint(value) {
  const normalized = typeof value === "string"
    ? value.replace(/[\s:]/g, "").toUpperCase()
    : "";
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error("Signer fingerprint must be an unambiguous SHA-256 value");
  }
  return normalized;
}

function validateReleaseVariant(value) {
  return requireExactText(value, "release variant", /^(default|passport-candidate)$/);
}

function requireExactText(value, label, pattern, expected) {
  const text = String(value || "");
  if (!pattern.test(text) || (expected && text !== expected)) {
    throw new Error(`${label} is invalid`);
  }
  return text;
}

function parseMacSignatureDetails(output) {
  const fields = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!(key in fields)) fields[key] = line.slice(separator + 1).trim();
  }

  const authority = String(fields.Authority || "");
  if (!/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(authority)) {
    throw new Error("macOS signature must use a Developer ID Application authority");
  }
  const teamId = requireExactText(
    fields.TeamIdentifier,
    "macOS TeamIdentifier",
    /^[A-Z0-9]{10}$/,
  );
  if (!authority.endsWith(`(${teamId})`)) {
    throw new Error("Developer ID authority and TeamIdentifier do not match");
  }
  const identifier = requireExactText(
    fields.Identifier,
    "macOS signature Identifier",
    /^[A-Za-z0-9.-]{3,200}$/,
    MAC_APP_IDENTIFIER,
  );
  return { identifier, authority, teamId };
}

function validateMacAssessment(output) {
  const text = String(output || "");
  if (
    !/^(?:.+:\s+)?accepted\s*$/m.test(text)
    || !/^source=Notarized Developer ID\s*$/m.test(text)
  ) {
    throw new Error("macOS artifact is not accepted as a Notarized Developer ID application");
  }
  return "Notarized Developer ID";
}

function validateWindowsSignature(signature, expectedSignerFingerprint) {
  if (!signature || typeof signature !== "object" || signature.Status !== "Valid") {
    throw new Error("Authenticode signature status must be Valid");
  }
  const signerFingerprint = normalizeFingerprint(
    signature.SignerSha256 || signature.SignerCertificate?.Thumbprint,
  );
  if (signerFingerprint !== normalizeFingerprint(expectedSignerFingerprint)) {
    throw new Error("Authenticode signer fingerprint does not match the pinned certificate");
  }
  const timestampFingerprint = signature.TimestampSha256
    || signature.TimeStamperCertificate?.Thumbprint;
  if (typeof timestampFingerprint !== "string" || timestampFingerprint.trim() === "") {
    throw new Error("Authenticode signature must include a timestamp certificate");
  }
  return {
    signerFingerprint,
    timestamped: true,
  };
}

function validateRuntimeResult(result, expected) {
  try {
    validateRuntimeSmokeResult(result, {
      expectedElectronVersion: expected.electronVersion,
      expectedAppVersion: expected.version,
      expectedArch: expected.arch,
      expectedVariant: expected.variant,
    });
    const requiredBackend = expected.platform === "macos"
      ? "keychain"
      : expected.platform === "windows" ? "dpapi" : null;
    if (
      (requiredBackend && result.storage.backend !== requiredBackend)
      || result.native?.database?.legacyText !== "legacy preserved"
    ) {
      throw new Error("platform storage or legacy database evidence is invalid");
    }
    return result;
  } catch (error) {
    throw new Error(`Packaged runtime receipt does not match the release contract: ${error.message}`);
  }
}

function safeRuntimeSummary(runtime) {
  if (!runtime || typeof runtime !== "object") return undefined;
  const summary = {
    success: runtime.success === true,
  };
  for (const key of ["version", "appVersion", "arch", "variant"]) {
    if (typeof runtime[key] === "string") summary[key] = runtime[key];
  }
  if (runtime.storage && typeof runtime.storage.backend === "string") {
    summary.storage = { backend: runtime.storage.backend };
  }
  if (runtime.native?.credentials) {
    summary.credentials = {
      persisted: runtime.native.credentials.persisted === true,
      reloaded: runtime.native.credentials.reloaded === true,
      accessPersisted: runtime.native.credentials.accessTokenPersisted === true,
    };
  }
  if (runtime.native?.database) {
    summary.database = { legacyPreserved: runtime.native.database.legacyText === "legacy preserved" };
  }
  if (runtime.native?.uiohook) {
    summary.native = { uiohookLoaded: runtime.native.uiohook.loaded === true };
  }
  return summary;
}

function safeArtifactSummary(artifact) {
  const name = String(artifact?.name || "");
  if (!name || name.length > 255 || /[\u0000-\u001F\u007F/\\]/.test(name)) {
    throw new Error("Release artifact name is invalid");
  }
  const sha256 = String(artifact?.sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Release artifact SHA-256 is invalid");
  return { name, sha256 };
}

function safeSignerSummary(signer) {
  const summary = { fingerprint: normalizeFingerprint(signer?.fingerprint) };
  if (signer?.teamId !== undefined) {
    summary.teamId = requireExactText(signer.teamId, "signer team identifier", /^[A-Z0-9]{10}$/);
  }
  if (signer?.authority !== undefined) {
    const authority = String(signer.authority);
    if (!/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(authority)) {
      throw new Error("Signer authority is invalid");
    }
    summary.authority = authority;
  }
  return summary;
}

function windowsReceiptKeys(variant) {
  return validateReleaseVariant(variant) === "passport-candidate"
    ? ["installer", "installedApp"]
    : ["installer", "portable", "installedApp"];
}

function safeSignatureSummaries(signatures, variant = "default") {
  return Object.fromEntries(windowsReceiptKeys(variant).map((key) => {
    const signature = signatures?.[key];
    if (!signature || signature.timestamped !== true) {
      throw new Error(`Release signature summary is invalid for ${key}`);
    }
    return [key, {
      signerFingerprint: normalizeFingerprint(signature.signerFingerprint),
      timestamped: true,
    }];
  }));
}

function createReleaseReceipt(input) {
  const receipt = {
    schemaVersion: 1,
    platform: requireExactText(input.platform, "platform", /^(macos|windows)$/),
    version: requireExactText(input.version, "application version", /^\d+\.\d+\.\d+$/),
    electronVersion: requireExactText(
      input.electronVersion,
      "Electron version",
      /^\d+\.\d+\.\d+$/,
    ),
    arch: requireExactText(input.arch, "architecture", /^(arm64|x64)$/),
    commit: requireExactText(input.commit, "commit", /^[a-f0-9]{40}$/i),
    tree: requireExactText(input.tree, "tree", /^[a-f0-9]{40}$/i),
    variant: validateReleaseVariant(input.variant),
    globalLogout: false,
  };

  if (input.artifact !== undefined) receipt.artifact = safeArtifactSummary(input.artifact);
  if (input.artifacts !== undefined) {
    receipt.artifacts = Object.fromEntries(
      windowsReceiptKeys(receipt.variant).map((key) => [
        key,
        safeArtifactSummary(input.artifacts?.[key]),
      ]),
    );
  }
  if (input.signer !== undefined) receipt.signer = safeSignerSummary(input.signer);
  if (input.signatures !== undefined) {
    receipt.signatures = safeSignatureSummaries(input.signatures, receipt.variant);
  }
  if (input.notarization !== undefined) {
    if (
      input.notarization.accepted !== true
      || input.notarization.appStapled !== true
      || input.notarization.artifactStapled !== true
    ) {
      throw new Error("Release notarization summary is invalid");
    }
    receipt.notarization = { accepted: true, appStapled: true, artifactStapled: true };
  }
  if (input.runtime !== undefined) {
    if (input.runtime.installed || input.runtime.portable) {
      receipt.runtime = Object.fromEntries(
        (receipt.variant === "passport-candidate" ? ["installed"] : ["installed", "portable"])
          .map((key) => [key, safeRuntimeSummary(input.runtime[key])]),
      );
    } else {
      receipt.runtime = safeRuntimeSummary(input.runtime);
    }
  }
  return receipt;
}

function defaultRun(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 10 * 60 * 1000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) {
    throw new Error(`${path.basename(command)} verification failed with exit code ${result.status}`);
  }
  return { stdout: result.stdout || "", stderr: result.stderr || "" };
}

function requirePath(targetPath, label, expectedType) {
  if (typeof targetPath !== "string" || !path.isAbsolute(targetPath)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const stats = fs.lstatSync(targetPath);
  if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (expectedType === "file" && !stats.isFile()) throw new Error(`${label} must be a file`);
  if (expectedType === "directory" && !stats.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
  return targetPath;
}

function readJsonFile(filePath, label) {
  requirePath(filePath, label, "file");
  const bytes = fs.readFileSync(filePath);
  if (bytes.length === 0 || bytes.length > 1024 * 1024) {
    throw new Error(`${label} has an invalid size`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function sha256File(filePath) {
  const digest = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return digest.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

function runCleanupSteps(steps) {
  let cleanupError = null;
  for (const cleanup of steps) {
    if (typeof cleanup !== "function") continue;
    try {
      cleanup();
    } catch (error) {
      cleanupError ||= error;
    }
  }
  return cleanupError;
}

function writeReceipt(receiptPath, receipt) {
  if (!receiptPath) return;
  if (!path.isAbsolute(receiptPath)) throw new Error("Receipt path must be absolute");
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, receiptPath);
}

function verifyManifestProvenance(
  manifest,
  { rootDir = path.resolve(__dirname, ".."), run = defaultRun } = {},
) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  if (packageJson.version !== EXACT_APP_VERSION || manifest.version !== packageJson.version) {
    throw new Error(`Release version must match package.json ${EXACT_APP_VERSION}`);
  }
  if (
    packageJson.devDependencies?.electron !== EXACT_ELECTRON_VERSION
    || manifest.electronVersion !== packageJson.devDependencies.electron
  ) {
    throw new Error(`Electron release runtime must be exactly ${EXACT_ELECTRON_VERSION}`);
  }
  validateReleaseVariant(manifest.variant);
  requireExactText(manifest.arch, "architecture", /^(arm64|x64)$/);
  const commit = run("git", ["rev-parse", "HEAD"], { cwd: rootDir }).stdout.trim();
  const tree = run("git", ["rev-parse", "HEAD^{tree}"], { cwd: rootDir }).stdout.trim();
  if (manifest.commit !== commit || manifest.tree !== tree) {
    throw new Error("Release manifest commit/tree does not match the checked-out source");
  }
  return { version: packageJson.version, electronVersion: EXACT_ELECTRON_VERSION, commit, tree };
}

function extractMacCertificateFingerprint(appPath, run = defaultRun) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-cert-"));
  const prefix = path.join(directory, "signer");
  try {
    run("codesign", ["--display", "--extract-certificates", prefix, appPath]);
    const certificatePath = `${prefix}0`;
    requirePath(certificatePath, "extracted signing certificate", "file");
    return crypto.createHash("sha256").update(fs.readFileSync(certificatePath)).digest("hex");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function findSingleApplication(rootPath) {
  const applications = fs.readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => path.join(rootPath, entry.name));
  if (applications.length !== 1) {
    throw new Error("Signed DMG must contain exactly one application bundle");
  }
  return applications[0];
}

function validateProtocolVariant(schemes, variant) {
  const normalized = Array.isArray(schemes)
    ? schemes.filter((value) => typeof value === "string")
    : [];
  const expected = validateReleaseVariant(variant) === "passport-candidate"
    ? [OAUTH_SCHEME]
    : [];
  if (normalized.length !== expected.length || normalized.some((value, index) => value !== expected[index])) {
    throw new Error(`Packaged protocol registration does not match the ${variant} release variant`);
  }
  return normalized;
}

function validateMacProtocolVariant(appPath, variant, run = defaultRun) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  requirePath(plistPath, "macOS Info.plist", "file");
  const output = run("plutil", ["-convert", "json", "-o", "-", plistPath]);
  let info;
  try {
    info = JSON.parse(output.stdout);
  } catch {
    throw new Error("macOS Info.plist could not be decoded");
  }
  const schemes = (info.CFBundleURLTypes || []).flatMap((entry) => entry.CFBundleURLSchemes || []);
  return validateProtocolVariant(schemes, variant);
}

function mountMacArtifact(artifactPath, run = defaultRun) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-dmg-"));
  const mountPath = path.join(workDir, "volume");
  fs.mkdirSync(mountPath, { mode: 0o700 });
  let mounted = false;
  try {
    run("hdiutil", ["verify", artifactPath]);
    run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPath, artifactPath]);
    mounted = true;
    const appPath = findSingleApplication(mountPath);
    return {
      appPath,
      cleanup: () => {
        try {
          if (mounted) run("hdiutil", ["detach", mountPath]);
        } finally {
          mounted = false;
          fs.rmSync(workDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (mounted) {
      try { run("hdiutil", ["detach", mountPath]); } catch { /* best effort after failure */ }
    }
    fs.rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
}

function runPackagedRuntime(targetPath, manifest, run = defaultRun, platform = process.platform) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-release-runtime-"));
  const resultPath = path.join(workDir, "result.json");
  const userDataPath = path.join(workDir, "user-data");
  const runtimeEnvironment = {
    ...process.env,
    WORDTAKER_PACKAGED_RUNTIME_SMOKE: "1",
    WORDTAKER_EXPECTED_APP_VERSION: manifest.version,
    WORDTAKER_EXPECTED_ELECTRON_VERSION: manifest.electronVersion,
    WORDTAKER_EXPECTED_ARCH: manifest.arch,
    WORDTAKER_EXPECTED_VARIANT: manifest.variant,
    WORDTAKER_RUNTIME_SMOKE_RESULT: resultPath,
  };
  try {
    if (platform === "darwin") {
      const environmentArguments = Object.entries(runtimeEnvironment)
        .filter(([key]) => key.startsWith("WORDTAKER_"))
        .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
      run("open", ["-n", "-W", ...environmentArguments, targetPath, "--args", `--user-data-dir=${userDataPath}`]);
    } else if (platform === "win32") {
      run(targetPath, [`--user-data-dir=${userDataPath}`], { env: runtimeEnvironment });
    } else {
      throw new Error("Packaged release runtime is supported only on macOS and Windows");
    }
    requirePath(resultPath, "packaged runtime receipt", "file");
    return {
      resultPath,
      cleanup: () => fs.rmSync(workDir, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
}

function normalizeRuntimeExecution(execution) {
  if (typeof execution === "string") return { resultPath: execution, cleanup: () => {} };
  if (!execution || typeof execution.resultPath !== "string") {
    throw new Error("Packaged runtime did not produce a receipt path");
  }
  return { resultPath: execution.resultPath, cleanup: execution.cleanup || (() => {}) };
}

function verifyMacArtifact(manifest, dependencies = {}) {
  const run = dependencies.run || defaultRun;
  const mountArtifact = dependencies.mountArtifact || ((artifactPath) => mountMacArtifact(artifactPath, run));
  const executeRuntime = dependencies.runPackagedRuntime
    || ((appPath) => runPackagedRuntime(appPath, manifest, run, "darwin"));
  const extractCertificateFingerprint = dependencies.extractCertificateFingerprint
    || ((appPath) => extractMacCertificateFingerprint(appPath, run));
  const verifyProvenance = dependencies.verifyProvenance || verifyManifestProvenance;
  const verifyProtocolVariant = dependencies.validateProtocolVariant
    || ((appPath) => validateMacProtocolVariant(appPath, manifest.variant, run));
  verifyProvenance(manifest);
  const artifactPath = requirePath(manifest.artifactPath, "macOS artifact", "file");
  const expectedSignerFingerprint = normalizeFingerprint(manifest.expectedSignerFingerprint);
  const expectedTeamId = requireExactText(
    manifest.expectedTeamId,
    "expected Apple team identifier",
    /^[A-Z0-9]{10}$/,
  );

  const mounted = mountArtifact(artifactPath);
  let runtimeExecution;
  let receipt;
  let verificationError;
  try {
    const appPath = requirePath(mounted.appPath, "mounted macOS application", "directory");
    verifyProtocolVariant(appPath);
    run("codesign", ["--verify", "--deep", "--strict", appPath]);
    const signatureOutput = run("codesign", ["--display", "--verbose=4", appPath]);
    const signature = parseMacSignatureDetails(
      `${signatureOutput.stdout || ""}\n${signatureOutput.stderr || ""}`,
    );
    if (signature.teamId !== expectedTeamId) {
      throw new Error("macOS TeamIdentifier does not match the pinned release team");
    }
    const signerFingerprint = normalizeFingerprint(extractCertificateFingerprint(appPath));
    if (signerFingerprint !== expectedSignerFingerprint) {
      throw new Error("macOS signer fingerprint does not match the pinned certificate");
    }
    const assessmentOutput = run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
    validateMacAssessment(`${assessmentOutput.stdout || ""}\n${assessmentOutput.stderr || ""}`);
    run("xcrun", ["stapler", "validate", appPath]);
    run("xcrun", ["stapler", "validate", artifactPath]);
    runtimeExecution = normalizeRuntimeExecution(executeRuntime(appPath));
    const runtime = validateRuntimeResult(
      readJsonFile(runtimeExecution.resultPath, "macOS runtime receipt"),
      {
        version: manifest.version,
        electronVersion: manifest.electronVersion,
        arch: manifest.arch,
        variant: manifest.variant,
        platform: "macos",
      },
    );
    receipt = createReleaseReceipt({
      ...manifest,
      platform: "macos",
      artifact: { name: path.basename(artifactPath), sha256: sha256File(artifactPath) },
      signer: {
        authority: signature.authority,
        fingerprint: signerFingerprint,
        teamId: signature.teamId,
      },
      notarization: { accepted: true, appStapled: true, artifactStapled: true },
      runtime,
    });
  } catch (error) {
    verificationError = error;
  }
  const cleanupError = runCleanupSteps([runtimeExecution?.cleanup, mounted.cleanup]);
  if (verificationError) throw verificationError;
  if (cleanupError) throw cleanupError;
  writeReceipt(manifest.receiptPath, receipt);
  return receipt;
}

function windowsSignatureCommand(targetPath) {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    [
      "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]",
      "$signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256) } else { $null }",
      "$timestamp = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256) } else { $null }",
      "[pscustomobject]@{ Status = [string]$signature.Status; SignerSha256 = $signer; TimestampSha256 = $timestamp } | ConvertTo-Json -Compress",
    ].join("; "),
    targetPath,
  ];
}

function validateWindowsProtocolVariant(installedAppPath, variant, run = defaultRun) {
  const command = [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    [
      "$root = 'Registry::HKEY_CURRENT_USER\\Software\\Classes\\wangsan-wordtaker'",
      "$exists = Test-Path -LiteralPath $root",
      "$urlProtocol = $false",
      "$openCommand = $null",
      "if ($exists) {",
      "  $rootKey = Get-Item -LiteralPath $root",
      "  $urlProtocol = $rootKey.GetValueNames() -contains 'URL Protocol'",
      "  $commandPath = Join-Path $root 'shell\\open\\command'",
      "  if (Test-Path -LiteralPath $commandPath) { $openCommand = [string](Get-Item -LiteralPath $commandPath).GetValue('') }",
      "}",
      "[pscustomobject]@{ Exists = [bool]$exists; UrlProtocolPresent = [bool]$urlProtocol; Command = $openCommand } | ConvertTo-Json -Compress",
    ].join("; "),
  ];
  let evidence;
  try {
    evidence = JSON.parse(run("powershell.exe", command).stdout);
  } catch {
    throw new Error("Windows protocol registration check returned invalid JSON");
  }
  if (
    !evidence
    || typeof evidence !== "object"
    || typeof evidence.Exists !== "boolean"
    || typeof evidence.UrlProtocolPresent !== "boolean"
    || (evidence.Command !== null && typeof evidence.Command !== "string")
  ) {
    throw new Error("Windows protocol registration check returned invalid evidence");
  }

  const releaseVariant = validateReleaseVariant(variant);
  if (releaseVariant === "default") {
    if (evidence.Exists || evidence.UrlProtocolPresent || evidence.Command !== null) {
      throw new Error("Default Windows package must not register the Passport protocol");
    }
    return [];
  }

  const executable = String(installedAppPath || "");
  if (!executable || /[\u0000-\u001F\u007F]/.test(executable)) {
    throw new Error("Installed Windows executable path is invalid");
  }
  const expectedCommand = `"${executable}" "%1"`;
  if (
    evidence.Exists !== true
    || evidence.UrlProtocolPresent !== true
    || String(evidence.Command || "").toLowerCase() !== expectedCommand.toLowerCase()
  ) {
    throw new Error("Windows Passport protocol command is not bound to the installed executable");
  }
  return validateProtocolVariant([OAUTH_SCHEME], releaseVariant);
}

function verifyWindowsSignature(targetPath, expectedSignerFingerprint, run) {
  const powershell = run("powershell.exe", windowsSignatureCommand(targetPath));
  let signature;
  try {
    signature = JSON.parse(powershell.stdout);
  } catch {
    throw new Error("Authenticode verification did not return valid JSON");
  }
  const verified = validateWindowsSignature(signature, expectedSignerFingerprint);
  run("signtool.exe", ["verify", "/pa", "/all", "/v", targetPath]);
  return verified;
}

function findWindowsExecutable(rootPath, { uninstall = false } = {}) {
  const queue = [rootPath];
  const candidates = [];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(entryPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) {
        const isUninstaller = /unins|uninstall/i.test(entry.name);
        if (isUninstaller === uninstall) candidates.push(entryPath);
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error(uninstall ? "Windows uninstaller was not found" : "Installed Windows app was not found");
  }
  candidates.sort();
  return candidates[0];
}

function installWindowsArtifact(installerPath, run = defaultRun) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-windows-install-"));
  const installPath = path.join(workDir, "app");
  fs.mkdirSync(installPath, { mode: 0o700 });
  let installed = false;
  try {
    run(installerPath, ["/S", `/D=${installPath}`]);
    installed = true;
    const installedAppPath = findWindowsExecutable(installPath);
    return {
      installedAppPath,
      cleanup: () => {
        try {
          if (installed) {
            const uninstallerPath = findWindowsExecutable(installPath, { uninstall: true });
            run(uninstallerPath, ["/S"]);
          }
        } finally {
          installed = false;
          fs.rmSync(workDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (installed) {
      try {
        const uninstallerPath = findWindowsExecutable(installPath, { uninstall: true });
        run(uninstallerPath, ["/S"]);
      } catch { /* best effort after a failed install gate */ }
    }
    fs.rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
}

function verifyWindowsArtifact(manifest, dependencies = {}) {
  const run = dependencies.run || defaultRun;
  const installArtifact = dependencies.installArtifact
    || ((installerPath) => installWindowsArtifact(installerPath, run));
  const executeRuntime = dependencies.runPackagedRuntime
    || ((appPath) => runPackagedRuntime(appPath, manifest, run, "win32"));
  const verifyProvenance = dependencies.verifyProvenance || verifyManifestProvenance;
  const verifyProtocolVariant = dependencies.validateProtocolVariant
    || ((installedAppPath) => validateWindowsProtocolVariant(
      installedAppPath,
      manifest.variant,
      run,
    ));
  const verifyProtocolRemoval = dependencies.validateProtocolRemoval
    || (() => validateWindowsProtocolVariant(null, "default", run));
  verifyProvenance(manifest);
  const releaseVariant = validateReleaseVariant(manifest.variant);
  const requiresPortable = releaseVariant === "default";
  if (!requiresPortable && manifest.portablePath !== undefined) {
    throw new Error("Passport candidate releases must not include a portable Windows app");
  }
  const installerPath = requirePath(manifest.installerPath, "Windows installer", "file");
  const portablePath = requiresPortable
    ? requirePath(manifest.portablePath, "Windows portable app", "file")
    : null;
  const expectedSignerFingerprint = normalizeFingerprint(manifest.expectedSignerFingerprint);
  const signatures = {
    installer: verifyWindowsSignature(installerPath, expectedSignerFingerprint, run),
  };
  if (portablePath) {
    signatures.portable = verifyWindowsSignature(portablePath, expectedSignerFingerprint, run);
  }
  const installation = installArtifact(installerPath);
  let installedRuntimeExecution;
  let portableRuntimeExecution;
  let receipt;
  let verificationError;
  try {
    const installedAppPath = requirePath(
      installation.installedAppPath,
      "installed Windows app",
      "file",
    );
    verifyProtocolVariant(installedAppPath);
    signatures.installedApp = verifyWindowsSignature(
      installedAppPath,
      expectedSignerFingerprint,
      run,
    );
    installedRuntimeExecution = normalizeRuntimeExecution(executeRuntime(installedAppPath));
    if (portablePath) {
      portableRuntimeExecution = normalizeRuntimeExecution(executeRuntime(portablePath));
    }
    const expectedRuntime = {
      version: manifest.version,
      electronVersion: manifest.electronVersion,
      arch: manifest.arch,
      variant: releaseVariant,
      platform: "windows",
    };
    const runtime = {
      installed: validateRuntimeResult(
        readJsonFile(installedRuntimeExecution.resultPath, "installed Windows runtime receipt"),
        expectedRuntime,
      ),
    };
    if (portableRuntimeExecution) {
      runtime.portable = validateRuntimeResult(
        readJsonFile(portableRuntimeExecution.resultPath, "portable Windows runtime receipt"),
        expectedRuntime,
      );
    }
    verifyProtocolVariant(installedAppPath);
    const artifacts = {
      installer: { name: path.basename(installerPath), sha256: sha256File(installerPath) },
      installedApp: { name: path.basename(installedAppPath), sha256: sha256File(installedAppPath) },
    };
    if (portablePath) {
      artifacts.portable = { name: path.basename(portablePath), sha256: sha256File(portablePath) };
    }
    receipt = createReleaseReceipt({
      ...manifest,
      platform: "windows",
      artifacts,
      signatures,
      runtime,
    });
  } catch (error) {
    verificationError = error;
  }
  const cleanupError = runCleanupSteps([
    installedRuntimeExecution?.cleanup,
    portableRuntimeExecution?.cleanup,
    installation.cleanup,
  ]);
  let protocolRemovalError;
  try {
    verifyProtocolRemoval();
  } catch (error) {
    protocolRemovalError = error;
  }
  if (verificationError) throw verificationError;
  if (cleanupError) throw cleanupError;
  if (protocolRemovalError) throw protocolRemovalError;
  writeReceipt(manifest.receiptPath, receipt);
  return receipt;
}

function readManifest(manifestPath) {
  return readJsonFile(path.resolve(manifestPath), "signed artifact manifest");
}

async function runSignedArtifactGateCli({
  argv = process.argv.slice(2),
  processLike = process,
  readManifest: read = readManifest,
  verifyMac = verifyMacArtifact,
  verifyWindows = verifyWindowsArtifact,
} = {}) {
  try {
    if (argv.length !== 2 || argv[0] !== "--manifest" || !argv[1]) {
      throw new Error("Usage: signed-artifact-gate.js --manifest <absolute-manifest.json>");
    }
    const manifest = read(argv[1]);
    let receipt;
    if (manifest.platform === "macos") receipt = verifyMac(manifest);
    else if (manifest.platform === "windows") receipt = verifyWindows(manifest);
    else throw new Error("Manifest platform must be macos or windows");
    processLike.stdout.write(`${JSON.stringify(receipt)}\n`);
    return receipt;
  } catch (error) {
    processLike.stderr.write(`Signed artifact verification failed: ${error.message}\n`);
    processLike.exitCode = 1;
    return null;
  }
}

if (require.main === module) {
  void runSignedArtifactGateCli();
}

module.exports = {
  EXACT_APP_VERSION,
  EXACT_ELECTRON_VERSION,
  MAC_APP_IDENTIFIER,
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
  safeRuntimeSummary,
  safeArtifactSummary,
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
};
