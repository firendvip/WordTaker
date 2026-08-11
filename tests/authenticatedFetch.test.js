import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { fetchWithAuthFallback } = require("../src/helpers/authenticatedFetch.js");

describe("AIM authentication compatibility fallback", () => {
  it("uses passport first and retries a safe GET 401 once with the legacy AIM token", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, ok: false, body: { cancel } })
      .mockResolvedValueOnce({ status: 200, ok: true });

    const result = await fetchWithAuthFallback({
      fetchFn,
      url: "https://look3.cn/aiapi/auth/me",
      options: { method: "GET", headers: { "x-device-id": "device" } },
      credentials: [
        { provider: "passport", accessToken: "passport-token" },
        { provider: "legacy", accessToken: "legacy-token" },
      ],
    });

    expect(result.provider).toBe("legacy");
    expect(result.rejectedProviders).toEqual(["passport"]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe("Bearer passport-token");
    expect(fetchFn.mock.calls[1][1].headers.Authorization).toBe("Bearer legacy-token");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("never replays a state-changing request with another credential", async () => {
    const fetchFn = vi.fn(async () => ({ status: 401, ok: false }));
    const result = await fetchWithAuthFallback({
      fetchFn,
      url: "https://look3.cn/aiapi/payment/order",
      options: { method: "POST", headers: {}, body: '{"planCode":"pro"}' },
      credentials: [
        { provider: "passport", accessToken: "passport-token" },
        { provider: "legacy", accessToken: "legacy-token" },
      ],
    });

    expect(result.provider).toBe("passport");
    expect(result.rejectedProviders).toEqual(["passport"]);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("never retries non-authentication errors or more than one legacy fallback", async () => {
    const forbidden = vi.fn(async () => ({ status: 403, ok: false }));
    await fetchWithAuthFallback({
      fetchFn: forbidden,
      url: "https://look3.cn/aiapi/quota",
      options: { headers: {} },
      credentials: [
        { provider: "passport", accessToken: "passport-token" },
        { provider: "legacy", accessToken: "legacy-token" },
      ],
    });
    expect(forbidden).toHaveBeenCalledOnce();

    const unauthorized = vi.fn(async () => ({ status: 401, ok: false }));
    const exhausted = await fetchWithAuthFallback({
      fetchFn: unauthorized,
      url: "https://look3.cn/aiapi/quota",
      options: { headers: {} },
      credentials: [
        { provider: "passport", accessToken: "passport-token" },
        { provider: "legacy", accessToken: "legacy-token" },
        { provider: "legacy", accessToken: "unexpected-third-token" },
      ],
    });
    expect(unauthorized).toHaveBeenCalledTimes(2);
    expect(exhausted.rejectedProviders).toEqual(["passport", "legacy"]);
  });

  it("omits Authorization entirely for anonymous requests", async () => {
    const fetchFn = vi.fn(async () => ({ status: 200, ok: true }));
    const result = await fetchWithAuthFallback({
      fetchFn,
      url: "https://look3.cn/aiapi/quota",
      options: { headers: { Accept: "application/json" } },
      credentials: [],
    });
    expect(result.provider).toBeNull();
    expect(result.rejectedProviders).toEqual([]);
    expect(fetchFn.mock.calls[0][1].headers).toEqual({ Accept: "application/json" });
  });

  it("rejects a missing fetch boundary and ignores malformed credentials", async () => {
    await expect(fetchWithAuthFallback({ url: "https://look3.cn/aiapi/quota" })).rejects.toThrow(
      /fetchFn/,
    );
    const fetchFn = vi.fn(async () => ({ status: 200, ok: true }));
    const result = await fetchWithAuthFallback({
      fetchFn,
      url: "https://look3.cn/aiapi/quota",
      credentials: [
        null,
        { provider: "unknown", accessToken: "long-enough-token" },
        { provider: "passport", accessToken: "short" },
        { provider: "passport", accessToken: "bad token value" },
      ],
    });
    expect(result.provider).toBeNull();
    expect(fetchFn.mock.calls[0][1].headers).toEqual({});
  });

  it("does not let response-body cleanup failure block the one safe retry", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        status: 401,
        body: { cancel: vi.fn(async () => { throw new Error("cancel failed"); }) },
      })
      .mockResolvedValueOnce({ status: 200 });
    await expect(
      fetchWithAuthFallback({
        fetchFn,
        url: "https://look3.cn/aiapi/quota",
        credentials: [
          { provider: "passport", accessToken: "passport-token" },
          { provider: "legacy", accessToken: "legacy-token" },
        ],
      }),
    ).resolves.toMatchObject({ provider: "legacy", response: { status: 200 } });
  });
});
