"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SENTINEL = "wordtaker-safe-storage-smoke-v1";
const TOKEN_SMOKE_ACCESS = "runtime.smoke.access-token";
const TOKEN_SMOKE_REFRESH = `opaque-refresh~${"R".repeat(43)}`;

function assertRuntimeVersion(actualVersion, expectedVersion) {
  const actual = String(actualVersion || "").trim();
  const expected = String(expectedVersion || "").trim();
  if (!actual || !expected || actual !== expected) {
    throw new Error(
      `Electron runtime version mismatch: expected ${expected || "<missing>"}, got ${actual || "<missing>"}`,
    );
  }
  return actual;
}

function assertAppVersion(actualVersion, expectedVersion) {
  const actual = String(actualVersion || "").trim();
  const expected = String(expectedVersion || "").trim();
  if (!actual || !expected || actual !== expected) {
    throw new Error(
      `Packaged app version mismatch: expected ${expected || "<missing>"}, got ${actual || "<missing>"}`,
    );
  }
  return actual;
}

function assertRuntimeArch(actualArch, expectedArch) {
  const actual = String(actualArch || "").trim();
  const expected = String(expectedArch || "").trim();
  if (!actual || !expected || actual !== expected || !["x64", "arm64"].includes(actual)) {
    throw new Error(
      `Electron runtime architecture mismatch: expected ${expected || "<missing>"}, got ${actual || "<missing>"}`,
    );
  }
  return actual;
}

function assertReleaseVariant(actualVariant, expectedVariant) {
  const actual = String(actualVariant || "").trim();
  const expected = String(expectedVariant || "").trim();
  const supported = new Set(["default", "passport-candidate"]);
  if (!supported.has(actual) || !supported.has(expected) || actual !== expected) {
    throw new Error(
      `Packaged release variant mismatch: expected ${expected || "<missing>"}, got ${actual || "<missing>"}`,
    );
  }
  return actual;
}

function assertSafeStorageRoundTrip(safeStorage, platform) {
  if (!safeStorage || safeStorage.isEncryptionAvailable() !== true) {
    throw new Error("Electron safeStorage encryption is unavailable");
  }

  const backend = platform === "darwin"
    ? "keychain"
    : platform === "win32"
      ? "dpapi"
      : typeof safeStorage.getSelectedStorageBackend === "function"
        ? safeStorage.getSelectedStorageBackend()
        : "platform-default";
  if (backend === "basic_text") {
    throw new Error("Electron safeStorage selected insecure basic_text backend");
  }

  if (
    typeof safeStorage.encryptString !== "function" ||
    typeof safeStorage.decryptString !== "function"
  ) {
    throw new Error("Electron safeStorage encryption APIs are unavailable");
  }

  const encrypted = safeStorage.encryptString(SENTINEL);
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
    throw new Error("Electron safeStorage did not return encrypted bytes");
  }
  if (encrypted.includes(Buffer.from(SENTINEL, "utf8"))) {
    throw new Error("Electron safeStorage ciphertext contains plaintext sentinel");
  }
  if (safeStorage.decryptString(encrypted) !== SENTINEL) {
    throw new Error("Electron safeStorage round-trip verification failed");
  }

  return { backend, encryptedBytes: encrypted.length };
}

function assertUiohookApi(uIOhook) {
  if (
    !uIOhook ||
    typeof uIOhook.start !== "function" ||
    typeof uIOhook.stop !== "function" ||
    typeof uIOhook.on !== "function"
  ) {
    throw new Error("uiohook-napi did not expose the expected native API");
  }
  return { loaded: true };
}

