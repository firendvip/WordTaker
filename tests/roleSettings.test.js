import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import AiService from "../src/helpers/aiService.js";

const source = fs.readFileSync(new URL("../src/helpers/database.js", import.meta.url), "utf8");
const logger = { info() {}, warn() {}, error() {} };

function makeDatabase(role) {
  const values = new Map(Object.entries({
    _migrate_force_skin_sound_v126: "1",
    _migrate_pill_follow_focus_off_v1: "1",
    ...(role === undefined ? {} : { llm_active_role: role }),
  }).map(([key, value]) => [key, JSON.stringify(value)]));
  const context = {
    module: { exports: {} },
    process,
    require: (name) => {
      if (name === "better-sqlite3") return class {};
      if (name === "path") return path;
      if (name === "fs") return fs;
      if (name === "crypto") return crypto;
      if (name === "electron") return { safeStorage: {} };
      if (name === "./relayConfig") return {};
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(source, context);
  const database = new context.module.exports(logger);
  database.db = {
    prepare: (sql) => {
      if (sql.includes("SELECT 1 FROM settings")) return { get: (key) => values.has(key) && { exists: 1 } };
      if (sql.includes("SELECT value FROM settings")) return { get: (key) => values.has(key) && { value: values.get(key) } };
      if (sql.includes("SELECT key, value FROM settings")) return { all: () => [...values].map(([key, value]) => ({ key, value })) };
      if (sql.includes("INSERT OR REPLACE INTO settings")) return { run: (key, value) => { values.set(key, value); return { changes: 1 }; } };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  return { database, values };
}

describe("available desktop roles", () => {
  it("persists the hidden legacy role as normal before any settings window is opened", () => {
    const { database, values } = makeDatabase("gaoeq");
    database.seedDefaultSettings();
    expect(database.getSetting("llm_active_role")).toBe("normal");
    expect(database.getAllSettings().llm_active_role).toBe("normal");
    expect(JSON.parse(values.get("llm_active_role"))).toBe("normal");
    database.seedDefaultSettings();
    expect(database.getSetting("llm_active_role")).toBe("normal");
  });

  it("normalizes attempts to restore the hidden role without changing other settings", () => {
    const { database } = makeDatabase("vibecoding");
    expect(database.setSetting("llm_active_role", "gaoeq").success).toBe(true);
    expect(database.getSetting("llm_active_role")).toBe("normal");
    database.setSetting("llm_prompt_template", "existing template");
    expect(database.getSetting("llm_prompt_template")).toBe("existing template");
  });

  it.each([undefined, "normal", "vibecoding"])("preserves the default and available role %s", (role) => {
    const { database } = makeDatabase(role);
    database.seedDefaultSettings();
    expect(database.getSetting("llm_active_role")).toBe(role || "normal");
  });

  it.each([
    ["normal", "normal"],
    ["vibecoding", "copywriting"],
    ["gaoeq", "normal"],
  ])("routes saved %s to %s for cloud, local, and streaming requests", async (role, mode) => {
    const { database } = makeDatabase(role);
    database.seedDefaultSettings();
    const llmManager = { polish: vi.fn(async () => ({ success: true, text: "处理后的内容" })) };
    const service = new AiService({ databaseManager: database, logger, llmManager });
    const cloud = vi.spyOn(service, "processTextViaCloud").mockResolvedValue({ success: true, text: "处理后的内容" });
    const cloudStream = vi.spyOn(service, "processTextViaRelayStream").mockResolvedValue({ success: true, text: "处理后的内容" });
    vi.spyOn(service, "_resolveCloudDegrade").mockResolvedValue({ action: "cloud" });
    const text = "这是超过六个字的待处理内容";
    const onDelta = vi.fn();

    expect(await service.getPolishMode()).toBe(mode);
    await service.processTextWithAI(text, await service.getPolishMode());
    expect(cloud).toHaveBeenCalledWith(text, mode);
    await service.processTextStreamRouted(text, await service.getPolishMode(), "https://relay.invalid", onDelta);
    expect(cloudStream).toHaveBeenCalledWith(text, mode, "https://relay.invalid", onDelta);

    database.setSetting("polish_engine", "local-4b");
    await service.processTextWithAI(text, await service.getPolishMode());
    expect(llmManager.polish).toHaveBeenCalledWith("local-4b", text, mode, null);
    await service.processTextStreamRouted(text, await service.getPolishMode(), "", onDelta);
    expect(llmManager.polish).toHaveBeenCalledWith("local-4b", text, mode, onDelta);
  });
});
