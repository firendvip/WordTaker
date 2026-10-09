import React, { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { Loader2, ShoppingCart, QrCode } from "lucide-react";
import { centsToYuan, formatChars } from "./format";
import { PayQrModal } from "./PayQrModal";

// 微信 Native 与支付宝均使用真实订单; 不提供客户端模拟付款入口。
const CHANNELS = [
  { id: "wechat", label: "微信" },
  { id: "alipay", label: "支付宝" },
];

// 自动查本次订单：每 5s 一次，最多 15 分钟; 超时仍可手动查单。
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_TICKS = 180;

// 套餐权益一行文案（后端现只售字数包：charAmount + validityDays）
function planBenefit(p) {
  if (p.charAmount == null) return "";
  const dur = durationCN(p.validityDays ?? p.durationDays);
  return `字数包 · ${charsCN(p.charAmount)} 字${dur ? ` · 有效期${dur}` : ""}`;
}

// 字数以「万」为单位的中文友好展示（100000 → "10万"），不整万时退回千分位
function charsCN(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v >= 10000 && v % 10000 === 0) return `${v / 10000}万`;
  return formatChars(v);
}

// 有效期友好文案（365→"1年"，28~31→"1个月"，其余→"N天"）
function durationCN(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return "";
  if (d >= 365) return `${Math.round(d / 365)}年`;
  if (d >= 28 && d <= 31) return "1个月";
  return `${d}天`;
}

// 支付弹窗副标题：写清哪一档字数包（从 Plan 数据拼，不写死）
function payDesc(p) {
  if (!p) return "";
  const dur = durationCN(p.validityDays ?? p.durationDays);
  const chars = p.charAmount != null ? `云端${charsCN(p.charAmount)}字` : "";
  const inner = [chars, dur ? `有效期${dur}` : ""].filter(Boolean).join("/");
  return `充值包 · ${p.name}${inner ? `（${inner}）` : ""}`;
}

