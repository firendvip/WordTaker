import { describe, it, expect, vi } from "vitest";
import AiService from "../src/helpers/aiService.js";

const logger = { info() {}, warn() {}, error() {} };
const makeDB = (settings) => ({
  getSetting: async (k, d) => (k in settings ? settings[k] : d),
});

describe("AiService.processTextWithAI", () => {
  it("未配置中转且无 API key 时返回错误", async () => {
    const svc = new AiService({
      databaseManager: makeDB({ llm_relay_enabled: false, ai_api_key: "" }),
      logger,
    });
    const r = await svc.processTextWithAI("你好", "copywriting");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/密钥|API/);
  });

  it("启用中转时只发送 {text, mode} 并带访问令牌头", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, text: "润色后的文本" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new AiService({
      databaseManager: makeDB({
        llm_relay_enabled: true,
        llm_relay_url: "https://relay.test",
        llm_relay_token: "tok",
        device_id: "dev-1",
      }),
      logger,
    });
    const r = await svc.processTextWithAI("那个我觉得不错", "copywriting");

    expect(r).toEqual({ success: true, text: "润色后的文本" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://relay.test");
    expect(opts.method).toBe("POST");
    expect(opts.headers["X-App-Token"]).toBe("tok");
    expect(opts.headers["X-Device-Id"]).toBe("dev-1");
    // 只发待润色文本，不转发任意 messages
    expect(JSON.parse(opts.body)).toEqual({ text: "那个我觉得不错", mode: "copywriting" });

    vi.unstubAllGlobals();
  });

  it("中转返回非 success 时报错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ success: false, error: "boom" }) })));
    const svc = new AiService({
      databaseManager: makeDB({ llm_relay_enabled: true, llm_relay_url: "https://relay.test" }),
      logger,
    });
    const r = await svc.processTextWithAI("hi", "copywriting");
    expect(r.success).toBe(false);
    vi.unstubAllGlobals();
  });
});
