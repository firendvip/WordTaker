import React from "react";
import { Loader2, RefreshCw, Zap, Crown } from "lucide-react";
import { formatChars, formatDate } from "./format";

// 云端额度卡：大数字剩余字数 + 订阅状态 + 今日已用 + 刷新按钮。
// 未登录也显示（匿名设备额度）。props: { quota, loading, error, onRefresh, bare }
// bare=true 时只渲染内层（标签/数字/徽章），不带渐变外壳——供「一体化会员卡」内嵌复用。
export function QuotaCard({
  quota,
  loading,
  error,
  onRefresh,
  bare = false,
  isLoggedIn = true,
  onLogin,
}) {
  const remaining = quota ? quota.cloudRemaining : null;
  const sub = quota && quota.subscription;
  const subActive = !!(sub && sub.active);
  const dailyUsed = quota ? quota.dailyUsed : null;

  const inner = (
    <>
      <div className="flex items-center justify-between mb-1 relative">
        <span className="text-[13px] font-medium text-white/80">云端剩余字数</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          title="刷新额度"
          className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-white/15 hover:bg-white/25 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="relative">
        {loading && remaining == null ? (
          <div className="h-10 flex items-center">
            <Loader2 className="w-5 h-5 animate-spin text-white/80" />
          </div>
        ) : error ? (
          <p className="text-[13px] text-white/90 py-2">{error}</p>
        ) : (
          <>
            <p className="text-[36px] leading-tight font-bold tracking-tight">
              {formatChars(remaining)}
              <span className="text-[15px] font-medium text-white/70 ml-1.5">字</span>
            </p>
            {/* 未登录：显示的是本机匿名设备的赠送额度，轻标识说明来源 */}
            {!isLoggedIn && (
              <p className="text-[12px] text-white/70 mt-0.5">未登录 · 本机赠送额度</p>
            )}
          </>
        )}
      </div>

      {isLoggedIn && (
        <div className="mt-3 flex flex-wrap items-center gap-2 relative">
          {subActive ? (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] font-medium bg-amber-300/90 text-amber-900">
              <Crown className="w-3.5 h-3.5" />
              {sub.endAt ? `订阅有效 · 至 ${formatDate(sub.endAt)}` : "订阅有效 · 不限量"}
            </span>
          ) : (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[12px] font-medium bg-white/15 text-white/90">
              未订阅
            </span>
          )}
          {dailyUsed != null && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[12px] font-medium bg-white/15 text-white/90">
              今日已用 {formatChars(dailyUsed)} 字
            </span>
          )}
        </div>
      )}

      {!isLoggedIn && !loading && (
        <div className="mt-3 relative">
          <button
            type="button"
            onClick={onLogin}
            className="inline-flex items-center gap-1 bg-orange-100 hover:bg-orange-200 text-orange-900 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors"
          >
            未登录 · 点此登录
          </button>
        </div>
      )}
    </>
  );

  if (bare) return inner;

  return (
    <div className="rounded-2xl p-5 bg-gradient-to-br from-indigo-500 to-blue-600 text-white shadow-sm relative overflow-hidden">
      <div className="absolute -right-6 -top-6 opacity-10">
        <Zap className="w-28 h-28" />
      </div>
      {inner}
    </div>
  );
}

export default QuotaCard;
