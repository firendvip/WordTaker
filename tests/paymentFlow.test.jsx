// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlansCard } from "../src/components/account/PlansCard";
import { PayQrModal } from "../src/components/account/PayQrModal";

const mocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), qr: vi.fn(), frameError: null }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error, info: mocks.info } }));
vi.mock("qrcode", () => ({ default: { toDataURL: mocks.qr } }));
// jsdom 不加载收银台网络页面；保留真实弹窗，只捕获网络失败回调边界。
vi.mock("../src/components/account/PayQrModal", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, PayQrModal: props => {
    mocks.frameError = props.onFrameError;
    return <actual.PayQrModal {...props} />;
  } };
});
const plan = { code: "pkg_small", name: "小包", priceCents: 900, charAmount: 150000, validityDays: 365, type: "char_package" };
const order = { orderId: "17", channel: "wechat", planCode: plan.code, priceCents: 900, payload: { mock: false, codeUrl: "weixin://wxpay/bizpayurl?pr=test", expiresAt: "2099-01-01T00:00:00Z" } };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const settleCreate = (pending, outcome) => {
  if (outcome === "rejection") pending.reject(new Error("offline"));
  else pending.resolve(outcome === "success" ? { success: true, order } : { success: false, error: "下单失败" });
};

describe("real payment checkout", () => {
  let root, container, api, purchased;
  const button = label => [...document.querySelectorAll("button")].find(el => el.textContent.includes(label));
  const click = async label => act(async () => { button(label).click(); });
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.qr.mockResolvedValue("data:image/png;base64,dGVzdA==");
    api = {
      listPlans: vi.fn().mockResolvedValue({ success: true, plans: [plan] }),
      createOrder: vi.fn().mockResolvedValue({ success: true, order }),
      getPaymentOrder: vi.fn().mockResolvedValue({ success: true, order: { orderId: "17", channel: "wechat", payStatus: "pending" } }),
      getCloudQuota: vi.fn().mockResolvedValue({ success: true, cloudRemaining: 999999 }),
      mockPay: vi.fn(), openExternal: vi.fn(),
    };
    purchased = vi.fn();
    container = document.createElement("div"); document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<PlansCard api={api} isLoggedIn onPurchased={purchased} />));
  });
  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container.remove();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT; vi.useRealTimers();
  });
  it("offers WeChat and renders the gateway codeUrl locally without opening a browser", async () => {
    await click("微信支付");
    expect(api.createOrder).toHaveBeenCalledWith("pkg_small", "wechat");
    expect(mocks.qr).toHaveBeenCalledWith(order.payload.codeUrl, expect.any(Object));
    expect(document.body.textContent).toContain("微信扫码支付");
    expect(document.querySelector('img[alt="微信付款二维码"]')).not.toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.body.textContent).not.toContain("在浏览器中打开");
    expect(api.mockPay).not.toHaveBeenCalled();
  });
  it("does not infer payment from unrelated quota changes", async () => {
    await click("微信支付");
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.getPaymentOrder).toHaveBeenCalledWith("17");
    expect(api.getCloudQuota).not.toHaveBeenCalled();
    expect(purchased).not.toHaveBeenCalled();
  });
  it("marks paid only for this server-confirmed order and refreshes once", async () => {
    await click("微信支付");
    api.getPaymentOrder.mockResolvedValue({ success: true, order: { orderId: "17", channel: "wechat", payStatus: "paid" } });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(document.body.textContent).toContain("支付成功，已到账");
    expect(purchased).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(purchased).toHaveBeenCalledOnce();
  });
  it("rejects a status response for a different order", async () => {
    await click("微信支付");
    api.getPaymentOrder.mockResolvedValue({ success: true, order: { orderId: "18", channel: "wechat", payStatus: "paid" } });
    await click("我已完成支付");
    expect(purchased).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });
  it("does not run mockPay when real payment data is missing", async () => {
    api.createOrder.mockResolvedValue({ success: true, order: { orderId: "17", payload: { mock: true } } });
    await click("微信支付");
    expect(api.mockPay).not.toHaveBeenCalled();
    expect(purchased).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalled();
  });
  it("keeps the existing Alipay QR and browser fallback", async () => {
    await click("支付宝");
    api.createOrder.mockResolvedValue({ success: true, order: { ...order, channel: "alipay", payload: { mock: false, wapPayUrl: "https://openapi.alipay.com/gateway.do?test", payUrl: "https://openapi.alipay.com/gateway.do?page" } } });
    await click("支付宝支付");
    expect(document.body.textContent).toContain("支付宝扫码支付");
    await click("在浏览器中打开");
    expect(api.openExternal).toHaveBeenCalledWith("https://openapi.alipay.com/gateway.do?page");
  });
  it("ignores an outstanding status response after cancellation", async () => {
    let resolve;
    api.getPaymentOrder.mockImplementation(() => new Promise(r => { resolve = r; }));
    await click("微信支付");
    await act(async () => { vi.advanceTimersByTime(5000); });
    await click("取消");
    await act(async () => resolve({ success: true, order: { orderId: "17", channel: "wechat", payStatus: "paid" } }));
    expect(purchased).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["success", "failure", "rejection"])("ignores a late create %s after unmount without restarting polling or notifying", async outcome => {
    const pending = deferred();
    api.createOrder.mockReturnValue(pending.promise);
    api.getPaymentOrder.mockResolvedValue({ success: true, order: { orderId: "17", channel: "wechat", payStatus: "paid" } });
    await click("微信支付");
    await act(async () => root.unmount());
    root = null;
    await act(async () => settleCreate(pending, outcome));
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(api.getPaymentOrder).not.toHaveBeenCalled();
    expect(document.querySelector('img[alt="微信付款二维码"]')).toBeNull();
    expect(mocks.qr).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(purchased).not.toHaveBeenCalled();
  });
  it.each(["success", "failure", "rejection"])("ignores a late create %s after logout and clears checkout state", async outcome => {
    const pending = deferred();
    api.createOrder.mockReturnValue(pending.promise);
    await click("微信支付");
    await act(async () => root.render(<PlansCard api={api} isLoggedIn={false} onPurchased={purchased} />));
    await act(async () => settleCreate(pending, outcome));
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(vi.getTimerCount()).toBe(0);
    expect(api.getPaymentOrder).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("微信扫码支付");
    expect(button("微信支付").disabled).toBe(false);
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(purchased).not.toHaveBeenCalled();
  });
  it.each(["success", "rejection"])("does not let an old session's create %s overwrite or unlock a newer checkout", async outcome => {
    const oldCreate = deferred(), newCreate = deferred();
    const newOrder = { ...order, orderId: "18", payload: { ...order.payload, codeUrl: "weixin://wxpay/bizpayurl?pr=new-session" } };
    const refreshed = vi.fn();
    api.createOrder.mockReturnValueOnce(oldCreate.promise).mockReturnValueOnce(newCreate.promise);
    await click("微信支付");
    await act(async () => root.render(<PlansCard api={api} isLoggedIn={false} onPurchased={purchased} />));
    await act(async () => root.render(<PlansCard api={api} isLoggedIn onPurchased={refreshed} />));
    await click("微信支付");
    expect(api.createOrder).toHaveBeenCalledTimes(2);
    await act(async () => settleCreate(oldCreate, outcome));
    expect(button("微信支付").disabled).toBe(true);
    await click("微信支付");
    expect(api.createOrder).toHaveBeenCalledTimes(2);
    expect(mocks.qr).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
    await act(async () => newCreate.resolve({ success: true, order: newOrder }));
    expect(mocks.qr).toHaveBeenCalledWith(newOrder.payload.codeUrl, expect.any(Object));
    api.getPaymentOrder.mockResolvedValue({ success: true, order: { orderId: "18", channel: "wechat", payStatus: "paid" } });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.getPaymentOrder).toHaveBeenCalledWith("18");
    expect(refreshed).toHaveBeenCalledOnce();
    expect(purchased).not.toHaveBeenCalled();
  });
  it("ignores the old API's pending create when the checkout bridge is replaced", async () => {
    const pending = deferred();
    api.createOrder.mockReturnValue(pending.promise);
    await click("微信支付");
    const replacement = { ...api, createOrder: vi.fn().mockResolvedValue({ success: true, order: { ...order, orderId: "18" } }) };
    await act(async () => root.render(<PlansCard api={replacement} isLoggedIn onPurchased={purchased} />));
    await act(async () => pending.resolve({ success: true, order }));
    expect(mocks.qr).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await click("微信支付");
    expect(replacement.createOrder).toHaveBeenCalledOnce();
  });
  it("ignores a pending paid response after logout", async () => {
    const pending = deferred();
    api.getPaymentOrder.mockReturnValue(pending.promise);
    await click("微信支付");
    await act(async () => { vi.advanceTimersByTime(5000); });
    await act(async () => root.render(<PlansCard api={api} isLoggedIn={false} onPurchased={purchased} />));
    await act(async () => pending.resolve({ success: true, order: { orderId: "17", channel: "wechat", payStatus: "paid" } }));
    expect(vi.getTimerCount()).toBe(0);
    expect(document.body.textContent).not.toContain("微信扫码支付");
    expect(mocks.success).not.toHaveBeenCalled();
    expect(purchased).not.toHaveBeenCalled();
  });
  it("does not let a cancelled order's late response complete a new checkout", async () => {
    const pending = deferred();
    api.getPaymentOrder.mockReturnValueOnce(pending.promise);
    await click("微信支付");
    await act(async () => { vi.advanceTimersByTime(5000); });
    await click("取消");
    api.createOrder.mockResolvedValue({ success: true, order: { ...order, orderId: "18" } });
    await click("微信支付");
    await act(async () => pending.resolve({ success: true, order: { orderId: "17", channel: "wechat", payStatus: "paid" } }));
    expect(purchased).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    api.getPaymentOrder.mockResolvedValue({ success: true, order: { orderId: "18", channel: "wechat", payStatus: "paid" } });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.getPaymentOrder).toHaveBeenLastCalledWith("18");
    expect(purchased).toHaveBeenCalledOnce();
  });
  it("isolates in-flight manual checks across cancelled and new checkouts", async () => {
    const oldCheck = deferred(), newCheck = deferred();
    api.getPaymentOrder.mockReturnValueOnce(oldCheck.promise).mockReturnValueOnce(newCheck.promise);
    await click("微信支付");
    await click("我已完成支付");
    await click("取消");
    api.createOrder.mockResolvedValue({ success: true, order: { ...order, orderId: "18" } });
    await click("微信支付");
    await click("我已完成支付");
    expect(api.getPaymentOrder).toHaveBeenCalledTimes(2);
    await act(async () => oldCheck.resolve({ success: true, order: { orderId: "17", channel: "wechat", payStatus: "paid" } }));
    expect(button("我已完成支付").disabled).toBe(true);
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.getPaymentOrder).toHaveBeenCalledTimes(2);
    await act(async () => newCheck.resolve({ success: true, order: { orderId: "18", channel: "wechat", payStatus: "paid" } }));
    expect(purchased).toHaveBeenCalledOnce();
  });
  it("does not schedule a delayed modal update when purchase refresh unmounts the card", async () => {
    const refreshAndClose = vi.fn(() => { root.unmount(); root = null; });
    await act(async () => root.render(<PlansCard api={api} isLoggedIn onPurchased={refreshAndClose} />));
    await click("微信支付");
    api.getPaymentOrder.mockResolvedValue({ success: true, order: { orderId: "17", channel: "wechat", payStatus: "paid" } });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(refreshAndClose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["wechat", "alipay"])("keeps normal %s checkout working after StrictMode setup and cleanup", async channel => {
    await act(async () => root.render(<React.StrictMode><PlansCard api={api} isLoggedIn onPurchased={purchased} /></React.StrictMode>));
    if (channel === "alipay") {
      await click("支付宝");
      api.createOrder.mockResolvedValue({ success: true, order: { ...order, channel, payload: { wapPayUrl: "https://openapi.alipay.com/gateway.do?test" } } });
    }
    await click(channel === "wechat" ? "微信支付" : "支付宝支付");
    api.getPaymentOrder.mockResolvedValue({ success: true, order: { orderId: "17", channel, payStatus: "paid" } });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(purchased).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(purchased).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("shows QR generation failure instead of loading forever", async () => {
    mocks.qr.mockRejectedValue(new Error("QR failed"));
    await click("微信支付");
    expect(document.querySelector('[role="alert"]').textContent).toContain("二维码生成失败");
  });
  it("hides an expired QR without claiming success", async () => {
    await act(async () => root.render(<PayQrModal channel="wechat" codeUrl={order.payload.codeUrl} expiresAt="2000-01-01T00:00:00Z" amountYuan="9.00" onCancel={() => {}} />));
    expect(document.body.textContent).toContain("二维码已过期");
    expect(document.querySelector("img")).toBeNull();
    expect(mocks.success).not.toHaveBeenCalled();
  });
  it("requires login before creating a payment", async () => {
    const login = vi.fn();
    await act(async () => root.render(<PlansCard api={api} isLoggedIn={false} onLoginRequest={login} />));
    await click("微信支付");
    expect(login).toHaveBeenCalledOnce();
    expect(api.createOrder).not.toHaveBeenCalled();
  });
  it("retries a failed plan load without selling free plans", async () => {
    api.listPlans.mockResolvedValueOnce({ success: false, error: "加载失败" }).mockResolvedValueOnce({ success: true, plans: [plan, { ...plan, code: "free", priceCents: 0, type: "one_time_grant" }] });
    await act(async () => root.render(<PlansCard api={{ ...api }} isLoggedIn />));
    expect(document.body.textContent).toContain("加载失败");
    await click("重试");
    expect([...document.querySelectorAll("button")].filter(el => el.textContent.includes("微信支付"))).toHaveLength(1);
  });
  it.each([
    { success: false, error: "下单失败" },
    { success: true, order: { ...order, priceCents: 1900 } },
    { success: true, order: { ...order, payload: {} } },
  ])("does not display an unusable or changed checkout", async response => {
    api.createOrder.mockResolvedValue(response);
    await click("微信支付");
    expect(document.querySelector("img")).toBeNull();
    expect(mocks.error).toHaveBeenCalled();
  });
  it("handles order network errors without fake success", async () => {
    api.createOrder.mockRejectedValue(new Error("network"));
    await click("微信支付");
    expect(mocks.error).toHaveBeenCalledWith("购买失败，请检查网络后重试");
    expect(purchased).not.toHaveBeenCalled();
  });
  it("requires a client order-verification bridge before checkout", async () => {
    delete api.getPaymentOrder;
    await click("微信支付");
    expect(api.createOrder).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith("当前版本不支持订单查验，请更新应用");
  });
  it("keeps payment pending when order verification is temporarily offline", async () => {
    await click("微信支付");
    api.getPaymentOrder.mockRejectedValue(new Error("offline"));
    await click("我已完成支付");
    expect(purchased).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith("暂未检测到到账，付款成功后请稍等片刻再点一次");
  });
  it("stops polling ended orders and never claims payment", async () => {
    await click("微信支付");
    api.getPaymentOrder.mockResolvedValue({ success: true, order: { orderId: "17", channel: "wechat", payStatus: "failed" } });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(mocks.info).toHaveBeenCalledWith("此订单已结束，请关闭窗口后重新下单");
    expect(purchased).not.toHaveBeenCalled();
  });
  it("keeps manual order confirmation after automatic polling times out", async () => {
    await click("微信支付");
    await act(async () => vi.advanceTimersByTimeAsync(905000));
    const polls = api.getPaymentOrder.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(api.getPaymentOrder).toHaveBeenCalledTimes(polls);
    await click("我已完成支付");
    expect(api.getPaymentOrder).toHaveBeenCalledTimes(polls + 1);
    expect(mocks.info).toHaveBeenCalledWith("暂未检测到到账，付款成功后请稍等片刻再点一次");
  });
  it("preserves Alipay iframe and manual browser fallback when no mobile URL is provided", async () => {
    await click("支付宝");
    api.createOrder.mockResolvedValue({ success: true, order: { ...order, channel: "alipay", payload: { payUrl: "https://openapi.alipay.com/gateway.do?test" } } });
    await click("支付宝支付");
    const frame = document.querySelector("iframe");
    expect(frame.getAttribute("src")).toBe("https://openapi.alipay.com/gateway.do?test");
    await act(async () => frame.dispatchEvent(new Event("load")));
    await click("在浏览器中打开");
    expect(api.openExternal).toHaveBeenCalledOnce();
    await click("取消");
    expect(document.querySelector("iframe")).toBeNull();
  });
  it("ignores a browser-open rejection after the Alipay checkout is cancelled", async () => {
    const pending = deferred();
    api.openExternal.mockReturnValue(pending.promise);
    await click("支付宝");
    api.createOrder.mockResolvedValue({ success: true, order: { ...order, channel: "alipay", payload: { wapPayUrl: "https://openapi.alipay.com/gateway.do?test" } } });
    await click("支付宝支付");
    await click("在浏览器中打开");
    await click("取消");
    await act(async () => pending.reject(new Error("cancelled")));
    expect(mocks.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["success", "rejection"])("ignores a late Alipay iframe fallback %s after logout", async outcome => {
    const pending = deferred();
    api.openExternal.mockReturnValue(pending.promise);
    await click("支付宝");
    api.createOrder.mockResolvedValue({ success: true, order: { ...order, channel: "alipay", payload: { payUrl: "https://openapi.alipay.com/gateway.do?test" } } });
    await click("支付宝支付");
    await act(async () => { mocks.frameError(); });
    expect(api.openExternal).toHaveBeenCalledOnce();
    await act(async () => root.render(<PlansCard api={api} isLoggedIn={false} onPurchased={purchased} />));
    await act(async () => outcome === "success" ? pending.resolve() : pending.reject(new Error("offline")));
    expect(document.body.textContent).not.toContain("等待支付：");
    expect(mocks.error).not.toHaveBeenCalled();
    expect(purchased).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("invalidates the old order when a new checkout starts during pending Alipay fallback", async () => {
    const browserOpen = deferred(), newCreate = deferred();
    const alipayOrder = { ...order, channel: "alipay", payload: { payUrl: "https://openapi.alipay.com/gateway.do?test" } };
    api.openExternal.mockReturnValue(browserOpen.promise);
    api.createOrder.mockResolvedValueOnce({ success: true, order: alipayOrder }).mockReturnValueOnce(newCreate.promise);
    api.getPaymentOrder.mockResolvedValue({ success: true, order: { orderId: "17", channel: "alipay", payStatus: "paid" } });
    await click("支付宝");
    await click("支付宝支付");
    await act(async () => { mocks.frameError(); });
    await click("支付宝支付");
    expect(api.createOrder).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.getPaymentOrder).not.toHaveBeenCalled();
    expect(purchased).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    await act(async () => browserOpen.resolve());
    expect(document.body.textContent).not.toContain("等待支付：");
    await act(async () => newCreate.resolve({ success: true, order: { ...alipayOrder, orderId: "18" } }));
    api.getPaymentOrder.mockResolvedValue({ success: true, order: { orderId: "18", channel: "alipay", payStatus: "paid" } });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.getPaymentOrder).toHaveBeenCalledWith("18");
    expect(purchased).toHaveBeenCalledOnce();
  });
});
