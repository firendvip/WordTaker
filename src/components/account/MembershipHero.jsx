import React from "react";
import { ExternalLink, LogOut, Zap } from "lucide-react";
import { QuotaCard } from "./QuotaCard";
import { InviteCard } from "./InviteCard";
import { RedeemCard } from "./RedeemCard";

// 一体化会员卡（版本 1）：把「账号头 + 云端字数 + 邀请码 + 兑换码」合并进同一张渐变大卡，
// 下半用毛玻璃分区。仅登录态使用（邀请/兑换均需登录）。
// props: { account, quota, quotaLoading, quotaError, onRefreshQuota, onLogout, api, onRedeemed }
export function MembershipHero({
  account,
  quota,
  quotaLoading,
  quotaError,
  onRefreshQuota,
  onLogout,
  onManagePassport,
  api,
  onRedeemed,
}) {
  const displayName =
    account.nickname ||
    account.phone ||
    account.email ||
    (account.wechatOpenId ? "微信用户" : "已登录用户");

  const loginType = account.authProvider === "passport"
    ? "望三通行证"
    : account.email
    ? "邮箱登录"
    : account.phone
    ? "手机登录"
    : account.wechatOpenId
    ? "微信登录"
    : "已登录";

  return (
    <div className="rounded-2xl p-5 bg-gradient-to-br from-indigo-500 to-blue-600 text-white shadow-sm relative overflow-hidden">
      <div className="absolute -right-6 -top-6 opacity-10 pointer-events-none">
        <Zap className="w-28 h-28" />
      </div>

      {/* 账号头 */}
      <div className="flex items-start justify-between gap-3 mb-4 relative">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-11 h-11 rounded-full bg-white/20 flex items-center justify-center text-white text-lg font-semibold flex-shrink-0 relative overflow-hidden">
            <span>{String(displayName).slice(0, 1).toUpperCase()}</span>
            {account.picture && (
              <img
                src={account.picture}
                alt="通行证头像"
                referrerPolicy="no-referrer"
                className="absolute inset-0 w-full h-full object-cover"
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                }}
              />
            )}
          </div>
          <div className="min-w-0">
            <p className="text-[15px] font-medium text-white truncate">{displayName}</p>
            <p className="text-[12px] text-white/70 truncate">{loginType}</p>
          </div>
        </div>
        <div className="flex-shrink-0 flex items-center gap-2">
          {onManagePassport && (
            <button
              type="button"
              onClick={onManagePassport}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12px] font-medium text-white bg-white/15 hover:bg-white/25 transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              编辑资料
            </button>
          )}
          <button
            type="button"
            onClick={onLogout}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium text-white bg-white/15 hover:bg-white/25 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            退出
          </button>
        </div>
      </div>

      {/* 云端剩余字数（复用 QuotaCard 内层，无独立渐变外壳） */}
      <div className="relative">
        <QuotaCard
          quota={quota}
          loading={quotaLoading}
          error={quotaError}
          onRefresh={onRefreshQuota}
          bare
        />
      </div>

      {/* 邀请码（毛玻璃分区） */}
      <div className="mt-4 relative">
        <InviteCard inviteCode={account.inviteCode} variant="onGradient" />
      </div>

      {/* 兑换码（毛玻璃分区） */}
      <div className="mt-2.5 relative">
        <RedeemCard api={api} isLoggedIn variant="onGradient" onRedeemed={onRedeemed} />
      </div>
    </div>
  );
}

export default MembershipHero;
