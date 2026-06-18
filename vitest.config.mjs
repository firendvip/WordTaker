import { defineConfig } from "vitest/config";

// 说明：better-sqlite3 / uiohook-napi 是按 Electron ABI 编译的原生模块，
// 无法在纯 Node(Vitest) 下加载，因此单测聚焦无原生依赖的纯模块(如 aiService)。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{js,mjs}"],
  },
});
