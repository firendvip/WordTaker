import { describe, expect, it, vi } from "vitest";
import {
  formatRuntimeAppTitle,
  syncRuntimeDocumentTitle,
} from "../src/utils/appTitle.js";

describe("runtime document title", () => {
  it("formats the title from the runtime app version", () => {
    expect(formatRuntimeAppTitle("1.28.4")).toBe("弦外小猫 1.28.4");
    expect(formatRuntimeAppTitle("")).toBe("弦外小猫");
  });

  it("reads app.getVersion through the preload API instead of hardcoding it", async () => {
    const documentRef = { title: "旧标题" };
    const getAppVersion = vi.fn(async () => "1.28.4");

    await syncRuntimeDocumentTitle({ getAppVersion, documentRef });

    expect(getAppVersion).toHaveBeenCalledOnce();
    expect(documentRef.title).toBe("弦外小猫 1.28.4");
  });

  it("falls back to the product name when runtime lookup fails", async () => {
    const documentRef = { title: "旧标题" };

    await syncRuntimeDocumentTitle({
      getAppVersion: vi.fn(async () => {
        throw new Error("unavailable");
      }),
      documentRef,
    });

    expect(documentRef.title).toBe("弦外小猫");
  });
});
