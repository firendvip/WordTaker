import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  resolveCancelShortcut,
} = require("../src/utils/cancelShortcutPolicy.cjs");
const {
  cancelRecorderSession,
  isRecorderSessionCurrent,
} = require("../src/utils/recorderSession.cjs");

describe("recorder cancellation", () => {
  it("registers the default single Escape through globalShortcut without accessibility access", () => {
    expect(resolveCancelShortcut({ key: "Escape", taps: 1 })).toEqual({
      type: "accelerator",
      accelerator: "Escape",
    });
  });

  it("keeps multi-tap cancel keys on the tap-aware listener", () => {
    expect(resolveCancelShortcut({ key: "Escape", taps: 2 })).toEqual({
      type: "tap-listener",
      key: "Escape",
      taps: 2,
    });
  });

  it("normalizes missing and invalid single-tap settings to Escape", () => {
    expect(resolveCancelShortcut()).toEqual({
      type: "accelerator",
      accelerator: "Escape",
    });
    expect(resolveCancelShortcut({ key: "", taps: 99 })).toEqual({
      type: "accelerator",
      accelerator: "Escape",
    });
  });

  it("falls back to an accelerator when a key has no tap-aware mapping", () => {
    expect(resolveCancelShortcut({ key: "F3", taps: "2" })).toEqual({
      type: "accelerator",
      accelerator: "F3",
    });
  });

  it("invalidates an in-flight recognition or polish result immediately", () => {
    const cancelledRef = { current: false };
    const generationRef = { current: 7 };

    cancelRecorderSession({ cancelledRef, generationRef });

    expect(cancelledRef.current).toBe(true);
    expect(generationRef.current).toBe(8);
    expect(isRecorderSessionCurrent({
      generation: 7,
      generationRef,
      cancelledRef,
    })).toBe(false);
  });

  it("accepts output only from the current non-cancelled session", () => {
    const cancelledRef = { current: false };
    const generationRef = { current: 4 };

    expect(isRecorderSessionCurrent({
      generation: 4,
      generationRef,
      cancelledRef,
    })).toBe(true);
    expect(isRecorderSessionCurrent({
      generation: 3,
      generationRef,
      cancelledRef,
    })).toBe(false);
  });
});
