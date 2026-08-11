import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatAiOptimizeLabel } from "../src/utils/historyPerformance.js";

describe("history performance label", () => {
  it("uses end-to-end time for the local model speed and duration", () => {
    expect(
      formatAiOptimizeLabel({
        polish_engine: "local-4b",
        processed_text: "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午",
        e2e_total_ms: 2410,
        polish_duration_ms: 1020,
      }),
    ).toBe("AI优化·本地模型 7字/秒，总耗时：2.41秒");
  });

  it("uses the same end-to-end metric for the cloud model", () => {
    expect(
      formatAiOptimizeLabel({
        polish_engine: "cloud",
        processed_text: "云端测试文本",
        e2e_total_ms: 2000,
      }),
    ).toBe("AI优化·云端AI 3字/秒，总耗时：2.00秒");
  });

  it("counts Unicode code points in the final landed text", () => {
    expect(
      formatAiOptimizeLabel({
        polish_engine: "cloud",
        processed_text: "猫🐈好",
        e2e_total_ms: 1000,
      }),
    ).toBe("AI优化·云端AI 3字/秒，总耗时：1.00秒");
  });

  it("never falls back to polish duration when end-to-end time is missing", () => {
    expect(
      formatAiOptimizeLabel({
        polish_engine: "local-4b",
        processed_text: "有效文本",
        polish_duration_ms: 500,
      }),
    ).toBe("AI优化·本地模型");
  });

  it("omits speed and duration when final text is empty", () => {
    expect(
      formatAiOptimizeLabel({
        polish_engine: "cloud",
        processed_text: "",
        raw_text: "",
        e2e_total_ms: 1200,
      }),
    ).toBe("AI优化·云端AI");
  });

  it("retains the streaming first-character metric without inventing end-to-end data", () => {
    expect(
      formatAiOptimizeLabel({
        polish_engine: "local-4b",
        processed_text: "文本",
        polish_first_char_ms: 219,
      }),
    ).toBe("AI优化·本地模型，流式上屏首字：0.21秒");
  });

  it("removes the standalone end-to-end badge from the history page", () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const historySource = fs.readFileSync(
      path.resolve(testDir, "../src/history.jsx"),
      "utf8",
    );

    expect(historySource).not.toContain("e2eThroughputLabel");
    expect(historySource).not.toContain("端到端 ${");
  });
});
