import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const configPath = require.resolve("../src/helpers/backendConfig.js");
const originalBackendUrl = process.env.AI_BACKEND_URL;
const originalApiPrefix = process.env.AI_API_PREFIX;

function loadBackendConfig() {
  delete require.cache[configPath];
  return require(configPath);
}

afterEach(() => {
  if (originalBackendUrl === undefined) {
    delete process.env.AI_BACKEND_URL;
  } else {
    process.env.AI_BACKEND_URL = originalBackendUrl;
  }
  if (originalApiPrefix === undefined) {
    delete process.env.AI_API_PREFIX;
  } else {
    process.env.AI_API_PREFIX = originalApiPrefix;
  }
  delete require.cache[configPath];
});

describe("backend configuration", () => {
  it("uses the production backend by default in an unpackaged development run", () => {
    delete process.env.AI_BACKEND_URL;
    delete process.env.AI_API_PREFIX;

    const config = loadBackendConfig();

    expect(config.AI_BACKEND_URL).toBe("https://look3.cn");
    expect(config.API_PREFIX).toBe("/aiapi");
  });

  it("allows explicit local backend overrides for backend development", () => {
    process.env.AI_BACKEND_URL = "http://localhost:3777";
    process.env.AI_API_PREFIX = "/api/v1";

    const config = loadBackendConfig();

    expect(config.AI_BACKEND_URL).toBe("http://localhost:3777");
    expect(config.API_PREFIX).toBe("/api/v1");
  });
});
