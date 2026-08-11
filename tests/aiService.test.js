import { describe, it, expect, vi } from "vitest";
import AiService from "../src/helpers/aiService.js";

const logger = { info() {}, warn() {}, error() {} };
const makeDB = (settings) => ({
  getSetting: async (k, d) => (k in settings ? settings[k] : d),
});

describe("AiService.processTextWithAI", () => {
  it("6 字及以下直接返回原文，不读取模型设置或调用模型", async () => {
    const getSetting = vi.fn();
    const fetchMock = vi.fn();
    const llmManager = { polish: vi.fn() };
    vi.stubGlobal("fetch", fetchMock);
    const svc = new AiService({
      databaseManager: { getSetting },
      logger,
      llmManager,
    });

    const r = await svc.processTextWithAI("嗯那个", "copywriting");

    expect(r).toEqual({
      success: true,
      text: "嗯那个",
      engine: "passthrough",
    });
    expect(getSetting).not.toHaveBeenCalled();
    expect(llmManager.polish).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("6 字及以下的流式请求同样原文直出，不调用模型", async () => {
    const getSetting = vi.fn();
    const onDelta = vi.fn();
    const llmManager = { polish: vi.fn() };
    const svc = new AiService({
      databaseManager: { getSetting },
      logger,
      llmManager,
    });

    const r = await svc.processTextStreamRouted("一二三四五六", "normal", "", onDelta);

    expect(r).toEqual({
      success: true,
      text: "一二三四五六",
      engine: "passthrough",
    });
    expect(onDelta).toHaveBeenCalledOnce();
    expect(onDelta).toHaveBeenCalledWith("一二三四五六");
    expect(getSetting).not.toHaveBeenCalled();
    expect(llmManager.polish).not.toHaveBeenCalled();
  });

  it("转英文不受短文本绕过规则影响", async () => {
    const llmManager = {
      polish: vi.fn(async () => ({ success: true, text: "hello" })),
    };
    const svc = new AiService({
      databaseManager: makeDB({ polish_engine: "local-4b" }),
      logger,
      llmManager,
    });

    const r = await svc.processTextWithAI("你好", "translate-en");

    expect(r).toEqual({ success: true, text: "hello", engine: "local-4b" });
    expect(llmManager.polish).toHaveBeenCalledWith("local-4b", "你好", "translate-en", null);
  });

  it("云端不可用且未配置中转时返回明确错误", async () => {
    const svc = new AiService({
      databaseManager: makeDB({ polish_engine: "cloud", llm_relay_enabled: false, ai_api_key: "" }),
      logger,
    });
    const r = await svc.processViaRelayFallback(
      "这是一条超过六字的文本",
      "copywriting",
      "云端不可用",
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/云端服务暂不可用/);
  });

  it("启用中转时只发送 {text, mode} 并带访问令牌头", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, text: "润色后的文本" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const svc = new AiService({
      databaseManager: makeDB({
        polish_engine: "cloud",
        llm_relay_enabled: true,
        llm_relay_url: "https://relay.test",
        llm_relay_token: "tok",
        device_id: "dev-1",
      }),
      logger,
    });
    const r = await svc.processTextViaRelay(
      "那个我觉得不错",
      "copywriting",
      "https://relay.test",
    );

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
      databaseManager: makeDB({ polish_engine: "cloud", llm_relay_enabled: true, llm_relay_url: "https://relay.test" }),
      logger,
    });
    const r = await svc.processTextWithAI("this is longer than six", "copywriting");
    expect(r.success).toBe(false);
    vi.unstubAllGlobals();
  });

  it("本地引擎经 llmManager.polish，不走中转（无兜底）", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const llmManager = {
      polish: vi.fn(async () => ({ success: true, text: "本地润色结果" })),
    };
    const svc = new AiService({
      databaseManager: makeDB({ polish_engine: "local-4b" }),
      logger,
      llmManager,
    });
    const r = await svc.processTextWithAI("那个我我觉得可以", "copywriting");
    expect(r).toEqual({ success: true, text: "本地润色结果", engine: "local-4b" });
    expect(llmManager.polish).toHaveBeenCalledWith("local-4b", "那个我我觉得可以", "copywriting", null);
    // 无兜底：绝不因本地成功/失败而回退到中转
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("本地引擎失败时直接返回错误，绝不回退中转", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const llmManager = {
      polish: vi.fn(async () => ({ success: false, error: "模型未就绪" })),
    };
    const svc = new AiService({
      databaseManager: makeDB({ polish_engine: "local-4b", llm_relay_enabled: true, llm_relay_url: "https://relay.test" }),
      logger,
      llmManager,
    });
    const r = await svc.processTextWithAI("this is longer than six", "copywriting");
    expect(r.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
