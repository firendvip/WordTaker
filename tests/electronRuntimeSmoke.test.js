import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  SENTINEL,
  assertAppVersion,
  assertReleaseVariant,
  assertUiohookApi,
  assertSafeStorageRoundTrip,
  assertRuntimeVersion,
  formatRuntimeSmokeResult,
  isElectronMainProcess,
  runDatabaseMigrationSmoke,
  runElectronRuntimeSmoke,
  runElectronRuntimeSmokeCli,
  runRuntimeSmokeResultCli,
  runTokenStorePersistenceSmoke,
  validateRuntimeSmokeResult,
} = require("../scripts/electron-runtime-smoke.js");
const { createTokenStore } = require("../src/helpers/tokenStore.js");

function createNativeFakes(overrides = {}) {
  const state = { legacyClosed: false, managerClosed: false, saved: null };
  class FakeDatabase {
    exec() {
      if (overrides.legacyError) throw overrides.legacyError;
    }
    close() {
      state.legacyClosed = true;
    }
  }
  class FakeDatabaseManager {
    initialize() {
      this.db = {
        prepare: (sql) => ({
          all: () =>
            sql.includes("table_info")
              ? (overrides.columns || [
                  { name: "raw_text" },
                  { name: "processed_text" },
                  { name: "polish_engine" },
                  { name: "polish_duration_ms" },
                  { name: "polish_first_char_ms" },
                  { name: "e2e_total_ms" },
                ])
              : [],
          get: () => ({ version: "3.50.4" }),
        }),
      };
    }
    getTranscriptionById(id) {
      if (id === 2) return overrides.savedRecord || { id: 2, ...state.saved };
      return overrides.legacyRecord || { id: 1, text: "legacy preserved" };
    }
    saveTranscription(value) {
      state.saved = value;
      return { lastInsertRowid: 2 };
    }
    getSavedRecord() {
      return overrides.savedRecord || { id: 2, ...state.saved };
    }
    close() {
      state.managerClosed = true;
    }
  }
  return { Database: FakeDatabase, DatabaseManager: FakeDatabaseManager, state };
}

