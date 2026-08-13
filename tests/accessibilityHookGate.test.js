import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const triggerManagerPath = path.resolve(testDir, "../src/helpers/triggerManager.js");
const mainPath = path.resolve(testDir, "../main.js");
const electronPath = require.resolve("electron");
const uiohookPath = require.resolve("uiohook-napi");
const originalPlatform = process.platform;

const keycodes = {
  Alt: 56,
  AltRight: 3640,
  Ctrl: 29,
  CtrlRight: 3613,
  Shift: 42,
  ShiftRight: 54,
  Meta: 3675,
  MetaRight: 3676,
  Escape: 1,
  F1: 59,
  F2: 60,
  F4: 62,
  F8: 66,
};

function loadTriggerManager({ platform = "darwin", trusted = false, detectionError } = {}) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });

  const uIOhook = new EventEmitter();
  uIOhook.start = vi.fn();
  uIOhook.stop = vi.fn();
  const isTrustedAccessibilityClient = vi.fn(() => {
    if (detectionError) throw detectionError;
    return trusted;
  });

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { systemPreferences: { isTrustedAccessibilityClient } },
  };
  require.cache[uiohookPath] = {
    id: uiohookPath,
    filename: uiohookPath,
    loaded: true,
    exports: { uIOhook, UiohookKey: keycodes },
  };
  delete require.cache[triggerManagerPath];

  return {
    TriggerManager: require(triggerManagerPath),
    isTrustedAccessibilityClient,
    uIOhook,
  };
}

afterEach(() => {
  delete require.cache[triggerManagerPath];
  delete require.cache[electronPath];
  delete require.cache[uiohookPath];
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
  vi.restoreAllMocks();
});

describe("macOS accessibility gate for global hooks", () => {
  it("silently blocks all three production hook entry types when this app identity is not trusted", () => {
    const { TriggerManager, isTrustedAccessibilityClient, uIOhook } =
      loadTriggerManager({ trusted: false });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const configs = [
      { type: "modifier-tap", key: "LeftOption", taps: 1 }, // recording
      { type: "modifier-tap", key: "RightOption", taps: 2 }, // translate
      { type: "modifier-tap", key: "Escape", taps: 2 }, // double-tap cancel
    ];

    for (const config of configs) {
      const manager = new TriggerManager(logger);
      expect(manager.start(config, vi.fn())).toBe(false);
      expect(manager.startFailureReason).toBe("accessibility-untrusted");
      expect(TriggerManager.isAccessibilityBlocked(manager)).toBe(true);
    }

    expect(isTrustedAccessibilityClient).toHaveBeenCalledTimes(3);
    expect(isTrustedAccessibilityClient).toHaveBeenCalledWith(false);
    expect(uIOhook.start).not.toHaveBeenCalled();
    expect(uIOhook.listenerCount("keydown")).toBe(0);
    expect(uIOhook.listenerCount("keyup")).toBe(0);
  });

  it("fails closed without starting uIOhook when non-prompting detection throws", () => {
    const { TriggerManager, isTrustedAccessibilityClient, uIOhook } =
      loadTriggerManager({ detectionError: new Error("TCC unavailable") });
    const manager = new TriggerManager();

    expect(manager.start({ type: "modifier-tap", key: "RightOption", taps: 2 }, vi.fn()))
      .toBe(false);
    expect(manager.startFailureReason).toBe("accessibility-check-failed");
    expect(TriggerManager.isAccessibilityBlocked(manager)).toBe(true);
    expect(isTrustedAccessibilityClient).toHaveBeenCalledWith(false);
    expect(uIOhook.start).not.toHaveBeenCalled();
  });

  it("still starts the native hook for a trusted macOS app identity", () => {
    const { TriggerManager, isTrustedAccessibilityClient, uIOhook } =
      loadTriggerManager({ trusted: true });
    const manager = new TriggerManager();

    expect(manager.start({ type: "modifier-tap", key: "RightOption", taps: 2 }, vi.fn()))
      .toBe(true);
    expect(manager.startFailureReason).toBeNull();
    expect(isTrustedAccessibilityClient).toHaveBeenCalledWith(false);
    expect(uIOhook.start).toHaveBeenCalledOnce();
  });

  it("preserves native hook startup on non-macOS platforms", () => {
    const { TriggerManager, isTrustedAccessibilityClient, uIOhook } =
      loadTriggerManager({ platform: "win32", trusted: false });
    const manager = new TriggerManager();

    expect(manager.start({ type: "modifier-tap", key: "LeftAlt", taps: 1 }, vi.fn()))
      .toBe(true);
    expect(isTrustedAccessibilityClient).not.toHaveBeenCalled();
    expect(uIOhook.start).toHaveBeenCalledOnce();
  });

  it("routes every production TriggerManager.start caller through the silent-block policy", () => {
    const source = fs.readFileSync(mainPath, "utf8");
    const guardedManagers = [...source.matchAll(
      /TriggerManager\.isAccessibilityBlocked\((\w+)\)/g,
    )].map((match) => match[1]);

    expect(new Set(guardedManagers)).toEqual(new Set([
      "triggerManager",
      "translateTriggerManager",
      "cancelTriggerManager",
    ]));
  });
});
