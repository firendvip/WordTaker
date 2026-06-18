import { describe, it, expect } from "vitest";
import { shouldSkipPolish } from "../src/utils/skipPolish.js";

describe("shouldSkipPolish", () => {
  it("短且干净 → 跳过润色", () => {
    expect(shouldSkipPolish("好的", 6)).toBe(true);
    expect(shouldSkipPolish("收到了", 6)).toBe(true);
    expect(shouldSkipPolish("谢谢", 6)).toBe(true); // 2 叠字属正常
  });

  it("超过阈值 → 不跳过", () => {
    expect(shouldSkipPolish("这是一句比较长的话", 6)).toBe(false);
  });

  it("含填充词/口吃 → 不跳过(即使短)", () => {
    expect(shouldSkipPolish("那个好的", 6)).toBe(false);
    expect(shouldSkipPolish("我我我", 6)).toBe(false); // 3+ 叠字
    expect(shouldSkipPolish("嗯对", 6)).toBe(false);
  });

  it("空文本 / 关闭(0) → 不跳过", () => {
    expect(shouldSkipPolish("", 6)).toBe(false);
    expect(shouldSkipPolish("好的", 0)).toBe(false);
  });

  it("按字符数而非字节计长", () => {
    expect(shouldSkipPolish("一二三四五六", 6)).toBe(true); // 正好 6
    expect(shouldSkipPolish("一二三四五六七", 6)).toBe(false); // 7
  });
});
