import React, { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { Loader2, ShoppingCart, CreditCard, Sparkles, QrCode } from "lucide-react";
import { centsToYuan, formatChars } from "./format";
import { PayQrModal } from "./PayQrModal";

// 支付渠道：支付宝为真实支付（应用内扫码弹窗，qr_pay_mode=4 嵌入二维码）；微信暂为 mock
const CHANNELS = [
  { id: "wechat", label: "微信" },
  { id: "alipay", label: "支付宝" },
];

// 自动轮询到账：每 5s 一次，最多 2 分钟
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_TICKS = 24;

// 套餐权益一行文案
function planBenefit(p) {
  if (p.type === "subscription") {
    const days = p.durationDays || 0;
    return days >= 365 ? "订阅 · 有效期约 1 年" : `订阅 · ${days} 天不限量`;
  }
  if (p.charAmount != null) return `字数包 · ${formatChars(p.charAmount)} 字`;
  return "";
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

// 支付弹窗副标题：明确写清是充值包还是订阅、哪一档（从 Plan 数据拼，不写死）
function payDesc(p) {
  if (!p) return "";
  const dur = durationCN(p.durationDays);
  if (p.type === "subscription") {
    return `订阅 · ${p.name}（云端不限量${dur ? `/${dur}` : ""}）`;
  }
  const chars = p.charAmount != null ? `云端${charsCN(p.charAmount)}字` : "";
  const inner = [chars, dur].filter(Boolean).join("/");
  return `充值包 · ${p.name}${inner ? `（${inner}）` : ""}`;
}

// 额度快照对比：字数增加 或 订阅状态/到期时间变化 视为到账
function quotaArrived(before, after) {
  if (!after) return false;
  const b = before || {};
  const bRemain = Number(b.cloudRemaining ?? -1);
  const aRemain = Number(after.cloudRemaining ?? -1);
  if (aRemain > bRemain) return true;
  const bSub = b.subscription || {};
  const aSub = after.subscription || {};
  if (!!aSub.active !== !!bSub.active) return true;
  if ((aSub.endAt || "") !== (bSub.endAt || "")) return true;
  return false;
}

// 套餐购买卡：列出套餐（免费档不售），选渠道购买。
// 支付宝：createOrder→系统浏览器打开收银台→等待支付（手动确认 + 自动轮询到账）。
// 微信（暂 mock）：createOrder→mockPay 一键走通。
// props: { api, isLoggedIn, onLoginRequest, onPurchased }
export function PlansCard({ api, isLoggedIn, onLoginRequest, onPurchased }) {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [channel, setChannel] = useState("wechat");
  const [buyingCode, setBuyingCode] = useState("");
  const [waiting, setWaiting] = useState(null); // { planName } 浏览器付款等待态（iframe 失败的回退）
  const [paying, setPaying] = useState(null); // { plan, payUrl } 应用内扫码弹窗
  const [paidDone, setPaidDone] = useState(false); // 弹窗内成功态
  const [checking, setChecking] = useState(false);
  const snapshotRef = useRef(null); // 下单前的额度快照
  const pollTimerRef = useRef(null);
  const pollTicksRef = useRef(0);
  const closeTimerRef = useRef(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      stopPolling();
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    },
    [stopPolling]
  );

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

  const fetchQuotaSnapshot = useCallback(async () => {
    if (!api?.getCloudQuota) return null;
    try {
      const r = await api.getCloudQuota();
      if (r && r.success) {
        return {
          cloudRemaining: r.cloudRemaining ?? null,
          subscription: r.subscription ?? null,
        };
      }
    } catch (e) {
      /* 快照失败不阻断购买 */
    }
    return null;
  }, [api]);

  // 支付成功收尾：停轮询、弹窗内展示成功后自动关闭、提示并刷新父级额度
  const finishPaid = useCallback(
    (planName) => {
      stopPolling();
      setWaiting(null);
      setPaidDone(true);
      toast.success(`支付成功：${planName}，字数/订阅已到账`);
      onPurchased && onPurchased();
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      closeTimerRef.current = setTimeout(() => {
        setPaying(null);
        setPaidDone(false);
      }, 1800);
    },
    [stopPolling, onPurchased]
  );

  const startPolling = useCallback(
    (planName) => {
      stopPolling();
      pollTicksRef.current = 0;
      pollTimerRef.current = setInterval(async () => {
        pollTicksRef.current += 1;
        if (pollTicksRef.current > POLL_MAX_TICKS) {
          stopPolling();
          return;
        }
        const now = await fetchQuotaSnapshot();
        if (now && quotaArrived(snapshotRef.current, now)) {
          finishPaid(planName);
        }
      }, POLL_INTERVAL_MS);
    },
    [stopPolling, fetchQuotaSnapshot, finishPaid]
  );

  // 「我已完成支付」：手动刷新额度并判定到账（弹窗内与浏览器等待态共用）
  const handleConfirmPaid = useCallback(async () => {
    const planName = waiting?.planName || paying?.plan?.name;
    if (checking || !planName) return;
    setChecking(true);
    try {
      const now = await fetchQuotaSnapshot();
      if (now && quotaArrived(snapshotRef.current, now)) {
        finishPaid(planName);
      } else {
        onPurchased && onPurchased();
        toast.info("暂未检测到到账，付款成功后请稍等片刻再点一次");
      }
    } finally {
      setChecking(false);
    }
  }, [checking, waiting, paying, fetchQuotaSnapshot, finishPaid, onPurchased]);

  const handleCancelWaiting = useCallback(() => {
    stopPolling();
    setWaiting(null);
    setPaying(null);
    setPaidDone(false);
  }, [stopPolling]);

  // 「无法扫码？在浏览器中打开」：保留弹窗与轮询，用系统浏览器打开电脑收银台（payUrl 兜底）
  const handleOpenInBrowser = useCallback(async () => {
    const url = paying?.payUrl || paying?.wapPayUrl;
    if (!url || !api?.openExternal) return;
    try {
      await api.openExternal(url);
    } catch (e) {
      toast.error("打开浏览器失败，请重试");
    }
  }, [paying, api]);

  // iframe 加载失败（如被 X-Frame-Options 意外拦截）：自动回退浏览器收银台 + 1.13.0 等待支付态
  const handleFrameError = useCallback(async () => {
    const plan = paying?.plan;
    const payUrl = paying?.payUrl;
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
    setWaiting({ planName: plan.name });
  }, [paying, api]);

  const handleBuy = async (plan) => {
    if (buyingCode || waiting || paying) return;
    if (!isLoggedIn) {
      toast.error("请先登录后再购买");
      onLoginRequest && onLoginRequest();
      return;
    }
    setBuyingCode(plan.code);
    try {
      const orderRes = await api.createOrder(plan.code, channel);
      if (!orderRes || !orderRes.success) {
        toast.error((orderRes && orderRes.error) || "下单失败");
        return;
      }
      const order = orderRes.order || {};
      const payUrl =
        order.payUrl || (order.payload && order.payload.payUrl) || null;
      const wapPayUrl =
        order.wapPayUrl || (order.payload && order.payload.wapPayUrl) || null;

      if (payUrl || wapPayUrl) {
        // 支付宝真实支付：先记额度快照，再打开应用内扫码弹窗
        // 优先 wapPayUrl 本地生成二维码（手机扫码后直接在手机上付款）；无则回退 iframe 电脑收银台
        snapshotRef.current = await fetchQuotaSnapshot();
        setPaidDone(false);
        setPaying({ plan, payUrl, wapPayUrl });
        startPolling(plan.name);
        return;
      }

      // mock 渠道（微信暂为模拟支付）：保持原一键直付流程
      const orderId = order.orderId || order.id || null;
      if (!orderId) {
        toast.error("下单异常：缺少订单号");
        return;
      }
      const payRes = await api.mockPay(orderId);
      if (payRes && payRes.success) {
        toast.success(`购买成功：${plan.name}（模拟支付）`);
        onPurchased && onPurchased();
      } else {
        toast.error((payRes && payRes.error) || "支付失败");
      }
    } catch (e) {
      toast.error("购买失败，请检查网络后重试");
    } finally {
      setBuyingCode("");
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
            const isSub = p.type === "subscription";
            const busy = buyingCode === p.code;
            const isAlipay = channel === "alipay";
            return (
              <div
                key={p.code}
                className={`rounded-xl border p-3 flex flex-col ${
                  isSub
                    ? "border-amber-200 dark:border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/5"
                    : "border-gray-150 dark:border-neutral-700 bg-white dark:bg-neutral-900"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  {isSub && <Sparkles className="w-3.5 h-3.5 text-amber-500" />}
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
                  ) : isAlipay ? (
                    <QrCode className="w-4 h-4" />
                  ) : (
                    <CreditCard className="w-4 h-4" />
                  )}
                  {isAlipay ? "支付宝支付" : "购买"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {channel === "alipay" ? (
        <p className="mt-3 text-[12px] text-gray-500 dark:text-neutral-400 flex items-center gap-1">
          <CreditCard className="w-3.5 h-3.5" />
          支付宝为真实付款：点击后弹出扫码窗口，手机支付宝扫码即可支付。
        </p>
      ) : (
        <p className="mt-3 text-[12px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <CreditCard className="w-3.5 h-3.5" />
          微信当前为体验版模拟支付，点击购买即时到账，不产生真实扣款。
        </p>
      )}

      {paying && (
        <PayQrModal
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
