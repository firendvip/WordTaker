import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const candidateConfig = require("../electron-builder.passport-candidate.cjs");
const {
  createPassportPreloadApi,
  resolvePassportCapability,
} = require("../src/helpers/passportCapability.js");

describe("default-off Passport capability", () => {
  it("ships the default package without an OS protocol and a candidate with exactly one", () => {
    expect(packageJson.build.protocols || []).toEqual([]);
    expect(packageJson.wordtakerPassportCandidate).not.toBe(true);
    expect(candidateConfig.extraMetadata).toMatchObject({ wordtakerPassportCandidate: true });
    expect(candidateConfig.protocols).toEqual([
      { name: "Wangsan WordTaker OAuth", schemes: ["wangsan-wordtaker"] },
    ]);
  });

  it("requires an explicit development flag or an explicit candidate package", () => {
    expect(resolvePassportCapability({
      isPackaged: true,
      packageMetadata: packageJson,
      environmentValue: "1",
    }).enabled).toBe(false);
    expect(resolvePassportCapability({
      isPackaged: false,
      packageMetadata: packageJson,
      environmentValue: "1",
    }).enabled).toBe(true);
    expect(resolvePassportCapability({
      isPackaged: true,
      packageMetadata: candidateConfig.extraMetadata,
    }).enabled).toBe(true);
    expect(resolvePassportCapability({
      isPackaged: true,
      packageMetadata: candidateConfig.extraMetadata,
      environmentValue: "0",
    }).enabled).toBe(false);
  });

  it("does not expose or register Passport renderer channels when disabled", () => {
    const ipcRenderer = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    expect(createPassportPreloadApi({ enabled: false, ipcRenderer })).toEqual({});
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(ipcRenderer.on).not.toHaveBeenCalled();

    expect(() => createPassportPreloadApi({ enabled: true, ipcRenderer: null }))
      .toThrow(/ipcRenderer/i);
    const api = createPassportPreloadApi({ enabled: true, ipcRenderer });
    api.authPassportLogin();
    api.authPassportAccount();
    const callback = vi.fn();
    const cleanup = api.onPassportAuthResult(callback);
    const listener = ipcRenderer.on.mock.calls[0][1];
    listener({}, { success: true });
    expect(callback).toHaveBeenCalledWith({ success: true });
    cleanup();
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, "auth-passport-login");
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, "auth-passport-account");
    expect(ipcRenderer.on).toHaveBeenCalledWith("passport-auth-result", expect.any(Function));
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "passport-auth-result",
      expect.any(Function),
    );
  });
});
