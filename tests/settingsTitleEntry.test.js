import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("settings window title", () => {
  it("syncs the production settings entry title from the runtime app version", async () => {
    const source = await readFile(
      new URL("../src/settings.jsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'import { syncRuntimeDocumentTitle } from "./utils/appTitle";',
    );
    expect(source).toMatch(
      /syncRuntimeDocumentTitle\(\{\s*getAppVersion:\s*window\.electronAPI\?\.getAppVersion,\s*documentRef:\s*document,\s*\}\)/s,
    );
  });
});
