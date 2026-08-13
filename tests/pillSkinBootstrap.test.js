import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("pill skin bootstrap", () => {
  it("keeps the recorder pill unrendered until its stored skin resolves", () => {
    const app = read("src/App.jsx");

    expect(app).toContain("const [pillSkin, setPillSkin] = useState(null)");
    expect(app).not.toContain("const [pillSkin, setPillSkin] = useState('music')");
    expect(app).toContain("normalizePillSkin");
    expect(app).toMatch(/return pillSkin \? \(\s*<RecorderPill/);
    expect(app).toMatch(/\) : null;/);
  });

  it("keeps music as an explicit fallback after a setting result exists", async () => {
    const helperPath = path.join(root, "src", "utils", "pillSkin.js");
    expect(fs.existsSync(helperPath)).toBe(true);
    if (!fs.existsSync(helperPath)) return;

    const { isResolvedPillSkin, normalizePillSkin } = await import(
      `${pathToFileURL(helperPath).href}?test=${Date.now()}`
    );
    for (const skin of ["music", "voiceink", "catfx", "cat"]) {
      expect(normalizePillSkin(skin)).toBe(skin);
      expect(isResolvedPillSkin(skin)).toBe(true);
    }
    expect(normalizePillSkin(undefined)).toBe("music");
    expect(normalizePillSkin("unknown")).toBe("music");
    expect(isResolvedPillSkin(null)).toBe(false);
  });
});
