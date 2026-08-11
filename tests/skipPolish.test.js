import { describe, it, expect } from "vitest";
import { shouldSkipPolish } from "../src/utils/skipPolish.js";

describe("shouldSkipPolish", () => {
  it("6 字及以下始终跳过润色", () => {
    expect(shouldSkipPolish("好的", 6)).toBe(true);
    expect(shouldSkipPolish("收到了", 6)).toBe(true);
    expect(shouldSkipPolish("那个好的", 6)).toBe(true);
    expect(shouldSkipPolish("我我我", 6)).toBe(true);
    expect(shouldSkipPolish("嗯对", 6)).toBe(true);
  });

  it("超过阈值 → 不跳过", () => {
    expect(shouldSkipPolish("这是一句比较长的话", 6)).toBe(false);
  });

  it("空文本 / 关闭(0) → 不跳过", () => {
    expect(shouldSkipPolish("", 6)).toBe(false);
    expect(shouldSkipPolish("好的", 0)).toBe(false);
  });

  it("按 Unicode 字符计数并忽略首尾空白", () => {
    expect(shouldSkipPolish("一二三四五六", 6)).toBe(true); // 正好 6
    expect(shouldSkipPolish("一二三四五六七", 6)).toBe(false); // 7
    expect(shouldSkipPolish("  猫🐈好  ", 3)).toBe(true);
  });
});
