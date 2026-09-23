import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/electronBuilderConfig.test.js",
      "tests/unifiedAuthRollback.test.js",
      "tests/viteConfig.test.js",
    ],
    coverage: {
      provider: "v8",
      include: ["src/helpers/viteChunkPolicy.mjs"],
      reporter: ["text"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
