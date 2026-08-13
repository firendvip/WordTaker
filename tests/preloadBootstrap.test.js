import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preloadSource = fs.readFileSync(path.join(root, "preload.js"), "utf8");

function executeSandboxedPreload(additionalArguments = []) {
  const exposed = new Map();
  const ipcRenderer = {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  };
  const electron = {
    contextBridge: {
      exposeInMainWorld: vi.fn((name, value) => exposed.set(name, value)),
    },
    ipcRenderer,
  };
  const sandboxRequire = vi.fn((specifier) => {
    if (specifier === "electron") return electron;
    throw new Error(`sandbox preload attempted local require: ${specifier}`);
  });

  vm.runInNewContext(preloadSource, {
    console,
    require: sandboxRequire,
    process: {
      argv: ["Electron", ...additionalArguments],
      arch: "arm64",
      env: {},
      platform: "darwin",
      versions: { chrome: "150", electron: "43.3.0", node: "24.18.1" },
    },
  }, { filename: "preload.js" });

  return { exposed, ipcRenderer, sandboxRequire };
}

describe("packaged sandbox preload bootstrap", () => {
  it("is self-contained and exposes no Passport API for the default artifact", () => {
    const result = executeSandboxedPreload(["--wordtaker-passport-enabled=0"]);
    const api = result.exposed.get("electronAPI");

    expect(result.sandboxRequire).toHaveBeenCalledTimes(1);
    expect(result.sandboxRequire).toHaveBeenCalledWith("electron");
    expect(api).toBeTruthy();
    expect(api.authPassportLogin).toBeUndefined();
    expect(api.authPassportAccount).toBeUndefined();
    expect(api.onPassportAuthResult).toBeUndefined();
  });

  it("exposes only high-level Passport channels for the candidate argument", () => {
    const { exposed, ipcRenderer } = executeSandboxedPreload([
      "--wordtaker-passport-enabled=1",
    ]);
    const api = exposed.get("electronAPI");

    api.authPassportLogin();
    api.authPassportAccount();
    const callback = vi.fn();
    const cleanup = api.onPassportAuthResult(callback);
    const listener = ipcRenderer.on.mock.calls[0][1];
    listener({}, { success: true });
    cleanup();

    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, "auth-passport-login");
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, "auth-passport-account");
    expect(callback).toHaveBeenCalledWith({ success: true });
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "passport-auth-result",
      listener,
    );
    expect(api.getAccessToken).toBeUndefined();
    expect(api.getRefreshToken).toBeUndefined();
    expect(api.getIdToken).toBeUndefined();
  });

  it("fails closed for caller-controlled lookalike arguments", () => {
    for (const argument of [
      "--wordtaker-passport-enabled=true",
      "--wordtaker-passport-enabled=01",
      "--wordtaker-passport-enabled=1 --inspect",
    ]) {
      const api = executeSandboxedPreload([argument]).exposed.get("electronAPI");
      expect(api.authPassportLogin).toBeUndefined();
    }
  });
});
