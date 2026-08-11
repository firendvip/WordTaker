import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/passportOidc.test.js",
      "tests/tokenStore.test.js",
      "tests/authenticatedFetch.test.js",
      "tests/passportAuthManager.test.js",
      "tests/passportDesktopIntegration.test.js",
      "tests/passportDesktopPolicy.test.js",
      "tests/authFailureCoordinator.test.js",
      "tests/passportAimMapper.test.js",
      "tests/backendClientAuth.test.js",
    ],
    coverage: {
      provider: "v8",
      include: [
        "src/helpers/passportOidc.js",
        "src/helpers/tokenStore.js",
        "src/helpers/authenticatedFetch.js",
        "src/helpers/passportAuthManager.js",
        "src/helpers/passportDesktopPolicy.js",
        "src/helpers/authFailureCoordinator.js",
        "src/helpers/passportAimMapper.js",
        "src/helpers/backendClient.js",
      ],
      reporter: ["text", "json-summary"],
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
