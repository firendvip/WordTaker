import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/desktopReleaseContract.test.js",
      "tests/electronRuntimeSmoke.test.js",
      "tests/signedArtifactGate.test.js",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "scripts/verify-desktop-release.js",
        "scripts/electron-runtime-smoke.js",
        "scripts/signed-artifact-gate.js",
      ],
      thresholds: {
        perFile: true,
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
