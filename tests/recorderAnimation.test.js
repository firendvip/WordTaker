import { describe, expect, it } from "vitest";
import {
  catHorizontalPosition,
  resolveCatMotion,
  resolveRecorderMicState,
  shouldShowCat,
  voiceInkBarHeight,
} from "../src/utils/recorderAnimation.js";

describe("recorder animation", () => {
  it("keeps visibly moving during a silent recording", () => {
    const frames = [0, 0.08, 0.16, 0.24, 0.32].map((timeSeconds) =>
      voiceInkBarHeight({
        index: 7,
        timeSeconds,
        level: 0,
        isRecording: true,
        reducedMotion: false,
      }),
    );

    expect(Math.max(...frames)).toBeGreaterThan(4);
    expect(new Set(frames.map((height) => height.toFixed(2))).size).toBeGreaterThan(1);
  });

  it("returns every bar to the idle baseline after recording stops", () => {
    for (const timeSeconds of [0, 0.4, 1.2]) {
      expect(
        voiceInkBarHeight({
          index: 3,
          timeSeconds,
          level: 1,
          isRecording: false,
          reducedMotion: false,
        }),
      ).toBe(4);
    }
  });

  it("keeps a static visible recording indicator for reduced motion", () => {
    const first = voiceInkBarHeight({
      index: 7,
      timeSeconds: 0,
      level: 0,
      isRecording: true,
      reducedMotion: true,
    });
    const later = voiceInkBarHeight({
      index: 7,
      timeSeconds: 9,
      level: 0,
      isRecording: true,
      reducedMotion: true,
    });

    expect(first).toBeGreaterThan(4);
    expect(later).toBe(first);
  });

  it("keeps the default cat skin visibly moving throughout a silent recording", () => {
    expect(
      resolveCatMotion({
        isRecording: true,
        isBusy: false,
        reducedMotion: false,
      }),
    ).toBe("walk");

    const frames = [0, 0.2, 0.4].map((phase) =>
      catHorizontalPosition({ center: 90, amplitude: 56, phase }),
    );
    expect(new Set(frames.map((position) => position.toFixed(2))).size).toBeGreaterThan(1);
  });

  it("stops cat travel after recording and stays static for reduced motion", () => {
    expect(resolveCatMotion({ isRecording: false })).toBe("rest");
    expect(resolveCatMotion({ isBusy: true })).toBe("process");
    expect(
      resolveCatMotion({
        isRecording: true,
        reducedMotion: true,
      }),
    ).toBe("static");
  });

  it("uses the shared session state in the control panel without overriding the main recorder", () => {
    expect(
      resolveRecorderMicState({
        isControlPanel: true,
        localIsRecording: false,
        sharedIsRecording: true,
      }),
    ).toBe("recording");

    expect(
      resolveRecorderMicState({
        isControlPanel: true,
        localIsRecording: true,
        sharedIsRecording: false,
      }),
    ).toBe("idle");

    expect(
      resolveRecorderMicState({
        isControlPanel: true,
        sharedIsRecording: false,
        sharedIsBusy: true,
      }),
    ).toBe("processing");

    expect(
      resolveRecorderMicState({
        isControlPanel: false,
        localIsRecording: true,
        sharedIsRecording: false,
      }),
    ).toBe("recording");
  });

  it("preserves processing, optimizing and hover state precedence", () => {
    expect(resolveRecorderMicState({ isProcessing: true })).toBe("processing");
    expect(resolveRecorderMicState({ isOptimizing: true })).toBe("optimizing");
    expect(resolveRecorderMicState({ isHovered: true })).toBe("hover");
    expect(resolveRecorderMicState({})).toBe("idle");
  });

  it("shows the cat as soon as the recorder window wakes, before the microphone is ready", () => {
    expect(
      shouldShowCat({
        recorderWindowVisible: true,
        micState: "idle",
      }),
    ).toBe(true);
    expect(
      shouldShowCat({
        recorderWindowVisible: false,
        micState: "idle",
      }),
    ).toBe(false);
  });

  it("keeps the cat visible throughout recording and processing", () => {
    expect(shouldShowCat({ micState: "recording" })).toBe(true);
    expect(shouldShowCat({ micState: "processing" })).toBe(true);
    expect(shouldShowCat({ micState: "optimizing" })).toBe(true);
  });
});
