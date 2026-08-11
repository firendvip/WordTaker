import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  MIN_BETTER_SQLITE3_VERSION,
  MIN_ELECTRON_VERSION,
  MIN_ELECTRON_BUILDER_VERSION,
  inspectDesktopRelease,
  parseVersion,
  readOptional,
  runDesktopReleaseCli,
  validateDesktopReleaseSnapshot,
  versionAtLeast,
} = require("../scripts/verify-desktop-release.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function secureSnapshot(overrides = {}) {
  return {
    packageJson: {
      version: "1.29.0",
      packageManager: "pnpm@11.5.3",
      engines: { node: ">=22.12.0" },
      scripts: {
        "prepare:electron-runtime": "node node_modules/electron/install.js",
        "verify:desktop-release": "node scripts/verify-desktop-release.js",
        "test:auth:coverage": "vitest run --config vitest.auth.config.mjs --coverage",
        "test:desktop:coverage": "vitest run --config vitest.desktop.config.mjs --coverage",
        "smoke:electron-runtime":
          "cross-env WORDTAKER_PACKAGED_RUNTIME_SMOKE=1 electron .",
        "pack:passport-candidate":
          "electron-builder --config electron-builder.passport-candidate.cjs --dir",
        "verify:signed-artifact": "node scripts/signed-artifact-gate.js",
      },
      devDependencies: {
        electron: MIN_ELECTRON_VERSION,
        "electron-builder": MIN_ELECTRON_BUILDER_VERSION,
        "@electron/rebuild": "4.2.0",
      },
      dependencies: {
        "better-sqlite3": MIN_BETTER_SQLITE3_VERSION,
      },
      build: {
        files: ["main.js", "scripts/electron-runtime-smoke.js"],
        win: { artifactName: "KittyEcho-${version}-${arch}.${ext}" },
        nsis: { artifactName: "KittyEcho-${version}-${arch}-setup.${ext}" },
        portable: { artifactName: "KittyEcho-${version}-${arch}-portable.exe" },
        dmg: { artifactName: "KittyEcho-${version}-${arch}.${ext}" },
        mac: { minimumSystemVersion: "12.0.0", notarize: true },
      },
    },
    workspaceConfig: [
      "allowBuilds:",
      "  '@tailwindcss/oxide': true",
      "  better-sqlite3: true",
      "  electron: false",
      "  esbuild: true",
      "  ffmpeg-static: true",
      "  uiohook-napi: true",
    ].join("\n"),
    lockfileText: `electron:\n  specifier: ${MIN_ELECTRON_VERSION}\n  version: ${MIN_ELECTRON_VERSION}`,
    ciWorkflow: [
      "permissions:",
      "contents: read",
      "environment: release-signing",
      "persist-credentials: false",
      "version: 11.5.3",
      "node-version: 22.22.0",
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm run verify:desktop-release",
      "pnpm run test:auth:coverage",
      "pnpm run test:desktop:coverage",
      "pnpm run build:renderer",
      "matrix:",
      "os: [macos-latest, windows-latest]",
      "pnpm run prepare:electron-runtime",
      "pnpm exec electron-rebuild -f -w better-sqlite3 -w uiohook-napi",
      "pnpm run smoke:electron-runtime",
    ].join("\n"),
    windowsWorkflow: [
      "permissions:",
      "contents: read",
      "version: 11.5.3",
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
    ].join("\n"),
    macWorkflow: [
      "push:",
      "branches: [main]",
      "pnpm-workspace.yaml",
      '"assets/**"',
      '"assets/**"',
      "entitlements.mac.plist",
      "version: 11.5.3",
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
      "Expected no wangsan-wordtaker scheme",
      "CFBundleShortVersionString",
      "CFBundleVersion",
    ].join("\n"),
    candidateConfigSource: [
      "wordtakerPassportCandidate: true",
      "protocols:",
      "Wangsan WordTaker OAuth",
      'schemes: ["wangsan-wordtaker"]',
      'include: "build/installer-passport-candidate.nsh"',
      'target: "nsis"',
    ].join("\n"),
    candidateInstallerSource: [
      '!include "${BUILD_RESOURCES_DIR}\\installer.nsh"',
      "!macro customInstall",
      'WriteRegStr HKCU "Software\\Classes\\wangsan-wordtaker" "URL Protocol" ""',
      'WriteRegStr HKCU "Software\\Classes\\wangsan-wordtaker\\shell\\open\\command" ""',
      "$INSTDIR\\${APP_EXECUTABLE_FILENAME}",
      "%1",
      "!macro customUnInstall",
      "ReadRegStr",
      "StrCmp",
      'DeleteRegKey HKCU "Software\\Classes\\wangsan-wordtaker"',
    ].join("\n"),
    releaseGateWorkflow: [
      "workflow_dispatch:",
      "permissions:",
      "contents: read",
      "environment: release-signing",
      "persist-credentials: false",
      "- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "- uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      "forceCodeSigning=true",
      "codesign --verify --deep --strict",
      "spctl --assess --type execute",
      "xcrun stapler validate",
      "xcrun notarytool submit",
      "security create-keychain",
      "security delete-keychain",
      "if: always()",
      "MACOS_SIGNER_SHA256",
      "APPLE_TEAM_ID",
      "Get-AuthenticodeSignature",
      "TimeStamperCertificate",
      "WINDOWS_SIGNER_SHA256",
      "signtool verify /pa /all /v",
      "WORDTAKER_PACKAGED_RUNTIME_SMOKE",
      "signed-artifact-gate.js",
      "signed-gate-artifacts-macos",
      "signed-gate-artifacts-windows",
      "--publish never",
    ].join("\n"),
    changelogSource: "# Changelog\n\n## [1.29.0] - 2026-08-11",
    appSource: "syncRuntimeDocumentTitle({ getAppVersion })",
    historySource: "syncRuntimeDocumentTitle({ getAppVersion })",
    windowManagerSource: "_runtimeTitle() { return app.getVersion(); }",
    mainSource: [
      'if (process.env.WORDTAKER_PACKAGED_RUNTIME_SMOKE === "1") {',
      'app.setName("WordTaker Runtime Smoke")',
      'require("./scripts/electron-runtime-smoke")',
      "return",
      "const LogManager = require('./src/helpers/logManager')",
    ].join("\n"),
    ipcSource: 'ipcMain.handle("get-app-version", () => app.getVersion())',
    preloadSource: 'getAppVersion: () => ipcRenderer.invoke("get-app-version")',
    settingsSource: "getAppVersion(); 版本 {appVersion}",
    updaterSource: "const current = app.getVersion();",
    viteConfigSource: "export default defineConfig({});",
    readmeSource: "Node.js 22.12+\nPython 3.11+\nmacOS 12+",
    windowsBuildGuide: [
      "workflow_dispatch",
      "GitHub Actions artifacts",
      "gh run download",
      "signed release gate",
    ].join("\n"),
    ...overrides,
  };
}

