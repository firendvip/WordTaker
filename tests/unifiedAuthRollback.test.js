import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const read = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), "utf8");

const collectSourceFiles = (relativeDir) => {
  const absoluteDir = path.join(rootDir, relativeDir);

  return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(relativePath);
    return /\.(?:c?js|jsx|json)$/.test(entry.name) ? [relativePath] : [];
  });
};

describe("paused unified authentication", () => {
  it("does not ship Passport, OIDC, PKCE, or desktop callback integration", () => {
    const productionFiles = [
      "main.js",
      "preload.js",
      "package.json",
      ...collectSourceFiles("src/components/account"),
      ...collectSourceFiles("src/helpers"),
    ];
    const productionSource = productionFiles.map(read).join("\n");

    expect(productionSource).not.toMatch(
      /auth\.yaa3\.com|wangsan-wordtaker|wordtakerPassport|passport|oidc|\bPKCE\b|\bBFF\b/i,
    );
  });

  it("does not retain candidate-only build configuration or Passport modules", () => {
    const removedPaths = [
      "electron-builder.passport-candidate.cjs",
      "src/components/account/PassportLoginEntry.jsx",
      "src/helpers/passportAimMapper.js",
      "src/helpers/passportAuthManager.js",
      "src/helpers/passportCapability.js",
      "src/helpers/passportDesktopPolicy.js",
      "src/helpers/passportEntryIpc.js",
      "src/helpers/passportOidc.js",
    ];

    expect(removedPaths.filter((relativePath) => fs.existsSync(path.join(rootDir, relativePath)))).toEqual([]);
  });
});
