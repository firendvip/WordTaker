import React, { useState } from "react";
import { toast } from "sonner";
import { Ticket, Loader2 } from "lucide-react";
import { formatChars } from "./format";

// 兑换码卡：输入 + 兑换 → redeemCode → 成功刷新额度并提示到账字数。
// 需登录：未登录时按钮引导登录。props: { api, isLoggedIn, onLoginRequest, onRedeemed, variant }
//   variant="card"(默认)  —— 独立白卡样式
//   variant="onGradient"  —— 渐变卡内的毛玻璃分区（供「一体化会员卡」复用）
export function RedeemCard({ api, isLoggedIn, onLoginRequest, onRedeemed, variant = "card" }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const onGrad = variant === "onGradient";

  const handleRedeem = async () => {
    if (busy) return;
    if (!isLoggedIn) {
      toast.error("请先登录后再兑换");
      onLoginRequest && onLoginRequest();
      return;
    }
    const c = code.trim();
    if (!c) {
      toast.error("请输入兑换码");
      return;
    }
    setBusy(true);
    try {
      const r = await api.redeemCode(c);
      if (r && r.success) {
        toast.success(`兑换成功，到账 ${formatChars(r.charAmount)} 字`);
        setCode("");
        onRedeemed && onRedeemed();
      } else {
        toast.error((r && r.error) || "兑换失败");
      }
    } catch (e) {
      toast.error("兑换失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const wrapCls = onGrad
    ? "rounded-[13px] p-3 bg-white/[0.14] border border-white/20"
    : "rounded-2xl border border-gray-100 dark:border-neutral-800 p-4";
  const titleCls = onGrad
    ? "text-[13px] font-medium text-white/90"
    : "text-[14px] font-medium text-gray-900 dark:text-gray-100";
  const iconCls = onGrad ? "w-4 h-4 text-white/90" : "w-4 h-4 text-emerald-500";
  const inputCls = onGrad
    ? "flex-1 min-w-0 px-3 py-2 text-sm font-mono tracking-wider rounded-lg border border-white/25 bg-white/[0.16] text-white placeholder-white/60 focus:ring-1 focus:ring-white/50 focus:border-transparent"
    : "flex-1 min-w-0 px-3 py-2 text-sm font-mono tracking-wider border border-gray-300 dark:border-neutral-700 rounded-lg focus:ring-1 focus:ring-emerald-400 focus:border-transparent bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100";
  const btnCls = onGrad
    ? "flex-shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium text-white bg-white/20 hover:bg-white/30 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
    : "flex-shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors";

  return (
    <div className={wrapCls}>
      <div className="flex items-center gap-2 mb-3">
        <Ticket className={iconCls} />
        <span className={titleCls}>兑换码</span>
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && handleRedeem()}
          placeholder="输入兑换码"
          className={inputCls}
        />
        <button
          type="button"
          onClick={handleRedeem}
          disabled={busy}
          className={btnCls}
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          兑换
        </button>
      </div>
      {!isLoggedIn && !onGrad && (
        <p className="mt-2 text-[12px] text-gray-500 dark:text-neutral-400">
          兑换需要登录账号。
        </p>
      )}
    </div>
  );
}

export default RedeemCard;