describe("Electron authentication runtime smoke", () => {
  it("round-trips a sentinel without exposing plaintext", () => {
    const safeStorage = {
      isEncryptionAvailable: vi.fn(() => true),
      getSelectedStorageBackend: vi.fn(() => "keychain"),
      encryptString: vi.fn((value) => Buffer.from(value, "utf8").reverse()),
      decryptString: vi.fn((buffer) => Buffer.from(buffer).reverse().toString("utf8")),
    };

    expect(assertSafeStorageRoundTrip(safeStorage)).toMatchObject({
      backend: "keychain",
      encryptedBytes: expect.any(Number),
    });
    safeStorage.getSelectedStorageBackend.mockReturnValue("platform-default");
    expect(assertSafeStorageRoundTrip(safeStorage, "darwin").backend).toBe("keychain");
    expect(assertSafeStorageRoundTrip(safeStorage, "win32").backend).toBe("dpapi");
  });

  it("fails closed when encryption is unavailable or Linux selects basic_text", () => {
    expect(() =>
      assertSafeStorageRoundTrip({ isEncryptionAvailable: () => false }),
    ).toThrow(/unavailable/i);

    expect(() =>
      assertSafeStorageRoundTrip({
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "basic_text",
      }),
    ).toThrow(/basic_text/i);
  });

  it("rejects plaintext ciphertext and a runtime/package version mismatch", () => {
    const plaintextStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "dpapi",
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString("utf8"),
    };

    expect(() => assertSafeStorageRoundTrip(plaintextStorage)).toThrow(/plaintext/i);
    expect(() => assertRuntimeVersion("43.3.0", "42.8.1")).toThrow(/version/i);
    expect(assertRuntimeVersion("43.3.0", "43.3.0")).toBe("43.3.0");
    expect(() => assertAppVersion("1.29.0", "1.28.7")).toThrow(/version/i);
    expect(assertAppVersion("1.29.0", "1.29.0")).toBe("1.29.0");
    expect(() => assertAppVersion("", "1.29.0")).toThrow(/missing/i);
    expect(() => assertAppVersion("1.29.0", "")).toThrow(/missing/i);
  });

  it("rejects missing, mismatched and unsupported packaged architectures", () => {
    const { assertRuntimeArch } = require("../scripts/electron-runtime-smoke.js");
    expect(assertRuntimeArch("arm64", "arm64")).toBe("arm64");
    expect(() => assertRuntimeArch("x64", "arm64")).toThrow(/architecture/i);
    expect(() => assertRuntimeArch("", "arm64")).toThrow(/missing/i);
    expect(() => assertRuntimeArch("arm64", "")).toThrow(/missing/i);
    expect(() => assertRuntimeArch("ia32", "ia32")).toThrow(/architecture/i);
  });

  it("rejects incomplete safeStorage implementations, invalid ciphertext and failed decrypts", () => {
    expect(() => assertSafeStorageRoundTrip({ isEncryptionAvailable: () => true })).toThrow(
      /APIs/i,
    );
    expect(() =>
      assertSafeStorageRoundTrip({
        isEncryptionAvailable: () => true,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => SENTINEL,
      }),
    ).toThrow(/encrypted bytes/i);
    expect(() =>
      assertSafeStorageRoundTrip({
        isEncryptionAvailable: () => true,
        encryptString: () => Buffer.from("cipher"),
        decryptString: () => "wrong",
      }),
    ).toThrow(/round-trip/i);
    expect(() => assertRuntimeVersion("", "43.3.0")).toThrow(/missing/i);
    expect(() => assertRuntimeVersion("43.3.0", "")).toThrow(/missing/i);
  });

  it("waits for Electron readiness and emits a machine-readable success result", async () => {
    const whenReady = vi.fn(async () => undefined);
    const result = await runElectronRuntimeSmoke({
      app: { whenReady },
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "dpapi",
        encryptString: (value) => Buffer.from(value, "utf8").reverse(),
        decryptString: (value) => Buffer.from(value).reverse().toString("utf8"),
      },
      actualVersion: "43.3.0",
      expectedVersion: "43.3.0",
      actualAppVersion: "1.29.0",
      expectedAppVersion: "1.29.0",
      actualArch: "arm64",
      expectedArch: "arm64",
      actualVariant: "passport-candidate",
      expectedVariant: "passport-candidate",
    });

    expect(whenReady).toHaveBeenCalledOnce();
    expect(JSON.parse(formatRuntimeSmokeResult(result))).toMatchObject({
      success: true,
      version: "43.3.0",
      appVersion: "1.29.0",
      variant: "passport-candidate",
      storage: { backend: "dpapi" },
    });
    expect(() => assertReleaseVariant("passport-candidate", "default"))
      .toThrow(/variant/i);
    expect(assertReleaseVariant("default", "default")).toBe("default");
    expect(() => assertReleaseVariant("pilot", "pilot")).toThrow(/variant/i);
  });

  it("runs the CLI inside Electron's browser process even when require.main is unset", () => {
    expect(
      isElectronMainProcess({ type: "browser", versions: { electron: "43.3.0" } }),
    ).toBe(true);
    expect(isElectronMainProcess({ type: "renderer", versions: { electron: "43.3.0" } })).toBe(false);
    expect(isElectronMainProcess({ versions: { node: "22.22.3" } })).toBe(false);
  });

  it("loads the global-hook API without starting a hook", () => {
    expect(assertUiohookApi({ start: vi.fn(), stop: vi.fn(), on: vi.fn() })).toEqual({
      loaded: true,
    });
    expect(() => assertUiohookApi({ start: vi.fn() })).toThrow(/uiohook/i);
  });

  it("opens an old database, preserves its row and exercises current raw/processed fields", () => {
    const { Database, DatabaseManager, state } = createNativeFakes();

    const result = runDatabaseMigrationSmoke({
      Database,
      DatabaseManager,
      readSavedRecord: (manager) => manager.getSavedRecord(),
    });

    expect(result).toMatchObject({
      sqliteVersion: "3.50.4",
      legacyText: "legacy preserved",
      rawText: "原始文本",
      processedText: "处理文本",
      migratedColumns: 6,
    });
    expect(state).toMatchObject({ legacyClosed: true, managerClosed: true });
  });

  it("persists only the refresh credential through the production tokenStore", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-token-smoke-test-"));
    const safeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "keychain",
      encryptString: (value) => Buffer.from(value, "utf8").reverse(),
      decryptString: (value) => Buffer.from(value).reverse().toString("utf8"),
    };

    try {
      expect(
        runTokenStorePersistenceSmoke({ createTokenStore, safeStorage, baseDir }),
      ).toEqual({ persisted: true, accessTokenPersisted: false, reloaded: true });
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("fails the credential smoke on unavailable, plaintext or non-reloadable stores", () => {
    expect(() =>
      runTokenStorePersistenceSmoke({ createTokenStore: null, safeStorage: {} }),
    ).toThrow(/factory/i);

    const fileSystem = {
      mkdirSync: vi.fn(),
      mkdtempSync: vi.fn(() => "/tmp/wordtaker-auth-smoke-fake"),
      readFileSync: vi.fn(() => Buffer.from("ciphertext")),
      rmSync: vi.fn(),
    };
    expect(() =>
      runTokenStorePersistenceSmoke({
        createTokenStore: () => ({ setPassport: () => false }),
        safeStorage: {},
        fileSystem,
      }),
    ).toThrow(/persist securely/i);

    fileSystem.readFileSync.mockReturnValue(Buffer.from("runtime.smoke.access-token"));
    expect(() =>
      runTokenStorePersistenceSmoke({
        createTokenStore: () => ({ setPassport: () => true, getPassport: () => null }),
        safeStorage: {},
        fileSystem,
      }),
    ).toThrow(/plaintext/i);

    fileSystem.readFileSync.mockReturnValue(Buffer.from("ciphertext"));
    let calls = 0;
    expect(() =>
      runTokenStorePersistenceSmoke({
        createTokenStore: () => {
          calls += 1;
          return calls === 1
            ? { setPassport: () => true }
            : { getPassport: () => null };
        },
        safeStorage: {},
        fileSystem,
      }),
    ).toThrow(/reload contract/i);
    expect(fileSystem.rmSync).toHaveBeenCalled();
  });

  it("closes temporary database handles on migration failures", () => {
    const legacyFailure = createNativeFakes({ legacyError: new Error("seed failed") });
    expect(() => runDatabaseMigrationSmoke(legacyFailure)).toThrow(/seed failed/);
    expect(legacyFailure.state).toMatchObject({ legacyClosed: true, managerClosed: false });

    const missingLegacy = createNativeFakes({ legacyRecord: { id: 1, text: "changed" } });
    expect(() =>
      runDatabaseMigrationSmoke({
        ...missingLegacy,
        readSavedRecord: (manager) => manager.getSavedRecord(),
      }),
    ).toThrow(/Legacy transcription/i);
    expect(missingLegacy.state.managerClosed).toBe(true);

    const missingColumns = createNativeFakes({ columns: [{ name: "raw_text" }] });
    expect(() =>
      runDatabaseMigrationSmoke({
        ...missingColumns,
        readSavedRecord: (manager) => manager.getSavedRecord(),
      }),
    ).toThrow(/Current transcription fields/i);
  });

  it("runs the machine-readable CLI and reports failures through Electron exit", async () => {
    const native = createNativeFakes();
    const writes = [];
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const app = {
      whenReady: vi.fn(async () => undefined),
      getPath: vi.fn(() => "/tmp"),
      getVersion: vi.fn(() => "1.29.0"),
      quit: vi.fn(),
      exit: vi.fn(),
    };
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, "utf8").reverse(),
      decryptString: (value) => Buffer.from(value).reverse().toString("utf8"),
    };
    const processLike = {
      versions: { electron: "43.3.0" },
      arch: "x64",
      platform: "win32",
      env: {
        WORDTAKER_EXPECTED_VARIANT: "passport-candidate",
        WORDTAKER_RUNTIME_SMOKE_RESULT: "/tmp/result.json",
      },
      stdout,
      stderr,
    };

    const result = await runElectronRuntimeSmokeCli({
      electron: { app, safeStorage },
      ...native,
      createTokenStore,
      uIOhook: { start() {}, stop() {}, on() {} },
      packageJson: {
        version: "1.29.0",
        wordtakerPassportCandidate: true,
        devDependencies: { electron: "43.3.0" },
      },
      processLike,
      fileSystem: { writeFileSync: (...args) => writes.push(args) },
    });

    expect(result).toMatchObject({ version: "43.3.0", native: { uiohook: { loaded: true } } });
    expect(writes).toHaveLength(1);
    expect(stdout.write).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(0);

    safeStorage.isEncryptionAvailable = () => false;
    processLike.env = {};
    expect(
      await runElectronRuntimeSmokeCli({
        electron: { app, safeStorage },
      ...native,
      createTokenStore,
        uIOhook: { start() {}, stop() {}, on() {} },
        packageJson: {
          version: "1.29.0",
          wordtakerPassportCandidate: true,
          devDependencies: { electron: "43.3.0" },
        },
        processLike,
      }),
    ).toBeNull();
    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
    expect(app.exit).toHaveBeenCalledWith(1);
  });

  it("validates packaged smoke evidence before a workflow can accept it", () => {
    const evidence = {
      success: true,
      version: "43.3.0",
      appVersion: "1.29.0",
      arch: "arm64",
      variant: "default",
      storage: { backend: "keychain", encryptedBytes: 32 },
      native: {
        credentials: { persisted: true, accessTokenPersisted: false, reloaded: true },
        database: { migratedColumns: 6 },
        uiohook: { loaded: true },
      },
    };
    expect(
      validateRuntimeSmokeResult(evidence, {
        expectedElectronVersion: "43.3.0",
        expectedAppVersion: "1.29.0",
        expectedArch: "arm64",
        expectedVariant: "default",
      }),
    ).toBe(evidence);

    for (const invalid of [
      { ...evidence, success: false },
      { ...evidence, arch: "x64" },
      { ...evidence, variant: "passport-candidate" },
      { ...evidence, storage: { backend: "basic_text" } },
      { ...evidence, native: { ...evidence.native, credentials: { persisted: false } } },
    ]) {
      expect(() =>
        validateRuntimeSmokeResult(invalid, {
          expectedElectronVersion: "43.3.0",
          expectedAppVersion: "1.29.0",
          expectedArch: "arm64",
          expectedVariant: "default",
        }),
      ).toThrow(/smoke/i);
    }
  });

  it("reports packaged smoke result verification through a Node CLI", () => {
    const evidence = JSON.stringify({
      success: true,
      version: "43.3.0",
      appVersion: "1.29.0",
      arch: "x64",
      variant: "default",
      storage: { backend: "dpapi", encryptedBytes: 32 },
      native: {
        credentials: { persisted: true, accessTokenPersisted: false, reloaded: true },
        database: { migratedColumns: 6 },
        uiohook: { loaded: true },
      },
    });
    const processLike = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    expect(
      runRuntimeSmokeResultCli({
        argv: ["result.json", "43.3.0", "1.29.0", "x64", "default"],
        readFile: () => evidence,
        processLike,
      }),
    ).toMatchObject({ arch: "x64" });
    expect(processLike.stdout.write).toHaveBeenCalledWith(expect.stringContaining("verified"));

    expect(
      runRuntimeSmokeResultCli({
        argv: [],
        readFile: () => evidence,
        processLike,
      }),
    ).toBeNull();
    expect(processLike.exitCode).toBe(1);

    processLike.exitCode = 0;
    expect(
      runRuntimeSmokeResultCli({
        argv: ["result.json", "43.3.0", "1.29.0", "x64", "default"],
        readFile: () => "x".repeat(65 * 1024),
        processLike,
      }),
    ).toBeNull();
    expect(processLike.exitCode).toBe(1);
  });
});
