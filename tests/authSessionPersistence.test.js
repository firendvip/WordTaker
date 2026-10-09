import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const tokenStoreSource = read("../src/helpers/tokenStore.js");
const backendClientSource = read("../src/helpers/backendClient.js");

const tempDirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) =>
      Buffer.from(`sealed:${Buffer.from(value, "utf8").toString("base64")}`, "utf8"),
    decryptString: (value) => {
      const encoded = value.toString("utf8").replace(/^sealed:/, "");
      return Buffer.from(encoded, "base64").toString("utf8");
    },
  };
}

function loadTokenStore(directory, safeStorage = fakeSafeStorage(), filesystem = fs) {
  const context = {
    Buffer,
    Date,
    JSON,
    module: { exports: {} },
    process: { platform: "darwin" },
    require: (name) => {
      if (name === "electron") {
        return { app: { getPath: () => directory }, safeStorage };
      }
      if (name === "fs") return filesystem;
      if (name === "path") return path;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(tokenStoreSource, context, {
    filename: fileURLToPath(new URL("../src/helpers/tokenStore.js", import.meta.url)),
  });
  return context.module.exports;
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function createTokenState() {
  let session = {
    accessToken: "access-old",
    refreshToken: "refresh-old",
    account: { phone: "13800138000" },
  };
  let generation = 1;
  const api = {
    get: vi.fn(() => session && { ...session }),
    getAccessToken: vi.fn(() => session?.accessToken || null),
    getRefreshToken: vi.fn(() => session?.refreshToken || null),
    getGeneration: vi.fn(() => generation),
    replaceTokensIfCurrent: vi.fn((expectedGeneration, expectedRefreshToken, tokens) => {
      if (
        !session ||
        generation !== expectedGeneration ||
        session.refreshToken !== expectedRefreshToken
      ) {
        return false;
      }
      session = { ...session, ...tokens };
      return true;
    }),
    set: vi.fn((value) => {
      session = { ...value };
      generation += 1;
      return true;
    }),
    clear: vi.fn(() => {
      session = null;
      generation += 1;
      return true;
    }),
    snapshot: () => session && { ...session },
  };
  return api;
}

function loadBackendClient(fetchImpl, tokenStore, timeoutMs = 1000) {
  const context = {
    AbortController,
    Buffer,
    URL,
    clearTimeout,
    fetch: fetchImpl,
    module: { exports: {} },
    setTimeout,
    require: (name) => {
      if (name === "./backendConfig") {
        return {
          AI_BACKEND_URL: "https://backend.invalid",
          API_PREFIX: "/api/v1",
          CLIENT_PLATFORM: "mac",
          BACKEND_REQUEST_TIMEOUT_MS: timeoutMs,
        };
      }
      if (name === "./deviceIdentity") {
        return { getDeviceId: () => "test-device-123" };
      }
      if (name === "./tokenStore") return tokenStore;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(backendClientSource, context, {
    filename: fileURLToPath(new URL("../src/helpers/backendClient.js", import.meta.url)),
  });
  return context.module.exports;
}

describe("secure persistent authentication storage", () => {
  it("restores access, refresh and account after a process restart without plaintext secrets", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-session-"));
    tempDirs.push(directory);
    const firstProcess = loadTokenStore(directory);

    expect(
      firstProcess.set({
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        account: { phone: "13800138000" },
      }),
    ).toBe(true);

    const persisted = fs.readFileSync(path.join(directory, "backend-token.json"), "utf8");
    expect(persisted).not.toContain("access-secret");
    expect(persisted).not.toContain("refresh-secret");
    expect(persisted).not.toContain("13800138000");

    const restartedProcess = loadTokenStore(directory);
    expect(restartedProcess.get()).toMatchObject({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      account: { phone: "13800138000" },
    });
  });

  it("migrates a valid legacy plaintext session to encrypted storage", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-session-"));
    tempDirs.push(directory);
    const file = path.join(directory, "backend-token.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ accessToken: "legacy-access", account: { phone: "13800138000" } }),
      { mode: 0o600 },
    );

    const tokenStore = loadTokenStore(directory);
    expect(tokenStore.getAccessToken()).toBe("legacy-access");
    expect(fs.readFileSync(file, "utf8")).not.toContain("legacy-access");
  });

  it("preserves a legacy session during unavailable encryption and retries migration after recovery", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-session-"));
    tempDirs.push(directory);
    const file = path.join(directory, "backend-token.json");
    const legacy = JSON.stringify({ accessToken: "legacy-access", account: { userId: "A" } });
    fs.writeFileSync(file, legacy, { mode: 0o600 });
    const safeStorage = fakeSafeStorage();
    let available = false;
    safeStorage.isEncryptionAvailable = () => available;
    const tokenStore = loadTokenStore(directory, safeStorage);

    expect(tokenStore.getAccessToken()).toBe("legacy-access");
    expect(fs.readFileSync(file, "utf8")).toBe(legacy);
    available = true;
    expect(tokenStore.getAccessToken()).toBe("legacy-access");
    expect(fs.readFileSync(file, "utf8")).not.toContain("legacy-access");
  });

  it("does not fall back to plaintext when OS encryption is unavailable", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-session-"));
    tempDirs.push(directory);
    const tokenStore = loadTokenStore(directory, {
      isEncryptionAvailable: () => false,
    });

    expect(tokenStore.set({ accessToken: "access-secret", refreshToken: "refresh-secret" })).toBe(false);
    expect(fs.existsSync(path.join(directory, "backend-token.json"))).toBe(false);
  });

  it("rejects a refresh result after logout changed the session generation", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-session-"));
    tempDirs.push(directory);
    const tokenStore = loadTokenStore(directory);
    tokenStore.set({ accessToken: "access-old", refreshToken: "refresh-old" });
    const generation = tokenStore.getGeneration();

    tokenStore.clear();

    expect(
      tokenStore.replaceTokensIfCurrent(generation, "refresh-old", {
        accessToken: "access-new",
        refreshToken: "refresh-new",
      }),
    ).toBe(false);
    expect(tokenStore.get()).toBeNull();
  });

  it.each(["unavailable", "decrypt failure"])("retries encrypted storage after temporary %s in the same process", (failure) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-session-"));
    tempDirs.push(directory);
    const original = { accessToken: "access-old", refreshToken: "refresh-old" };
    loadTokenStore(directory).set(original);
    const file = path.join(directory, "backend-token.json");
    const encrypted = fs.readFileSync(file, "utf8");
    const safeStorage = fakeSafeStorage();
    let unavailable = true;
    const decryptString = safeStorage.decryptString;
    safeStorage.isEncryptionAvailable = () => failure !== "unavailable" || !unavailable;
    safeStorage.decryptString = (value) => {
      if (failure === "decrypt failure" && unavailable) throw new Error("keychain locked");
      return decryptString(value);
    };
    const restartedProcess = loadTokenStore(directory, safeStorage);

    expect(() => restartedProcess.get()).toThrow(expect.objectContaining({ code: "AUTH_STORAGE_UNAVAILABLE" }));
    expect(fs.readFileSync(file, "utf8")).toBe(encrypted);
    unavailable = false;
    expect(restartedProcess.get()).toMatchObject(original);
  });

  it.each(["set", "refresh"])("preserves the previous memory and encrypted file when %s persistence fails", (operation) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-session-"));
    tempDirs.push(directory);
    const original = { accessToken: "access-old", refreshToken: "refresh-old" };
    const tokenStore = loadTokenStore(directory);
    tokenStore.set(original);
    const file = path.join(directory, "backend-token.json");
    const encrypted = fs.readFileSync(file, "utf8");
    const generation = tokenStore.getGeneration();
    const failedRename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("disk read-only"); });
    const next = { accessToken: "access-new", refreshToken: "refresh-new" };

    if (operation === "set") {
      expect(tokenStore.set(next)).toBe(false);
    } else {
      expect(() => tokenStore.replaceTokensIfCurrent(generation, "refresh-old", next))
        .toThrow(expect.objectContaining({ code: "AUTH_PERSISTENCE_FAILED" }));
    }
    expect(tokenStore.get()).toMatchObject(original);
    expect(tokenStore.getGeneration()).toBe(generation);
    expect(fs.readFileSync(file, "utf8")).toBe(encrypted);
    failedRename.mockRestore();
    expect(loadTokenStore(directory).get()).toMatchObject(original);
  });

  it("keeps a session recoverable and reports failure when logout cannot remove its file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-session-"));
    tempDirs.push(directory);
    const original = { accessToken: "access-old", refreshToken: "refresh-old" };
    const tokenStore = loadTokenStore(directory);
    tokenStore.set(original);
    const file = path.join(directory, "backend-token.json");
    const failedDelete = vi.spyOn(fs, "unlinkSync").mockImplementation(() => { throw new Error("file locked"); });

    expect(tokenStore.clear()).toBe(false);
    expect(tokenStore.get()).toMatchObject(original);
    expect(fs.existsSync(file)).toBe(true);
    failedDelete.mockRestore();
    expect(tokenStore.clear()).toBe(true);
    expect(loadTokenStore(directory).get()).toBeNull();
  });

  it("uses the actual read and deletion results when a preliminary existence check would hide permission errors", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-session-"));
    tempDirs.push(directory);
    const original = { accessToken: "access-old", refreshToken: "refresh-old" };
    loadTokenStore(directory).set(original);
    const filesystem = { ...fs, existsSync: () => false, unlinkSync: (file) => {
      if (file.endsWith(".tmp")) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    } };
    const tokenStore = loadTokenStore(directory, fakeSafeStorage(), filesystem);

    expect(tokenStore.get()).toMatchObject(original);
    expect(tokenStore.clear()).toBe(false);
    expect(tokenStore.get()).toMatchObject(original);
    expect(loadTokenStore(directory).get()).toMatchObject(original);
  });

  it("preserves the previous account summary when saving an updated summary fails", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-session-"));
    tempDirs.push(directory);
    const tokenStore = loadTokenStore(directory);
    tokenStore.set({ accessToken: "access-old", refreshToken: "refresh-old", account: { nickname: "old" } });
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("disk read-only"); });

    expect(tokenStore.updateAccount({ nickname: "new" })).toBe(false);
    expect(tokenStore.get().account).toEqual({ nickname: "old" });
    expect(loadTokenStore(directory).get().account).toEqual({ nickname: "old" });
  });

  it("keeps the same session generation across ordinary token renewal", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-session-"));
    tempDirs.push(directory);
    const tokenStore = loadTokenStore(directory);
    tokenStore.set({ accessToken: "access-old", refreshToken: "refresh-old" });
    const generation = tokenStore.getGeneration();

    expect(tokenStore.replaceTokensIfCurrent(generation, "refresh-old", {
      accessToken: "access-new", refreshToken: "refresh-new",
    })).toBe(true);
    expect(tokenStore.getGeneration()).toBe(generation);
  });
});