// 套餐购买卡：列出套餐（免费档不售），选渠道购买。
// createOrder → 应用内扫码 → 服务端确认本次订单 paid → 刷新额度。
// props: { api, isLoggedIn, onLoginRequest, onPurchased }
export function PlansCard({ api, isLoggedIn, onLoginRequest, onPurchased }) {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [channel, setChannel] = useState(CHANNELS[0].id);
  const [buyingCode, setBuyingCode] = useState("");
  const [waiting, setWaiting] = useState(null); // { planName } 浏览器付款等待态（iframe 失败的回退）
  const [paying, setPaying] = useState(null); // { plan, payUrl } 应用内扫码弹窗
  const [paidDone, setPaidDone] = useState(false); // 弹窗内成功态
  const [checking, setChecking] = useState(false);
  const mountedRef = useRef(false);
  const checkoutGenerationRef = useRef(0);
  const activeOrderRef = useRef(null);
  const pollBusyRef = useRef(null);
  const pollTimerRef = useRef(null);
  const pollTicksRef = useRef(0);
  const closeTimerRef = useRef(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const isCurrentCheckout = useCallback((generation) =>
    mountedRef.current && checkoutGenerationRef.current === generation, []);

  const invalidateCheckout = useCallback(() => {
    checkoutGenerationRef.current += 1;
    activeOrderRef.current = null;
    pollBusyRef.current = null;
    stopPolling();
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, [stopPolling]);

  // 卸载、登录态或桥接变化都结束本次结账；迟到响应不得复活旧订单。
  useEffect(() => {
    mountedRef.current = true;
    setBuyingCode("");
    setWaiting(null);
    setPaying(null);
    setPaidDone(false);
    setChecking(false);
    return () => {
      mountedRef.current = false;
      invalidateCheckout();
    };
  }, [api, isLoggedIn, invalidateCheckout]);

  const loadPlans = useCallback(async () => {
    if (!api?.listPlans) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await api.listPlans();
      if (r && r.success) {
        // 免费档（priceCents=0 / type=one_time_grant）不作为可购买项展示
        const sellable = (r.plans || []).filter(
          (p) => Number(p.priceCents) > 0 && p.type !== "one_time_grant"
        );
        setPlans(sellable);
      } else {
        setError((r && r.error) || "套餐加载失败");
      }
    } catch (e) {
      setError("套餐加载失败，请检查网络");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadPlans();
  }, [loadPlans]);

  // 支付成功收尾：停轮询、弹窗内展示成功后自动关闭、提示并刷新父级额度
  const finishPaid = useCallback(
    (planName) => {
      const generation = checkoutGenerationRef.current;
      activeOrderRef.current = null;
      stopPolling();
      setWaiting(null);
      setPaidDone(true);
      toast.success(`支付成功：${planName}，云端字数已到账`);
      onPurchased && onPurchased();
      if (!isCurrentCheckout(generation)) return;
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      closeTimerRef.current = setTimeout(() => {
        if (!isCurrentCheckout(generation)) return;
        setPaying(null);
        setPaidDone(false);
      }, 1800);
    },
    [stopPolling, onPurchased, isCurrentCheckout]
  );

  const checkOrder = useCallback(async () => {
    const active = activeOrderRef.current;
    if (!active || pollBusyRef.current === active) return false;
    pollBusyRef.current = active;
    try {
      const result = await api.getPaymentOrder(active.orderId);
      if (activeOrderRef.current !== active) return false;
      const order = result?.order;
      if (!result?.success || String(order?.orderId) !== active.orderId || order?.channel !== active.channel) return false;
      if (order.payStatus === "paid") {
        finishPaid(active.planName);
        return true;
      }
      if (["failed", "refunded"].includes(order.payStatus)) {
        stopPolling();
        toast.info("此订单已结束，请关闭窗口后重新下单");
      }
      return false;
    } catch {
      return false;
    } finally {
      if (pollBusyRef.current === active) pollBusyRef.current = null;
    }
  }, [api, finishPaid, stopPolling]);

  const startPolling = useCallback(
    () => {
      stopPolling();
      pollTicksRef.current = 0;
      pollTimerRef.current = setInterval(async () => {
        pollTicksRef.current += 1;
        if (pollTicksRef.current > POLL_MAX_TICKS) {
          stopPolling();
          return;
        }
        await checkOrder();
      }, POLL_INTERVAL_MS);
    },
    [stopPolling, checkOrder]
  );

  // 只接受服务端本订单已入账的状态, 不根据客户端按钮或余额变化判断付款。
  const handleConfirmPaid = useCallback(async () => {
    const planName = waiting?.planName || paying?.plan?.name;
    if (checking || !planName) return;
    const generation = checkoutGenerationRef.current;
    setChecking(true);
    try {
      if (!(await checkOrder()) && isCurrentCheckout(generation) && activeOrderRef.current) {
        toast.info("暂未检测到到账，付款成功后请稍等片刻再点一次");
      }
    } finally {
      if (isCurrentCheckout(generation)) setChecking(false);
    }
  }, [checking, waiting, paying, checkOrder, isCurrentCheckout]);

  const handleCancelWaiting = useCallback(() => {
    invalidateCheckout();
    setBuyingCode("");
    setChecking(false);
    setWaiting(null);
    setPaying(null);
    setPaidDone(false);
  }, [invalidateCheckout]);

  // 「无法扫码？在浏览器中打开」：保留弹窗与轮询，用系统浏览器打开电脑收银台（payUrl 兜底）
  const handleOpenInBrowser = useCallback(async () => {
    const url = paying?.payUrl || paying?.wapPayUrl;
    if (!url || !api?.openExternal) return;
    const generation = checkoutGenerationRef.current;
    try {
      await api.openExternal(url);
    } catch (e) {
      if (isCurrentCheckout(generation)) toast.error("打开浏览器失败，请重试");
    }
  }, [paying, api, isCurrentCheckout]);

  // iframe 加载失败（如被 X-Frame-Options 意外拦截）：自动回退浏览器收银台 + 1.13.0 等待支付态
  const handleFrameError = useCallback(async () => {
    const plan = paying?.plan;
    const payUrl = paying?.payUrl;
    const generation = checkoutGenerationRef.current;
    setPaying(null);
    setPaidDone(false);
    if (!plan || !payUrl) return;
    if (api?.openExternal) {
      try {
        await api.openExternal(payUrl);
      } catch (e) {
        /* 打开失败下面仍进入等待态，可手动刷新 */
      }
    }
    if (isCurrentCheckout(generation)) setWaiting({ planName: plan.name });
  }, [paying, api, isCurrentCheckout]);

  const handleBuy = async (plan) => {
    if (!mountedRef.current || buyingCode || waiting || paying) return;
    if (!isLoggedIn) {
      toast.error("请先登录后再购买");
      onLoginRequest && onLoginRequest();
      return;
    }
    invalidateCheckout();
    const generation = checkoutGenerationRef.current;
    setBuyingCode(plan.code);
    try {
      if (!api?.createOrder || !api?.getPaymentOrder) {
        toast.error("当前版本不支持订单查验，请更新应用");
        return;
      }
      const orderRes = await api.createOrder(plan.code, channel);
      if (!isCurrentCheckout(generation)) return;
      if (!orderRes || !orderRes.success) {
        toast.error((orderRes && orderRes.error) || "下单失败");
        return;
      }
      const order = orderRes.order || {};
      const orderId = String(order.orderId || order.id || "");
      if (!/^[1-9]\d{0,18}$/.test(orderId) || order.payload?.mock === true) {
        toast.error("支付服务暂不可用，请稍后重试");
        return;
      }
      if (order.channel !== channel || order.planCode !== plan.code || Number(order.priceCents) !== Number(plan.priceCents)) {
        toast.error("套餐或支付信息已变化，请刷新后重新购买");
        return;
      }
      const payUrl =
        order.payUrl || (order.payload && order.payload.payUrl) || null;
      const wapPayUrl =
        order.wapPayUrl || (order.payload && order.payload.wapPayUrl) || null;
      const codeUrl = order.payload?.codeUrl || null;
      const expiresAt = order.payload?.expiresAt || null;

      if ((channel === "wechat" && typeof codeUrl === "string" && codeUrl.startsWith("weixin://")) || (channel === "alipay" && (payUrl || wapPayUrl))) {
        activeOrderRef.current = { orderId, channel, planName: plan.name };
        setPaidDone(false);
        setPaying({ plan, channel, payUrl, wapPayUrl, codeUrl, expiresAt });
        startPolling();
        return;
      }

      toast.error("下单异常：未获得付款二维码");
    } catch (e) {
      if (isCurrentCheckout(generation)) toast.error("购买失败，请检查网络后重试");
    } finally {
      if (isCurrentCheckout(generation)) setBuyingCode("");
    }
  };

  return (
    <div className="rounded-2xl border border-gray-100 dark:border-neutral-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ShoppingCart className="w-4 h-4 text-blue-500" />
          <span className="text-[14px] font-medium text-gray-900 dark:text-gray-100">
            购买套餐
          </span>
        </div>
        {/* 渠道选择 */}
        <div className="inline-flex p-0.5 rounded-lg bg-gray-100 dark:bg-neutral-800">
          {CHANNELS.map((c) => {
            const active = channel === c.id;
            return (
              <button
                key={c.id}
                type="button"
                disabled={!!waiting || !!paying}
                onClick={() => setChannel(c.id)}
                className={`px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors disabled:opacity-50 ${
                  active
                    ? "bg-white dark:bg-neutral-900 text-blue-600 dark:text-blue-400 shadow-sm"
                    : "text-gray-500 dark:text-neutral-400"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      {waiting ? (
        /* 等待支付宝付款：手动确认 + 后台自动轮询到账 */
        <div className="py-5 flex flex-col items-center text-center">
          <Loader2 className="w-6 h-6 animate-spin text-blue-500 mb-3" />
          <p className="text-[14px] font-medium text-gray-900 dark:text-gray-100">
            等待支付：{waiting.planName}
          </p>
          <p className="mt-1.5 text-[12px] text-gray-500 dark:text-neutral-400 max-w-[300px]">
            已在浏览器打开支付宝付款页（可扫码或登录支付宝付款），完成付款后回来点下方按钮。到账后也会自动提示。
          </p>
          <div className="mt-3.5 flex items-center gap-2">
            <button
              type="button"
              onClick={handleConfirmPaid}
              disabled={checking}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[13px] font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {checking && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              我已完成支付 · 刷新额度
            </button>
            <button
              type="button"
              onClick={handleCancelWaiting}
              className="px-3.5 py-1.5 rounded-lg text-[13px] font-medium text-gray-600 dark:text-neutral-300 bg-gray-100 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      ) : loading ? (
        <div className="py-6 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-neutral-400" />
        </div>
      ) : error ? (
        <div className="py-4 text-center">
          <p className="text-[13px] text-red-500 mb-2">{error}</p>
          <button
            type="button"
            onClick={loadPlans}
            className="text-[13px] text-blue-600 dark:text-blue-400 hover:underline"
          >
            重试
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {plans.map((p) => {
            const busy = buyingCode === p.code;
            const isAlipay = channel === "alipay";
            return (
              <div
                key={p.code}
                className="rounded-xl border p-3 flex flex-col border-gray-150 dark:border-neutral-700 bg-white dark:bg-neutral-900"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[14px] font-semibold text-gray-900 dark:text-gray-100">
                    {p.name}
                  </span>
                </div>
                <p className="mt-0.5 text-[12px] text-gray-500 dark:text-neutral-400 min-h-[16px]">
                  {planBenefit(p)}
                </p>
                <div className="mt-2 flex items-baseline gap-0.5">
                  <span className="text-[13px] text-gray-500 dark:text-neutral-400">¥</span>
                  <span className="text-[22px] font-bold text-gray-900 dark:text-gray-100">
                    {centsToYuan(p.priceCents)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleBuy(p)}
                  disabled={busy}
                  className="mt-2.5 w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                >
                  {busy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <QrCode className="w-4 h-4" />
                  )}
                  {isAlipay ? "支付宝支付" : "微信支付"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {paying && (
        <PayQrModal
          channel={paying.channel}
          codeUrl={paying.codeUrl}
          expiresAt={paying.expiresAt}
          desc={payDesc(paying.plan)}
          amountYuan={centsToYuan(paying.plan.priceCents)}
          payUrl={paying.payUrl}
          wapPayUrl={paying.wapPayUrl}
          paid={paidDone}
          checking={checking}
          onConfirmPaid={handleConfirmPaid}
          onOpenBrowser={handleOpenInBrowser}
          onCancel={handleCancelWaiting}
          onFrameError={handleFrameError}
        />
      )}
    </div>
  );
}

export default PlansCard;
