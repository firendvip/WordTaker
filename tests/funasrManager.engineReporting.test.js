import { describe, expect, it, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const FunASRManager = require("../src/helpers/funasrManager.js");

describe("FunASRManager engine reporting", () => {
  it("preserves actual engine metadata and logs an explicit fallback", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const manager = Object.create(FunASRManager.prototype);
    Object.assign(manager, {
      logger,
      serverReady: true,
      initializationPromise: null,
      checkFunASRInstallation: vi.fn().mockResolvedValue({ installed: true }),
      createTempAudioFile: vi.fn().mockResolvedValue("/tmp/fake.wav"),
      cleanupTempFile: vi.fn().mockResolvedValue(undefined),
      _sendServerCommand: vi.fn().mockResolvedValue({
        success: true,
        text: "测试",
        raw_text: "测试",
        confidence: 0,
        language: "zh-CN",
        requested_engine: "sensevoice",
        actual_engine: "paraformer",
        fallback_reason: "SenseVoice 模型缺失",
        model_type: "paraformer-pytorch",
      }),
    });

    const result = await manager.transcribeAudio(new Uint8Array([1]), { engine: "sensevoice" });

    expect(result).toEqual(expect.objectContaining({
      requested_engine: "sensevoice",
      actual_engine: "paraformer",
      fallback_reason: "SenseVoice 模型缺失",
      model_type: "paraformer-pytorch",
    }));
    expect(logger.warn).toHaveBeenCalledWith(
      "ASR识别引擎已降级",
      expect.objectContaining({ requestedEngine: "sensevoice", actualEngine: "paraformer" }),
    );
  });
});