describe("automatic access-token refresh", () => {
  it.each(["/payment/order", "/redeem"])("never replays an old %s POST with a newly logged-in account", async (pathname) => {
    const tokens = createTokenState();
    let respond;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }))
      .mockResolvedValue(response(200, { success: true }));
    const client = loadBackendClient(fetchMock, tokens);
    const pending = client.request(pathname, { method: "POST", body: { oldOperation: true } });
    tokens.clear();
    tokens.set({ accessToken: "access-B", refreshToken: "refresh-B", account: { userId: "B" } });
    respond(response(401, { code: "NOT_LOGGED_IN" }));

    await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(tokens.snapshot()).toMatchObject({ accessToken: "access-B" });
  });

  it("rejects a delayed 401 after logout without starting a refresh", async () => {
    const tokens = createTokenState();
    let respond;
    const fetchMock = vi.fn(() => new Promise((resolve) => { respond = resolve; }));
    const client = loadBackendClient(fetchMock, tokens);
    const pending = client.authMe();
    tokens.clear();
    respond(response(401, { code: "NOT_LOGGED_IN" }));

    await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(tokens.snapshot()).toBeNull();
  });

  it("discards an old account's delayed successful response after switching accounts", async () => {
    const tokens = createTokenState();
    let respond;
    const fetchMock = vi.fn(() => new Promise((resolve) => { respond = resolve; }));
    const client = loadBackendClient(fetchMock, tokens);
    const pending = client.authMe();
    tokens.clear();
    tokens.set({ accessToken: "access-B", refreshToken: "refresh-B", account: { userId: "B" } });
    respond(response(200, { success: true, data: { account: { userId: "A" } } }));

    await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(tokens.snapshot().account).toEqual({ userId: "B" });
  });

  it("accepts a delayed success when only the same session's tokens were refreshed", async () => {
    const tokens = createTokenState();
    let respond;
    const fetchMock = vi.fn(() => new Promise((resolve) => { respond = resolve; }));
    const client = loadBackendClient(fetchMock, tokens);
    const pending = client.authMe();
    tokens.replaceTokensIfCurrent(tokens.getGeneration(), "refresh-old", {
      accessToken: "access-new", refreshToken: "refresh-new",
    });
    respond(response(200, { success: true, data: { account: { userId: "A" } } }));
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it("retries a delayed 401 with a token renewed by the same session without refreshing twice", async () => {
    const tokens = createTokenState();
    let respond;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }))
      .mockResolvedValue(response(200, { success: true }));
    const client = loadBackendClient(fetchMock, tokens);
    const pending = client.authMe();
    tokens.replaceTokensIfCurrent(tokens.getGeneration(), "refresh-old", {
      accessToken: "access-new", refreshToken: "refresh-new",
    });
    respond(response(401, { code: "NOT_LOGGED_IN" }));
    await expect(pending).resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer access-new");
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/auth/refresh"))).toBe(false);
  });

  it("refreshes an expired access token and retries the original request", async () => {
    const tokens = createTokenState();
    const fetchMock = vi.fn(async (url, options) => {
      const authorization = options.headers.Authorization;
      if (url.endsWith("/auth/refresh")) {
        expect(options.body).toBe(JSON.stringify({ refresh_token: "refresh-old" }));
        expect(authorization).toBeUndefined();
        return response(200, {
          success: true,
          data: { accessToken: "access-new", refreshToken: "refresh-new" },
        });
      }
      if (authorization === "Bearer access-old") {
        return response(401, { code: "NOT_LOGGED_IN", message: "expired" });
      }
      return response(200, {
        success: true,
        data: { account: { phone: "13800138000" } },
      });
    });
    const client = loadBackendClient(fetchMock, tokens);

    const result = await client.authMe();

    expect(result.success).toBe(true);
    expect(tokens.snapshot()).toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses one refresh request for concurrent 401 responses", async () => {
    const tokens = createTokenState();
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchMock = vi.fn(async (url, options) => {
      if (url.endsWith("/auth/refresh")) {
        await refreshGate;
        return response(200, {
          success: true,
          data: { accessToken: "access-new", refreshToken: "refresh-new" },
        });
      }
      if (options.headers.Authorization === "Bearer access-old") {
        return response(401, { code: "NOT_LOGGED_IN" });
      }
      return response(200, { success: true, data: { account: {} } });
    });
    const client = loadBackendClient(fetchMock, tokens);

    const requests = [client.authMe(), client.authMe()];
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/auth/refresh"))).toHaveLength(1);
    });
    releaseRefresh();
    await expect(Promise.all(requests)).resolves.toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/auth/refresh"))).toHaveLength(1);
  });

  it.each([
    ["offline", () => Promise.reject(new Error("offline"))],
    ["timeout", () => Promise.reject(Object.assign(new Error("timeout"), { name: "AbortError" }))],
    ["server error", async () => response(503, { message: "unavailable" })],
  ])("keeps credentials on %s", async (_label, fetchImpl) => {
    const tokens = createTokenState();
    const client = loadBackendClient(vi.fn(fetchImpl), tokens);

    await expect(client.authMe()).rejects.toBeTruthy();

    expect(tokens.clear).not.toHaveBeenCalled();
    expect(tokens.snapshot()).toMatchObject({
      accessToken: "access-old",
      refreshToken: "refresh-old",
    });
  });

  it("cannot resurrect a session when logout wins an in-flight refresh race", async () => {
    const tokens = createTokenState();
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchMock = vi.fn(async (url, options) => {
      if (url.endsWith("/auth/refresh")) {
        await refreshGate;
        return response(200, {
          success: true,
          data: { accessToken: "access-new", refreshToken: "refresh-new" },
        });
      }
      if (options.headers.Authorization === "Bearer access-old") {
        return response(401, { code: "NOT_LOGGED_IN" });
      }
      return response(200, { success: true, data: { account: {} } });
    });
    const client = loadBackendClient(fetchMock, tokens);
    const pending = client.authMe();
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/auth/refresh"))).toBe(true);
    });

    tokens.clear();
    releaseRefresh();

    await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(tokens.snapshot()).toBeNull();
  });

  it.each([200, 401])("keeps a new login intact when the previous session's pending refresh returns %s", async (status) => {
    const tokens = createTokenState();
    let respond;
    const fetchMock = vi.fn(async (url) => {
      if (url.endsWith("/auth/refresh")) return new Promise((resolve) => { respond = resolve; });
      return response(401, { code: "NOT_LOGGED_IN" });
    });
    const client = loadBackendClient(fetchMock, tokens);
    const pending = client.authMe();
    await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
    tokens.set({ accessToken: "access-B", refreshToken: "refresh-B", account: { userId: "B" } });
    respond(response(status, { success: true, data: { accessToken: "access-new", refreshToken: "refresh-new" } }));

    await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(tokens.snapshot()).toMatchObject({ accessToken: "access-B", refreshToken: "refresh-B" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([200, 401])("discards the previous session's retry response %s after switching accounts", async (status) => {
    const tokens = createTokenState();
    let respond;
    const fetchMock = vi.fn(async (url, options) => {
      if (url.endsWith("/auth/refresh")) {
        return response(200, { success: true, data: { accessToken: "access-new", refreshToken: "refresh-new" } });
      }
      if (options.headers.Authorization === "Bearer access-old") return response(401, { code: "NOT_LOGGED_IN" });
      return new Promise((resolve) => { respond = resolve; });
    });
    const client = loadBackendClient(fetchMock, tokens);
    const pending = client.authMe();
    await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
    tokens.set({ accessToken: "access-B", refreshToken: "refresh-B", account: { userId: "B" } });
    respond(response(status, { success: true, data: { account: { userId: "A" } } }));

    await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(tokens.snapshot().account).toEqual({ userId: "B" });
    expect(tokens.clear).not.toHaveBeenCalled();
  });

  it("keeps new-session refresh single-flight even when an old-session refresh is still pending", async () => {
    const tokens = createTokenState();
    const responders = new Map();
    const fetchMock = vi.fn(async (url, options) => {
      if (url.endsWith("/auth/refresh")) {
        const { refresh_token } = JSON.parse(options.body);
        return new Promise((resolve) => responders.set(refresh_token, resolve));
      }
      return options.headers.Authorization === "Bearer access-B-new"
        ? response(200, { success: true })
        : response(401, { code: "NOT_LOGGED_IN" });
    });
    const client = loadBackendClient(fetchMock, tokens);
    const oldPending = client.authMe().catch((error) => error);
    await vi.waitFor(() => expect(responders.has("refresh-old")).toBe(true));
    tokens.set({ accessToken: "access-B", refreshToken: "refresh-B", account: { userId: "B" } });
    const newPending = client.authMe();
    await vi.waitFor(() => expect(responders.has("refresh-B")).toBe(true));
    responders.get("refresh-old")(response(200, {
      success: true, data: { accessToken: "access-new", refreshToken: "refresh-new" },
    }));
    await expect(oldPending).resolves.toMatchObject({ code: "SESSION_CHANGED" });
    const anotherNewPending = client.authMe();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/auth/refresh"))).toHaveLength(2);
    responders.get("refresh-B")(response(200, {
      success: true, data: { accessToken: "access-B-new", refreshToken: "refresh-B-new" },
    }));
    await expect(Promise.all([newPending, anotherNewPending])).resolves.toHaveLength(2);
    expect(tokens.snapshot().account).toEqual({ userId: "B" });
  });

  it("reports refresh persistence failure without replaying the operation or clearing the old session", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordtaker-session-"));
    tempDirs.push(directory);
    const tokens = loadTokenStore(directory);
    tokens.set({ accessToken: "access-old", refreshToken: "refresh-old" });
    const fetchMock = vi.fn(async (url) => url.endsWith("/auth/refresh")
      ? response(200, { success: true, data: { accessToken: "access-new", refreshToken: "refresh-new" } })
      : response(401, { code: "NOT_LOGGED_IN" }));
    const client = loadBackendClient(fetchMock, tokens);
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("disk read-only"); });

    await expect(client.request("/redeem", { method: "POST", body: { code: "test" } }))
      .rejects.toMatchObject({ code: "AUTH_PERSISTENCE_FAILED" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokens.getAccessToken()).toBe("access-old");
    expect(tokens.getRefreshToken()).toBe("refresh-old");
  });

  it("clears a session only when the refresh credential is definitively rejected", async () => {
    const tokens = createTokenState();
    const fetchMock = vi.fn(async (url) => {
      if (url.endsWith("/auth/refresh")) {
        return response(401, {
          code: "INVALID_REFRESH_TOKEN",
          message: "revoked",
        });
      }
      return response(401, { code: "NOT_LOGGED_IN" });
    });
    const client = loadBackendClient(fetchMock, tokens);

    await expect(client.authMe()).rejects.toMatchObject({
      status: 401,
      code: "INVALID_REFRESH_TOKEN",
    });

    expect(tokens.clear).toHaveBeenCalledOnce();
    expect(tokens.snapshot()).toBeNull();
  });

  it.each([
    null,
    { success: false },
    { success: true, data: {} },
    { success: true, data: { accessToken: " ", refreshToken: "refresh-new" } },
    { success: true, data: { accessToken: "access-new", refreshToken: {} } },
    { success: true, data: { accessToken: "access-new", refreshToken: " " } },
  ])("keeps credentials when the refresh response is malformed: %j", async (body) => {
    const tokens = createTokenState();
    const client = loadBackendClient(vi.fn(async (url) => url.endsWith("/auth/refresh")
      ? response(200, body) : response(401, { code: "NOT_LOGGED_IN" })), tokens);
    await expect(client.authMe()).rejects.toMatchObject({ code: "INVALID_REFRESH_RESPONSE" });
    expect(tokens.snapshot().accessToken).toBe("access-old");
    expect(tokens.clear).not.toHaveBeenCalled();
  });

  it("preserves an expired legacy access-only session without attempting a refresh", async () => {
    const tokens = createTokenState();
    tokens.set({ accessToken: "access-old", refreshToken: null });
    const fetchMock = vi.fn().mockResolvedValue(response(401, { code: "NOT_LOGGED_IN" }));
    const client = loadBackendClient(fetchMock, tokens);
    await expect(client.authMe()).rejects.toMatchObject({ status: 401, code: "NOT_LOGGED_IN" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(tokens.snapshot().accessToken).toBe("access-old");
  });

  it("invalidates the same session if the renewed access token is explicitly rejected", async () => {
    const tokens = createTokenState();
    const client = loadBackendClient(vi.fn(async (url) => url.endsWith("/auth/refresh")
      ? response(200, { success: true, data: { accessToken: "access-new", refreshToken: "refresh-new" } })
      : response(401, { code: "NOT_LOGGED_IN" })), tokens);
    await expect(client.authMe()).rejects.toMatchObject({ status: 401 });
    expect(tokens.snapshot()).toBeNull();
  });

  it.each(["refresh", "retry"])("reports persistent cleanup failure after the server rejects %s", async (failure) => {
    const tokens = createTokenState();
    tokens.clear.mockImplementation(() => false);
    const client = loadBackendClient(vi.fn(async (url) => url.endsWith("/auth/refresh") && failure === "retry"
      ? response(200, { success: true, data: { accessToken: "access-new", refreshToken: "refresh-new" } })
      : response(401, { code: "NOT_LOGGED_IN" })), tokens);
    await expect(client.authMe()).rejects.toMatchObject({
      status: 401, code: "AUTH_LOGOUT_PERSISTENCE_FAILED",
    });
    expect(tokens.snapshot()).not.toBeNull();
  });

  it("maps a real aborted request to a timeout without deleting credentials", async () => {
    const tokens = createTokenState();
    const client = loadBackendClient((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }), tokens, 5);
    await expect(client.authMe()).rejects.toMatchObject({ kind: "timeout" });
    expect(tokens.clear).not.toHaveBeenCalled();
  });

  it("maps unparseable HTTP errors without clearing the session", async () => {
    const tokens = createTokenState();
    const client = loadBackendClient(async () => ({ ok: false, status: 503, text: async () => "not json" }), tokens);
    await expect(client.authMe()).rejects.toMatchObject({ status: 503, message: "后端错误 HTTP 503" });
    expect(tokens.clear).not.toHaveBeenCalled();
  });
});

describe("API contracts through the session-bound request pipeline", () => {
  it("keeps authenticated payment and account transport contracts intact", async () => {
    const tokens = createTokenState();
    const fetchMock = vi.fn(async () => response(200, { success: true, data: {} }));
    const client = loadBackendClient(fetchMock, tokens);
    await client.createOrder("month", "wechat");
    await client.getPaymentOrder("12/34");
    await client.mockPay(12);
    await client.redeem("code");
    await client.authSmsSend("13800138000");
    await client.authSmsLogin("13800138000", "123456", "invite");
    await client.getLocalPrompt("normal");
    expect(fetchMock.mock.calls.map(([url]) => url.split("/api/v1")[1])).toEqual([
      "/payment/order", "/payment/order/12%2F34", "/payment/mock/pay", "/redeem",
      "/auth/sms/send", "/auth/sms/login", "/prompt?mode=normal",
    ]);
    expect(fetchMock.mock.calls.map(([, options]) => options.body && JSON.parse(options.body))).toEqual([
      { planCode: "month", channel: "wechat" }, undefined, { orderId: "12" }, { code: "code" },
      { phone: "13800138000" }, { phone: "13800138000", code: "123456", inviteCode: "invite", deviceId: "test-device-123" }, undefined,
    ]);
    expect(fetchMock.mock.calls.every(([, options]) => options.headers.Authorization === "Bearer access-old")).toBe(true);
  });

  it.each([{}, null])("retains safe result defaults for incomplete responses: %j", async (data) => {
    const tokens = createTokenState();
    const fetchMock = vi.fn(async () => response(200, { success: true, data }));
    const client = loadBackendClient(fetchMock, tokens);
    expect(await client.polish("text", "normal")).toEqual({
      text: "", visibleChars: null, cloudRemaining: null, subscription: null, dailyUsed: null, dailyCap: null,
    });
    expect(await client.getQuota()).toEqual({
      userId: null, registered: false, cloudRemaining: null, subscription: null, dailyUsed: null, dailyCap: null,
    });
    expect(await client.listPlans()).toEqual([]);
    expect(await client.getLocalPrompt("normal")).toEqual(data);
    expect(await client.createOrder("month", "wechat")).toEqual({});
    expect(await client.getPaymentOrder("12")).toEqual({});
    expect(await client.mockPay(12)).toEqual({});
    expect(await client.redeem("code")).toEqual({});
  });

  it("preserves populated quota, polish, word-map and plan results", async () => {
    const tokens = createTokenState();
    const data = { output: "最终文本", visibleChars: 4, userId: "A", registered: true,
      cloudRemaining: 12, subscription: { active: true }, dailyUsed: 8, dailyCap: 100 };
    const fetchMock = vi.fn(async (url) => response(200, { success: true, data: url.endsWith("/payment/plans") ? [data] : data }));
    const client = loadBackendClient(fetchMock, tokens);
    const wordMap = [{ from: "甲", to: "乙" }];
    expect(await client.polish("甲", "normal", wordMap)).toMatchObject({ text: "最终文本", cloudRemaining: 12 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).word_map).toEqual(wordMap);
    expect(await client.getQuota()).toMatchObject({ userId: "A", registered: true, cloudRemaining: 12 });
    expect(await client.listPlans()).toEqual([data]);
  });
});
