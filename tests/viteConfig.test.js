import { describe, expect, it } from "vitest";

import viteConfig from "../src/vite.config.mjs";
import { getManualChunkName } from "../src/helpers/viteChunkPolicy.mjs";

describe("renderer chunk configuration", () => {
  it("uses the Vite 8-compatible manual chunk callback", () => {
    const manualChunks = viteConfig.build.rollupOptions.output.manualChunks;

    expect(manualChunks).toBe(getManualChunkName);
    expect(getManualChunkName("/app/node_modules/react/index.js")).toBe("vendor");
    expect(getManualChunkName("/app/node_modules/@radix-ui/react-dialog/dist/index.js")).toBe("ui");
    expect(getManualChunkName("/app/node_modules/clsx/dist/clsx.js")).toBe("utils");
    expect(getManualChunkName("/app/src/main.jsx")).toBeUndefined();
  });

  it("uses Vite 8's built-in minifier without an undeclared esbuild dependency", () => {
    expect(viteConfig.build.minify).toBe("oxc");
  });
});
