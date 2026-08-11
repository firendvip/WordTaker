import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  NORMAL_SAFE_FALLBACK_PROMPT,
  normalizeMode,
  pickSystemPrompt,
  validateNormalPrompt,
} = require("../relay/tencent-scf-web/promptPolicy.js");

describe("normal role prompt policy", () => {
  it("defines a safe minimal-edit fallback for the normal role", () => {
    const result = validateNormalPrompt(NORMAL_SAFE_FALLBACK_PROMPT);

    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("rejects a generic rewrite prompt that may substantially change the user's wording", () => {
    const result = validateNormalPrompt(
      "请理顺逻辑、重组语序、必要时拆分长句并输出更清晰的表达。",
    );

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("minimal-edit");
    expect(result.missing).toContain("prompt-injection-boundary");
  });

  it("never falls normal back to the more aggressive copywriting role", () => {
    const selected = pickSystemPrompt(
      {
        copywriting: "大幅改写并重新组织全文。",
        normal: "缺少安全边界的普通提示词。",
      },
      "normal",
    );

    expect(selected).toBe(NORMAL_SAFE_FALLBACK_PROMPT);
    expect(selected).not.toContain("大幅改写");
  });

  it("uses a valid private normal prompt without exposing or changing other modes", () => {
    const privateNormal = `${NORMAL_SAFE_FALLBACK_PROMPT}\n请在有歧义时保留原文。`;
    const prompts = {
      normal: privateNormal,
      gaoeq: "高情商私有提示词",
      copywriting: "文案私有提示词",
    };

    expect(pickSystemPrompt(prompts, "normal")).toBe(privateNormal);
    expect(pickSystemPrompt(prompts, "gaoeq")).toBe("高情商私有提示词");
  });

  it("does not authorize punctuation or stylistic edits outside the requested three operations", () => {
    expect(NORMAL_SAFE_FALLBACK_PROMPT).not.toMatch(/补充.{0,8}标点/);
    expect(NORMAL_SAFE_FALLBACK_PROMPT).toContain("不得主动增删或调整标点");
  });

  it("normalizes untrusted modes to a known role", () => {
    expect(normalizeMode("normal")).toBe("normal");
    expect(normalizeMode("translate-en")).toBe("translate-en");
    expect(normalizeMode("__proto__")).toBe("copywriting");
    expect(normalizeMode({ toString: () => "normal" })).toBe("copywriting");
  });
});