function runDatabaseMigrationSmoke({
  Database,
  DatabaseManager,
  baseDir = os.tmpdir(),
  readSavedRecord = (manager, id) => manager.getTranscriptionById(id),
}) {
  const workDir = fs.mkdtempSync(path.join(baseDir, "wordtaker-db-smoke-"));
  const dbPath = path.join(workDir, "transcriptions.db");
  let legacyDb;
  let manager;

  try {
    legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE transcriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        raw_text TEXT,
        processed_text TEXT,
        confidence REAL,
        language TEXT DEFAULT 'zh-CN',
        duration REAL,
        file_size INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO transcriptions (text, raw_text, processed_text)
      VALUES ('legacy preserved', 'legacy raw', 'legacy processed');
    `);
    legacyDb.close();
    legacyDb = null;

    manager = new DatabaseManager();
    manager.initialize(workDir);
    const legacyRecord = manager.getTranscriptionById(1);
    const insertion = manager.saveTranscription({
      text: "处理文本",
      raw_text: "原始文本",
      processed_text: "处理文本",
      polish_engine: "cloud",
    });
    const savedRecord = readSavedRecord(manager, insertion.lastInsertRowid);
    const sqliteVersion = manager.db.prepare("SELECT sqlite_version() AS version").get().version;
    const expectedColumns = new Set([
      "raw_text",
      "processed_text",
      "polish_engine",
      "polish_duration_ms",
      "polish_first_char_ms",
      "e2e_total_ms",
    ]);
    const migratedColumns = manager.db
      .prepare("PRAGMA table_info(transcriptions)")
      .all()
      .filter((column) => expectedColumns.has(column.name)).length;

    if (legacyRecord?.text !== "legacy preserved") {
      throw new Error("Legacy transcription was not preserved during database migration");
    }
    if (
      savedRecord?.raw_text !== "原始文本" ||
      savedRecord?.processed_text !== "处理文本" ||
      migratedColumns !== expectedColumns.size
    ) {
      throw new Error("Current transcription fields failed the database migration smoke");
    }

    return {
      sqliteVersion,
      legacyText: legacyRecord.text,
      rawText: savedRecord.raw_text,
      processedText: savedRecord.processed_text,
      migratedColumns,
    };
  } finally {
    if (legacyDb) legacyDb.close();
    if (manager) manager.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function runTokenStorePersistenceSmoke({
  createTokenStore,
  safeStorage,
  baseDir = os.tmpdir(),
  fileSystem = fs,
  now = Date.now,
}) {
  if (typeof createTokenStore !== "function") {
    throw new Error("Production tokenStore factory is unavailable");
  }
  fileSystem.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const workDir = fileSystem.mkdtempSync(path.join(baseDir, "wordtaker-auth-smoke-"));
  const timestamp = Number(now());

  try {
    const createStore = () =>
      createTokenStore({
        dataDirectory: workDir,
        safeStorage,
        platform: process.platform,
        now: () => timestamp,
      });
    const first = createStore();
    const persisted = first.setPassport({
      accessToken: TOKEN_SMOKE_ACCESS,
      expiresAt: timestamp + 10 * 60 * 1000,
      refreshToken: TOKEN_SMOKE_REFRESH,
      issuer: "https://auth.yaa3.com",
      scope: "openid profile offline_access aim.api",
      centralSessionId: "11111111-1111-4111-8111-111111111111",
      profileCheckedAt: timestamp,
      account: {
        passport_user_id: "22222222-2222-4222-8222-222222222222",
        nickname: "runtime smoke",
        profile_version: 1,
      },
      aimProbeRequired: true,
    });
    if (!persisted) throw new Error("Production tokenStore failed to persist securely");

    const securePath = path.join(workDir, "auth-credentials.safe");
    const encrypted = fileSystem.readFileSync(securePath);
    if (
      encrypted.includes(Buffer.from(TOKEN_SMOKE_ACCESS, "utf8")) ||
      encrypted.includes(Buffer.from(TOKEN_SMOKE_REFRESH, "utf8"))
    ) {
      throw new Error("Production tokenStore persisted plaintext credentials");
    }

    const reloaded = createStore().getPassport();
    if (
      reloaded?.refreshToken !== TOKEN_SMOKE_REFRESH ||
      reloaded?.accessToken !== null ||
      reloaded?.expiresAt !== 0
    ) {
      throw new Error("Production tokenStore secure reload contract failed");
    }

    return { persisted: true, accessTokenPersisted: false, reloaded: true };
  } finally {
    fileSystem.rmSync(workDir, { recursive: true, force: true });
  }
}

async function runElectronRuntimeSmoke({
  app,
  safeStorage,
  actualVersion,
  expectedVersion,
  actualAppVersion,
  expectedAppVersion,
  actualArch,
  expectedArch,
  actualVariant,
  expectedVariant,
  platform,
  nativeCheck,
}) {
  await app.whenReady();
  const version = assertRuntimeVersion(actualVersion, expectedVersion);
  const appVersion = assertAppVersion(actualAppVersion, expectedAppVersion);
  const arch = assertRuntimeArch(actualArch, expectedArch);
  const variant = assertReleaseVariant(actualVariant, expectedVariant);
  const storage = assertSafeStorageRoundTrip(safeStorage, platform);
  const native = typeof nativeCheck === "function" ? nativeCheck() : undefined;
  return native
    ? { version, appVersion, arch, variant, storage, native }
    : { version, appVersion, arch, variant, storage };
}

function formatRuntimeSmokeResult(result) {
  return JSON.stringify({ success: true, ...result });
}

function isElectronMainProcess(processLike = process) {
  return processLike?.type === "browser" && Boolean(processLike?.versions?.electron);
}

async function runElectronRuntimeSmokeCli(options = {}) {
  const electron = options.electron || require("electron");
  const Database = options.Database || require("better-sqlite3");
  const uIOhook = options.uIOhook || require("uiohook-napi").uIOhook;
  const DatabaseManager = options.DatabaseManager || require("../src/helpers/database");
  const createTokenStore =
    options.createTokenStore || require("../src/helpers/tokenStore").createTokenStore;
  const packageJson = options.packageJson || require("../package.json");
  const processLike = options.processLike || process;
  const fileSystem = options.fileSystem || fs;
  const { app, safeStorage } = electron;

  try {
    const result = await runElectronRuntimeSmoke({
      app,
      safeStorage,
      actualVersion: processLike.versions.electron,
      expectedVersion:
        processLike.env.WORDTAKER_EXPECTED_ELECTRON_VERSION ||
        packageJson.devDependencies?.electron,
      actualAppVersion: app.getVersion(),
      expectedAppVersion:
        processLike.env.WORDTAKER_EXPECTED_APP_VERSION || packageJson.version,
      actualArch: processLike.arch,
      expectedArch: processLike.env.WORDTAKER_EXPECTED_ARCH || processLike.arch,
      actualVariant: packageJson.wordtakerPassportCandidate === true
        ? "passport-candidate"
        : "default",
      expectedVariant: processLike.env.WORDTAKER_EXPECTED_VARIANT
        || (packageJson.wordtakerPassportCandidate === true ? "passport-candidate" : "default"),
      platform: processLike.platform,
      nativeCheck: () => ({
        database: runDatabaseMigrationSmoke({ Database, DatabaseManager }),
        credentials: runTokenStorePersistenceSmoke({
          createTokenStore,
          safeStorage,
          baseDir: app.getPath("userData"),
        }),
        uiohook: assertUiohookApi(uIOhook),
      }),
    });
    const serialized = formatRuntimeSmokeResult(result);
    const resultPath = processLike.env.WORDTAKER_RUNTIME_SMOKE_RESULT;
    if (resultPath) fileSystem.writeFileSync(resultPath, `${serialized}\n`, { mode: 0o600 });
    processLike.stdout.write(`${serialized}\n`);
    app.exit(0);
    return result;
  } catch (error) {
    processLike.stderr.write(`Electron runtime smoke failed: ${error.message}\n`);
    app.exit(1);
    return null;
  }
}

function validateRuntimeSmokeResult(
  result,
  { expectedElectronVersion, expectedAppVersion, expectedArch, expectedVariant },
) {
  try {
    if (!result || result.success !== true) throw new Error("success marker missing");
    assertRuntimeVersion(result.version, expectedElectronVersion);
    assertAppVersion(result.appVersion, expectedAppVersion);
    assertRuntimeArch(result.arch, expectedArch);
    assertReleaseVariant(result.variant, expectedVariant);
    if (
      !result.storage ||
      result.storage.backend === "basic_text" ||
      !Number.isSafeInteger(result.storage.encryptedBytes) ||
      result.storage.encryptedBytes <= 0
    ) {
      throw new Error("secure storage evidence missing");
    }
    const credentials = result.native?.credentials;
    if (
      credentials?.persisted !== true ||
      credentials?.accessTokenPersisted !== false ||
      credentials?.reloaded !== true ||
      result.native?.database?.migratedColumns !== 6 ||
      result.native?.uiohook?.loaded !== true
    ) {
      throw new Error("native or credential evidence missing");
    }
    return result;
  } catch (error) {
    throw new Error(`Packaged runtime smoke evidence is invalid: ${error.message}`);
  }
}

function runRuntimeSmokeResultCli({
  argv = process.argv.slice(3),
  readFile = fs.readFileSync,
  processLike = process,
} = {}) {
  try {
    const [
      resultPath,
      expectedElectronVersion,
      expectedAppVersion,
      expectedArch,
      expectedVariant,
    ] = argv;
    if (
      !resultPath
      || !expectedElectronVersion
      || !expectedAppVersion
      || !expectedArch
      || !expectedVariant
    ) {
      throw new Error(
        "result path, Electron version, app version, architecture and release variant are required",
      );
    }
    const serialized = readFile(resultPath, "utf8");
    if (typeof serialized !== "string" || Buffer.byteLength(serialized) > 64 * 1024) {
      throw new Error("result file is missing or oversized");
    }
    const result = validateRuntimeSmokeResult(JSON.parse(serialized), {
      expectedElectronVersion,
      expectedAppVersion,
      expectedArch,
      expectedVariant,
    });
    processLike.stdout.write(
      `Packaged runtime smoke verified: app ${result.appVersion}, Electron ${result.version}, ${result.arch}\n`,
    );
    return result;
  } catch (error) {
    processLike.stderr.write(`Packaged runtime smoke verification failed: ${error.message}\n`);
    processLike.exitCode = 1;
    return null;
  }
}

if (require.main === module && process.argv[2] === "--verify-result") {
  runRuntimeSmokeResultCli();
} else if (require.main === module || isElectronMainProcess(process)) {
  void runElectronRuntimeSmokeCli();
}

module.exports = {
  SENTINEL,
  assertAppVersion,
  assertReleaseVariant,
  assertRuntimeArch,
  assertUiohookApi,
  assertRuntimeVersion,
  assertSafeStorageRoundTrip,
  formatRuntimeSmokeResult,
  isElectronMainProcess,
  runDatabaseMigrationSmoke,
  runElectronRuntimeSmoke,
  runElectronRuntimeSmokeCli,
  runRuntimeSmokeResultCli,
  runTokenStorePersistenceSmoke,
  validateRuntimeSmokeResult,
};
