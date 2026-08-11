"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const MIN_ELECTRON_VERSION = "43.3.0";
const MIN_ELECTRON_BUILDER_VERSION = "26.15.7";
const MIN_BETTER_SQLITE3_VERSION = "13.0.3";
const MIN_NODE_VERSION = "22.12.0";
const OAUTH_SCHEME = "wangsan-wordtaker";
const PNPM_VERSION = "11.5.3";

function parseVersion(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(value, minimum) {
  const current = parseVersion(value);
  const floor = parseVersion(minimum);
  if (!current || !floor) return false;
  for (let index = 0; index < floor.length; index += 1) {
    if (current[index] > floor[index]) return true;
    if (current[index] < floor[index]) return false;
  }
  return true;
}

function includesAll(source, values) {
  const text = String(source || "");
  return values.every((value) => text.includes(value));
}

function countOccurrences(source, value) {
  return String(source || "").split(value).length - 1;
}

function validateDesktopReleaseSnapshot(snapshot) {
  const issues = [];
  const packageJson = snapshot.packageJson || {};
  const devDependencies = packageJson.devDependencies || {};
  const dependencies = packageJson.dependencies || {};
  const scripts = packageJson.scripts || {};
  const build = packageJson.build || {};

  if (packageJson.packageManager !== `pnpm@${PNPM_VERSION}`) {
    issues.push(`pnpm must be pinned to ${PNPM_VERSION} in package.json`);
  }

  if (!/^\d+\.\d+\.\d+$/.test(String(packageJson.version || ""))) {
    issues.push("package.json version must be an exact SemVer value");
  }

  const electronVersion = devDependencies.electron;
  if (
    !/^\d+\.\d+\.\d+$/.test(String(electronVersion || "")) ||
    !versionAtLeast(electronVersion, MIN_ELECTRON_VERSION)
  ) {
    issues.push(`Electron must be pinned at or above ${MIN_ELECTRON_VERSION}`);
  }

  const builderVersion = devDependencies["electron-builder"];
  if (
    !/^\d+\.\d+\.\d+$/.test(String(builderVersion || "")) ||
    !versionAtLeast(builderVersion, MIN_ELECTRON_BUILDER_VERSION)
  ) {
    issues.push(
      `electron-builder must be pinned at or above ${MIN_ELECTRON_BUILDER_VERSION}`,
    );
  }

  const sqliteVersion = dependencies["better-sqlite3"];
  if (
    !/^\d+\.\d+\.\d+$/.test(String(sqliteVersion || "")) ||
    !versionAtLeast(sqliteVersion, MIN_BETTER_SQLITE3_VERSION)
  ) {
    issues.push(`better-sqlite3 must be pinned at or above ${MIN_BETTER_SQLITE3_VERSION}`);
  }

  if (!/^\d+\.\d+\.\d+$/.test(String(devDependencies["@electron/rebuild"] || ""))) {
    issues.push("@electron/rebuild must be pinned to an exact version");
  }

  if (!versionAtLeast(packageJson.engines?.node, MIN_NODE_VERSION)) {
    issues.push(`Node.js engines must require ${MIN_NODE_VERSION} or newer`);
  }

  if (build.mac?.notarize !== true) {
    issues.push("electron-builder mac.notarize must use the v26 boolean contract");
  }
  if (!versionAtLeast(build.mac?.minimumSystemVersion, "12.0.0")) {
    issues.push("Electron 43 packages must declare macOS 12 or newer");
  }

  if (
    scripts["prepare:electron-runtime"] !== "node node_modules/electron/install.js" ||
    scripts["verify:desktop-release"] !== "node scripts/verify-desktop-release.js" ||
    scripts["test:desktop:coverage"] !==
      "vitest run --config vitest.desktop.config.mjs --coverage" ||
    scripts["smoke:electron-runtime"] !==
      "cross-env WORDTAKER_PACKAGED_RUNTIME_SMOKE=1 electron ."
  ) {
    issues.push("desktop release verification scripts must be declared in package.json");
  }

  if (
    !Array.isArray(build.files) ||
    !build.files.includes("scripts/electron-runtime-smoke.js") ||
    !includesAll(snapshot.mainSource, [
      "WORDTAKER_PACKAGED_RUNTIME_SMOKE",
      'app.setName("WordTaker Runtime Smoke")',
      'require("./scripts/electron-runtime-smoke")',
      "return",
    ]) ||
    String(snapshot.mainSource || "").indexOf("WORDTAKER_PACKAGED_RUNTIME_SMOKE") >
      String(snapshot.mainSource || "").indexOf("const LogManager")
  ) {
    issues.push("packaged runtime smoke must execute from the production Electron main process");
  }

  if (
    !includesAll(snapshot.workspaceConfig, [
      "allowBuilds:",
      "'@tailwindcss/oxide': true",
      "better-sqlite3: true",
      "electron: false",
      "esbuild: true",
      "ffmpeg-static: true",
      "uiohook-napi: true",
    ]) ||
    String(snapshot.workspaceConfig || "").includes("set this to true or false") ||
    String(snapshot.workspaceConfig || "").includes("onlyBuiltDependencies:")
  ) {
    issues.push("pnpm build policy must use reviewed boolean allowBuilds entries");
  }

  const registeredSchemes = (build.protocols || []).flatMap((entry) => entry.schemes || []);
  if (!registeredSchemes.includes(OAUTH_SCHEME)) {
    issues.push(`electron-builder protocols must register ${OAUTH_SCHEME}`);
  }

  for (const [target, config] of [
    ["win", build.win],
    ["nsis", build.nsis],
    ["portable", build.portable],
    ["dmg", build.dmg],
  ]) {
    const artifactName = config?.artifactName;
    if (
      typeof artifactName !== "string" ||
      !artifactName.includes("${version}") ||
      !artifactName.includes("${arch}")
    ) {
      issues.push(`${target}.artifactName must include \${version} and \${arch}`);
    }
  }

  if (
    !String(snapshot.lockfileText || "").includes(`specifier: ${electronVersion}`) ||
    !String(snapshot.lockfileText || "").includes(`version: ${electronVersion}`)
  ) {
    issues.push("pnpm-lock.yaml must resolve the pinned Electron version");
  }

  if (
    !includesAll(snapshot.ciWorkflow, [
      "permissions:",
      "contents: read",
      `version: ${PNPM_VERSION}`,
      "node-version: 22.22.0",
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm run verify:desktop-release",
      "pnpm run test:auth:coverage",
      "pnpm run test:desktop:coverage",
      "pnpm run build:renderer",
      "macos-latest",
      "windows-latest",
      "pnpm run prepare:electron-runtime",
      "pnpm exec electron-rebuild -f -w better-sqlite3 -w uiohook-napi",
      "pnpm run smoke:electron-runtime",
    ]) ||
    String(snapshot.ciWorkflow || "").includes("continue-on-error: true")
  ) {
    issues.push("CI must enforce frozen installs, lint/build/auth coverage and macOS/Windows runtime smoke");
  }

  if (
    !includesAll(snapshot.windowsWorkflow, [
      "contents: read",
      `version: ${PNPM_VERSION}`,
      "node-version: 22.22.0",
      "runs-on: windows-11-arm",
      "needs: [verify, verify-arm64-runtime]",
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm run verify:desktop-release",
      "pnpm run test:auth:coverage",
      "pnpm run test:desktop:coverage",
      "pnpm run prepare:electron-runtime",
      "pnpm run smoke:electron-runtime",
      "pnpm audit --audit-level high",
      "WORDTAKER_PACKAGED_RUNTIME_SMOKE",
      "Verify packaged Electron runtime",
      "Verify packaged Electron runtime (x64)",
      "verify-arm64-package:",
      "needs: build-win",
      "Verify packaged Electron runtime (ARM64)",
      "Verify packaged embedded Python (ARM64)",
      "resources\\app.asar.unpacked\\python",
      "pnpm run prepare:sensevoice",
      "pnpm run verify:sensevoice",
      "scripts/sensevoice-model.js --verify",
      "--model-dir=",
      "pnpm exec electron-rebuild -f -w better-sqlite3 -w uiohook-napi",
      "pnpm exec electron-builder",
    ]) ||
    String(snapshot.windowsWorkflow || "").includes("npx --yes @electron/rebuild") ||
    String(snapshot.windowsWorkflow || "").includes("snapshot_download(")
  ) {
    issues.push("Windows packaging must use frozen tooling plus auth/runtime verification");
  }
  if (
    String(snapshot.windowsWorkflow || "").includes("contents: write") ||
    String(snapshot.windowsWorkflow || "").includes("softprops/action-gh-release") ||
    /push:\s*[\s\S]{0,120}tags:/m.test(String(snapshot.windowsWorkflow || ""))
  ) {
    issues.push("Windows unsigned validation artifacts must never auto-publish to a release");
  }

  if (
    !includesAll(snapshot.macWorkflow, [
      "push:",
      "branches: [main]",
      "pnpm-workspace.yaml",
      "entitlements.mac.plist",
      `version: ${PNPM_VERSION}`,
      "macos-15",
      "macos-15-intel",
      "node-version: 22.22.0",
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm run prepare:electron-runtime",
      "pnpm exec electron-rebuild -f -w better-sqlite3 -w uiohook-napi",
      "pnpm run verify:desktop-release",
      "pnpm run test:auth:coverage",
      "pnpm run test:desktop:coverage",
      "pnpm run smoke:electron-runtime",
      "pnpm audit --audit-level high",
      "pnpm run pack",
      "WORDTAKER_PACKAGED_RUNTIME_SMOKE",
      "Verify packaged Electron runtime",
      "open -n -W",
      "security create-keychain",
      OAUTH_SCHEME,
      "CFBundleShortVersionString",
      "CFBundleVersion",
    ])
    || countOccurrences(snapshot.macWorkflow, '"assets/**"') < 2
  ) {
    issues.push("macOS packaging must verify runtime storage, package version and OAuth scheme");
  }

  if (
    !includesAll(snapshot.readmeSource, ["Node.js 22.12+", "Python 3.11+", "macOS 12+"]) ||
    String(snapshot.readmeSource || "").includes("img.shields.io/badge/version-")
  ) {
    issues.push("README runtime requirements must match the desktop release contract without a second version badge");
  }
  if (
    !includesAll(snapshot.windowsBuildGuide, [
      "workflow_dispatch",
      "GitHub Actions artifacts",
      "gh run download",
      "signed release gate",
    ]) ||
    String(snapshot.windowsBuildGuide || "").includes("gh release download")
  ) {
    issues.push("Windows build guide must describe the manual validation workflow and signed release gate");
  }

  if (!includesAll(snapshot.ipcSource, ["get-app-version", "app.getVersion()"])) {
    issues.push("main-process version IPC must return app.getVersion()");
  }
  if (!includesAll(snapshot.preloadSource, ["getAppVersion", "get-app-version"])) {
    issues.push("preload must expose the runtime version IPC");
  }
  if (!includesAll(snapshot.settingsSource, ["getAppVersion", "appVersion"])) {
    issues.push("About UI must display the runtime app version");
  }
  if (!String(snapshot.updaterSource || "").includes("app.getVersion()")) {
    issues.push("updater must compare against app.getVersion()");
  }
  if (String(snapshot.viteConfigSource || "").includes("__APP_VERSION__")) {
    issues.push("__APP_VERSION__ is a forbidden second compile-time version source");
  }

  return issues;
}

async function readOptional(filePath, readFile = fs.readFile) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function inspectDesktopRelease(rootDir = path.resolve(__dirname, "..")) {
  const read = (relativePath) => readOptional(path.join(rootDir, relativePath));
  const packageJson = JSON.parse(await read("package.json"));
  const snapshot = {
    packageJson,
    workspaceConfig: await read("pnpm-workspace.yaml"),
    lockfileText: await read("pnpm-lock.yaml"),
    ciWorkflow: await read(".github/workflows/ci.yml"),
    windowsWorkflow: await read(".github/workflows/build-windows.yml"),
    macWorkflow: await read(".github/workflows/build-macos.yml"),
    mainSource: await read("main.js"),
    ipcSource: await read("src/helpers/ipcHandlers.js"),
    preloadSource: await read("preload.js"),
    settingsSource: await read("src/settings.jsx"),
    updaterSource: await read("src/helpers/updater.js"),
    viteConfigSource: await read("src/vite.config.js"),
    readmeSource: await read("README.md"),
    windowsBuildGuide: await read("docs/WINDOWS_BUILD.md"),
  };
  return {
    version: packageJson.version,
    electronVersion: packageJson.devDependencies?.electron,
    issues: validateDesktopReleaseSnapshot(snapshot),
  };
}

async function runDesktopReleaseCli({
  inspect = inspectDesktopRelease,
  processLike = process,
} = {}) {
  try {
    const report = await inspect();
    if (report.issues.length > 0) {
      for (const issue of report.issues) processLike.stderr.write(`- ${issue}\n`);
      processLike.exitCode = 1;
      return report;
    }
    processLike.stdout.write(
      `Desktop release contract OK: app ${report.version}, Electron ${report.electronVersion}\n`,
    );
    return report;
  } catch (error) {
    processLike.stderr.write(`Desktop release verification failed: ${error.message}\n`);
    processLike.exitCode = 1;
    return null;
  }
}

if (require.main === module) {
  void runDesktopReleaseCli();
}

module.exports = {
  MIN_BETTER_SQLITE3_VERSION,
  MIN_ELECTRON_VERSION,
  MIN_ELECTRON_BUILDER_VERSION,
  MIN_NODE_VERSION,
  OAUTH_SCHEME,
  PNPM_VERSION,
  countOccurrences,
  inspectDesktopRelease,
  parseVersion,
  readOptional,
  runDesktopReleaseCli,
  validateDesktopReleaseSnapshot,
  versionAtLeast,
};