describe("desktop release contract", () => {
  it("passes the repository security, packaging and version-source contract", async () => {
    const report = await inspectDesktopRelease(ROOT);
    expect(report.issues).toEqual([]);
    expect(report.version).toBe(JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")).version);
  });

  it("rejects unsafe Electron/build tooling and an unpinned Node runtime", () => {
    const snapshot = secureSnapshot();
    snapshot.packageJson.devDependencies.electron = "36.5.0";
    snapshot.packageJson.devDependencies["electron-builder"] = "24.13.3";
    snapshot.packageJson.dependencies["better-sqlite3"] = "11.10.0";
    snapshot.packageJson.engines.node = ">=20";

    expect(validateDesktopReleaseSnapshot(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Electron"),
        expect.stringContaining("electron-builder"),
        expect.stringContaining("better-sqlite3"),
        expect.stringContaining("Node.js"),
      ]),
    );
  });

  it("pins the only desktop release runtime to Electron 43.3.0 exactly", () => {
    const snapshot = secureSnapshot();
    snapshot.packageJson.devDependencies.electron = "43.3.1";
    snapshot.lockfileText = "electron:\n  specifier: 43.3.1\n  version: 43.3.1";
    expect(validateDesktopReleaseSnapshot(snapshot)).toEqual(
      expect.arrayContaining([expect.stringContaining("Electron")]),
    );
  });

  it("requires v1.29.0 changelog alignment and every user-visible runtime version wire", () => {
    const snapshot = secureSnapshot({
      changelogSource: "# Changelog\n\n## [1.28.0] - 2026-07-11",
      historySource: "document.title = '弦外小猫'",
      windowManagerSource: "title: '弦外小猫'",
    });
    expect(validateDesktopReleaseSnapshot(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CHANGELOG"),
        expect.stringContaining("user-visible version"),
      ]),
    );
  });

  it("separates the default package from the explicit Passport candidate package", () => {
    const defaultRegistered = secureSnapshot();
    defaultRegistered.packageJson.build.protocols = [
      { name: "Wangsan WordTaker OAuth", schemes: ["wangsan-wordtaker"] },
    ];
    expect(validateDesktopReleaseSnapshot(defaultRegistered)).toEqual(
      expect.arrayContaining([expect.stringContaining("default package")]),
    );

    expect(validateDesktopReleaseSnapshot(secureSnapshot({ candidateConfigSource: "" })))
      .toEqual(expect.arrayContaining([expect.stringContaining("candidate") ]));

    expect(validateDesktopReleaseSnapshot(secureSnapshot({ candidateInstallerSource: "" })))
      .toEqual(expect.arrayContaining([expect.stringContaining("candidate") ]));

    const candidatePortable = secureSnapshot();
    candidatePortable.candidateConfigSource += '\ntarget: "portable"';
    expect(validateDesktopReleaseSnapshot(candidatePortable))
      .toEqual(expect.arrayContaining([expect.stringContaining("portable") ]));
  });

  it("requires a manual non-publishing signed artifact gate for both desktop platforms", () => {
    const snapshot = secureSnapshot({ releaseGateWorkflow: "runs-on: ubuntu-latest" });
    expect(validateDesktopReleaseSnapshot(snapshot)).toEqual(
      expect.arrayContaining([expect.stringContaining("signed artifact")]),
    );
    const publishing = secureSnapshot();
    publishing.releaseGateWorkflow += "\ncontents: write\naction-gh-release\n--publish always";
    expect(validateDesktopReleaseSnapshot(publishing)).toEqual(
      expect.arrayContaining([expect.stringContaining("signed artifact")]),
    );
  });

  it("requires pinned actions, isolated signing state and retained verified artifact bytes", () => {
    const safe = secureSnapshot();
    expect(validateDesktopReleaseSnapshot(safe).filter((issue) => issue.includes("signed artifact")))
      .toEqual([]);

    const unsafe = secureSnapshot();
    unsafe.releaseGateWorkflow = unsafe.releaseGateWorkflow
      .replace("security delete-keychain", "echo keychain-left-behind")
      .replace(
        "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
        "actions/checkout@v4",
      )
      .replace("signed-gate-artifacts-windows", "receipt-only");
    expect(validateDesktopReleaseSnapshot(unsafe)).toEqual(
      expect.arrayContaining([expect.stringContaining("signed artifact")]),
    );
  });

  it("requires the Electron 43 native ABI and builder notarization contract", () => {
    const snapshot = secureSnapshot();
    snapshot.packageJson.devDependencies["@electron/rebuild"] = "^4.2.0";
    snapshot.packageJson.build.mac.notarize = { teamId: "legacy-shape" };
    snapshot.packageJson.build.mac.minimumSystemVersion = "11.0.0";

    expect(validateDesktopReleaseSnapshot(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("@electron/rebuild"),
        expect.stringContaining("notarize"),
        expect.stringContaining("macOS 12"),
      ]),
    );
  });

  it("rejects a second compile-time version source and unversioned artifacts", () => {
    const snapshot = secureSnapshot({
      viteConfigSource: "define: { __APP_VERSION__: JSON.stringify('1.0.0') }",
    });
    snapshot.packageJson.build.dmg.artifactName = "KittyEcho.dmg";

    expect(validateDesktopReleaseSnapshot(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("__APP_VERSION__"),
        expect.stringContaining("artifactName"),
      ]),
    );
  });

  it("requires frozen installs, auth coverage and real macOS/Windows runtime gates", () => {
    const issues = validateDesktopReleaseSnapshot(
      secureSnapshot({
        ciWorkflow: "node-version: 20\npnpm install --no-frozen-lockfile",
        windowsWorkflow: "pnpm exec electron-builder",
        macWorkflow: "runs-on: ubuntu-latest",
      }),
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CI"),
        expect.stringContaining("Windows"),
        expect.stringContaining("macOS"),
      ]),
    );
  });

  it("keeps release documentation and workflow trigger paths aligned", () => {
    const snapshot = secureSnapshot({
      readmeSource:
        '<img src="https://img.shields.io/badge/version-0.1.0-brightgreen">\nNode.js 18+\nPython 3.8+\nmacOS 10.15+',
      windowsBuildGuide: "push tag v*\ngh release download",
      macWorkflow: secureSnapshot().macWorkflow.replace('"assets/**"', '"docs/**"'),
    });

    expect(validateDesktopReleaseSnapshot(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("README"),
        expect.stringContaining("Windows build guide"),
        expect.stringContaining("macOS"),
      ]),
    );
  });

  it("pins pnpm build policy and forbids automatic unsigned release publishing", () => {
    const snapshot = secureSnapshot({
      workspaceConfig: "allowBuilds:\n  electron: set this to true or false\nonlyBuiltDependencies:",
    });
    snapshot.packageJson.packageManager = "pnpm@9.15.0";
    snapshot.windowsWorkflow +=
      "\npush:\n  tags: ['v*']\npermissions:\n  contents: write\nuses: softprops/action-gh-release@v2";

    expect(validateDesktopReleaseSnapshot(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("pnpm"),
        expect.stringContaining("build policy"),
        expect.stringContaining("unsigned"),
      ]),
    );
  });

  it("requires the final packaged application to execute the production runtime smoke", () => {
    const snapshot = secureSnapshot({
      mainSource: "startApp();",
      windowsWorkflow: secureSnapshot().windowsWorkflow.replace(
        "WORDTAKER_PACKAGED_RUNTIME_SMOKE",
        "development-only smoke",
      ),
      macWorkflow: secureSnapshot().macWorkflow.replace(
        "WORDTAKER_PACKAGED_RUNTIME_SMOKE",
        "development-only smoke",
      ),
    });
    snapshot.packageJson.build.files = ["main.js"];

    expect(validateDesktopReleaseSnapshot(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("packaged runtime"),
        expect.stringContaining("Windows"),
        expect.stringContaining("macOS"),
      ]),
    );
  });

  it("requires packaged smoke mode before production managers can touch user data", () => {
    const snapshot = secureSnapshot();
    snapshot.mainSource = [
      "const LogManager = require('./src/helpers/logManager')",
      'if (process.env.WORDTAKER_PACKAGED_RUNTIME_SMOKE === "1") {',
      'app.setName("WordTaker Runtime Smoke")',
      'require("./scripts/electron-runtime-smoke")',
      "return",
    ].join("\n");

    expect(validateDesktopReleaseSnapshot(snapshot)).toEqual(
      expect.arrayContaining([expect.stringContaining("packaged runtime")]),
    );
  });

  it("rejects desktop jobs that install Electron without rebuilding native modules", () => {
    const snapshot = secureSnapshot();
    snapshot.ciWorkflow = snapshot.ciWorkflow.replace(
      "pnpm exec electron-rebuild -f -w better-sqlite3 -w uiohook-napi",
      "pnpm rebuild electron",
    );
    snapshot.windowsWorkflow = snapshot.windowsWorkflow.replace(
      "pnpm run prepare:electron-runtime",
      "pnpm rebuild electron",
    );

    expect(validateDesktopReleaseSnapshot(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CI"),
        expect.stringContaining("Windows"),
      ]),
    );
  });

  it("requires a real Windows arm64 Electron runtime gate", () => {
    const snapshot = secureSnapshot();
    snapshot.windowsWorkflow = snapshot.windowsWorkflow.replace(
      "runs-on: windows-11-arm",
      "# arm64 is only cross-compiled on x64",
    );

    expect(validateDesktopReleaseSnapshot(snapshot)).toEqual(
      expect.arrayContaining([expect.stringContaining("Windows")]),
    );
  });

  it("requires the ARM64 runtime job to load embedded Python from app.asar.unpacked", () => {
    const snapshot = secureSnapshot();
    snapshot.windowsWorkflow = snapshot.windowsWorkflow.replace(
      "resources\\app.asar.unpacked\\python",
      "resources\\python",
    );

    expect(validateDesktopReleaseSnapshot(snapshot)).toEqual(
      expect.arrayContaining([expect.stringContaining("Windows")]),
    );
  });

  it("requires Windows packages to use the pinned SenseVoice manifest", () => {
    const snapshot = secureSnapshot();
    snapshot.windowsWorkflow = snapshot.windowsWorkflow
      .replace("pnpm run prepare:sensevoice", "snapshot_download('iic/SenseVoiceSmall')")
      .replace("pnpm run verify:sensevoice", "assert model exists");

    expect(validateDesktopReleaseSnapshot(snapshot)).toEqual(
      expect.arrayContaining([expect.stringContaining("Windows")]),
    );
  });

  it("rechecks the pinned model from the final Windows package", () => {
    const snapshot = secureSnapshot();
    snapshot.windowsWorkflow = snapshot.windowsWorkflow
      .replace("scripts/sensevoice-model.js --verify", "Get-ChildItem model_quant.onnx")
      .replace("--model-dir=", "model exists");

    expect(validateDesktopReleaseSnapshot(snapshot)).toEqual(
      expect.arrayContaining([expect.stringContaining("Windows")]),
    );
  });

  it("reports every missing version, packaging and runtime source", () => {
    const snapshot = secureSnapshot({
      lockfileText: "",
      ciWorkflow: "continue-on-error: true",
      windowsWorkflow: "npx --yes @electron/rebuild",
      macWorkflow: "",
      ipcSource: "",
      preloadSource: "",
      settingsSource: "",
      updaterSource: "",
    });
    snapshot.packageJson.version = "v1";
    snapshot.packageJson.scripts = {};
    snapshot.candidateConfigSource = "";
    snapshot.packageJson.build.win = {};
    snapshot.packageJson.build.nsis = {};
    snapshot.packageJson.build.portable = {};
    snapshot.packageJson.build.dmg = {};

    expect(validateDesktopReleaseSnapshot(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("SemVer"),
        expect.stringContaining("scripts"),
        expect.stringContaining("candidate"),
        expect.stringContaining("artifactName"),
        expect.stringContaining("lock"),
        expect.stringContaining("CI"),
        expect.stringContaining("Windows"),
        expect.stringContaining("macOS"),
        expect.stringContaining("main-process"),
        expect.stringContaining("preload"),
        expect.stringContaining("About"),
        expect.stringContaining("updater"),
      ]),
    );
  });

  it("compares semver values and handles optional release files safely", async () => {
    expect(parseVersion("release-43.3.0")).toEqual([43, 3, 0]);
    expect(parseVersion("invalid")).toBeNull();
    expect(versionAtLeast("43.4.0", "43.3.0")).toBe(true);
    expect(versionAtLeast("43.2.9", "43.3.0")).toBe(false);
    expect(versionAtLeast("43.3.0", "43.3.0")).toBe(true);
    expect(versionAtLeast("invalid", "43.3.0")).toBe(false);
    expect(versionAtLeast("43.3.0", "invalid")).toBe(false);

    expect(
      await readOptional("missing", async () => {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }),
    ).toBe("");
    await expect(
      readOptional("denied", async () => {
        const error = new Error("denied");
        error.code = "EACCES";
        throw error;
      }),
    ).rejects.toThrow(/denied/);
  });

  it("emits machine-usable release CLI success, issue and failure outcomes", async () => {
    const processLike = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const valid = { version: "1.29.0", electronVersion: "43.3.0", issues: [] };

    expect(await runDesktopReleaseCli({ inspect: async () => valid, processLike })).toBe(valid);
    expect(processLike.stdout.write).toHaveBeenCalledWith(expect.stringContaining("1.29.0"));

    const invalid = { ...valid, issues: ["unsafe"] };
    expect(await runDesktopReleaseCli({ inspect: async () => invalid, processLike })).toBe(invalid);
    expect(processLike.stderr.write).toHaveBeenCalledWith("- unsafe\n");
    expect(processLike.exitCode).toBe(1);

    processLike.exitCode = 0;
    expect(
      await runDesktopReleaseCli({
        inspect: async () => {
          throw new Error("broken");
        },
        processLike,
      }),
    ).toBeNull();
    expect(processLike.stderr.write).toHaveBeenCalledWith(expect.stringContaining("broken"));
    expect(processLike.exitCode).toBe(1);
  });
});
