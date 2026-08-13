import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const clipboardPath = path.resolve(testDir, "../src/helpers/clipboard.js");
const electronPath = require.resolve("electron");
const childProcessPath = "child_process";
const originalPlatform = process.platform;

describe("ClipboardManager macOS accessibility checks", () => {
  let clipboardText;
  let mockSpawn;
  let isTrustedAccessibilityClient;
  let ClipboardManager;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });

    clipboardText = "";
    mockSpawn = vi.fn();
    isTrustedAccessibilityClient = vi.fn(() => false);

    require.cache[electronPath] = {
      id: electronPath,
      filename: electronPath,
      loaded: true,
      exports: {
        clipboard: {
          readText: vi.fn(() => clipboardText),
          writeText: vi.fn((text) => { clipboardText = text; }),
        },
        systemPreferences: { isTrustedAccessibilityClient },
      },
    };
    require.cache[childProcessPath] = {
      id: childProcessPath,
      filename: childProcessPath,
      loaded: true,
      exports: { spawn: mockSpawn },
    };
    delete require.cache[clipboardPath];
    ClipboardManager = require(clipboardPath);
  });

  afterEach(() => {
    delete require.cache[clipboardPath];
    delete require.cache[electronPath];
    delete require.cache[childProcessPath];
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it("uses the app identity's non-prompting TCC status instead of a read-only System Events probe", async () => {
    const manager = new ClipboardManager();

    await expect(manager.checkAccessibilityPermissions()).resolves.toBe(false);

    expect(isTrustedAccessibilityClient).toHaveBeenCalledOnce();
    expect(isTrustedAccessibilityClient).toHaveBeenCalledWith(false);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("fails closed when the non-prompting TCC status check throws", async () => {
    isTrustedAccessibilityClient.mockImplementation(() => {
      throw new Error("TCC unavailable");
    });
    const manager = new ClipboardManager();

    await expect(manager.checkAccessibilityPermissions()).resolves.toBe(false);

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("reuses the exact app identity check for the legacy enable-accessibility IPC", async () => {
    isTrustedAccessibilityClient.mockReturnValue(true);
    const manager = new ClipboardManager();

    await expect(manager.enableMacOSAccessibility()).resolves.toBe(true);

    expect(isTrustedAccessibilityClient).toHaveBeenCalledWith(false);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("never attempts Cmd+V when this exact app identity is untrusted", async () => {
    const manager = new ClipboardManager();

    await expect(manager.pasteText("不会误报成功"))
      .rejects.toThrow("需要辅助功能权限");

    expect(clipboardText).toBe("不会误报成功");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("runs Cmd+V only after this exact app identity is trusted", async () => {
    isTrustedAccessibilityClient.mockReturnValue(true);
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });
    const manager = new ClipboardManager();

    await expect(manager.pasteText("可以粘贴")).resolves.toBeUndefined();

    expect(mockSpawn).toHaveBeenCalledWith("osascript", [
      "-e",
      'tell application "System Events" to keystroke "v" using command down',
    ]);
  });

});
