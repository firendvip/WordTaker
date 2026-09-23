import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { build } = require("../package.json");

describe("electron-builder 26 configuration", () => {
  it("uses the supported boolean macOS notarization switch", () => {
    expect(build.mac.notarize).toBe(true);
  });

  it("keeps credentials outside version-controlled build metadata", () => {
    expect(JSON.stringify(build)).not.toContain("teamId");
  });
});
