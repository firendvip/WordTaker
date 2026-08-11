import React, { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import { Loader2, Mail, Smartphone, MessageCircle, ShieldCheck } from "lucide-react";
import { useCloudQuota } from "./useCloudQuota";
import { QuotaCard } from "./QuotaCard";
import { InviteCard } from "./InviteCard";
import { RedeemCard } from "./RedeemCard";
import { PlansCard } from "./PlansCard";
import { MembershipHero } from "./MembershipHero";

// 短信登录开关：渠道调整暂下线手机验证码入口（代码保留，置 true 即恢复）。
const SMS_LOGIN_ENABLED = false;

// 登录方式：手机验证码 / 邮箱验证码
const METHODS = [
  { id: "phone", label: "手机验证码", icon: Smartphone },
  { id: "email", label: "邮箱验证码", icon: Mail },
].filter((m) => SMS_LOGIN_ENABLED || m.id !== "phone");

const CODE_RESEND_SECONDS = 60;

// 微信登录开关：微信开放平台「网站应用」appid 已配好 snsapi_login（real qrconnect），启用。
const WECHAT_LOGIN_ENABLED = true;

// 账户/会员面板：登录闭环 + 云端额度 + 邀请码 + 兑换码 + 套餐购买（dev mock 支付）。
// 额度卡匿名可见；改额度操作（兑换/购买）需登录，未登录时引导先登录。
export function AccountPanel({ rowLabelClass }) {
  const api = typeof window !== "undefined" ? window.electronAPI : null;

  const [initializing, setInitializing] = useState(true);
  const [account, setAccount] = useState(null); // 已登录账号摘要
  const [method, setMethod] = useState(METHODS[0].id);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [passportPending, setPassportPending] = useState(false);
  const [passportEnabled, setPassportEnabled] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const timerRef = useRef(null);
  const compatibilityNoticeRef = useRef(false);

  const isLoggedIn = !!account;

  // 云端额度：进面板即拉一次（未登录拉匿名设备赠送额度）；兑换/购买/登录后 refresh；
  // 退出登录先 clear 清零，随后 hook 依 isLoggedIn 变化自动重拉（拿到匿名设备额度，可能为 0）。
  const { quota, loading: quotaLoading, error: quotaError, refresh: refreshQuota, clear: clearQuota } =
    useCloudQuota(api, isLoggedIn);

  // 已登录时向后端拉最新账号摘要（含 inviteCode / 订阅），失败静默不影响本地态。
  const refreshAccount = useCallback(async () => {
    if (!api?.authMe) return null;
    try {
      const r = await api.authMe();
      if (r && r.success && r.account) {
        setAccount((prev) =>
          prev?.authProvider &&
          r.account.authProvider &&
          prev.authProvider !== r.account.authProvider
            ? r.account
            : { ...(prev || {}), ...r.account },
        );
        if (r.compatibilityFallback && !compatibilityNoticeRef.current) {
          compatibilityNoticeRef.current = true;
          toast.warning("统一身份尚未完成 AIM 映射，当前继续使用旧版账号");
        }
      } else if (r?.code === "IDENTITY_CONFLICT") {
        clearQuota();
        setAccount(
          r.fallbackAccount ? { ...r.fallbackAccount, authProvider: "legacy" } : null,
        );
        if (!compatibilityNoticeRef.current) {
          compatibilityNoticeRef.current = true;
          toast.error(
            r.fallbackAccount
              ? "统一身份与旧版账号不一致，已保留旧版账号与业务数据"
              : "统一身份尚未绑定本项目账号，请继续使用旧版登录",
          );
        }
      } else if (r && (r.loggedIn === false || r.code === "AUTH_REQUIRED")) {
        clearQuota();
        setAccount(null);
      }
      return r;
    } catch (e) {
      /* 网络失败保留本地摘要 */
      return null;
    }
  }, [api, clearQuota]);

  useEffect(() => {
    const off = api?.onPassportAuthResult?.((result) => {
      if (result?.success && result.event === "login-completed") {
        setPassportPending(false);
        setShowLoginModal(false);
        // The OIDC profile alone is not an AIM account. Expose it only after
        // Passport-authenticated /auth/me proves the stable business mapping.
        void refreshAccount().then((accountResult) => {
          if (accountResult?.success && accountResult.authProvider === "passport") {
            toast.success("望三通行证登录成功");
          }
        });
      } else if (result?.success && result?.loggedIn) {
        if (result.provider === "legacy") setAccount(result.account || {});
        else void refreshAccount();
      } else if (result?.success && result?.loggedIn === false) {
        setPassportPending(false);
        clearQuota();
        setAccount(null);
      } else if (result?.error) {
        setPassportPending(false);
        toast.error(result.error);
      }
    });
    return () => {
      if (typeof off === "function") off();
    };
  }, [api, clearQuota, refreshAccount]);

  // 启动时读取本地登录态（不打网络），登录时再联网刷新账号摘要
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const st = api?.getAuthState ? await api.getAuthState() : null;
        if (alive && st && st.loggedIn) {
          if (st.provider === "legacy") setAccount(st.account || {});
          await refreshAccount();
        }
        if (alive) setPassportEnabled(st?.passportEnabled === true);
      } catch (e) {
        /* 读取失败视为未登录 */
      } finally {
        if (alive) setInitializing(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, refreshAccount]);

  // 倒计时清理
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // 登录弹窗：按 ESC 关闭
  useEffect(() => {
    if (!showLoginModal) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape") setShowLoginModal(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showLoginModal]);

  const startCountdown = useCallback(() => {
    setCountdown(CODE_RESEND_SECONDS);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }, []);

  const account_identifier = method === "phone" ? phone : email;

  // 发送验证码
  const handleSend = async () => {
    if (sending || countdown > 0) return;
    setSending(true);
    try {
      const r =
        method === "phone"
          ? await api.authSmsSend(phone.trim())
          : await api.authEmailSend(email.trim());
      if (r && r.success) {
        toast.success("验证码已发送");
        startCountdown();
      } else {
        toast.error((r && r.error) || "发送失败");
      }
    } catch (e) {
      toast.error("发送失败，请检查网络");
    } finally {
      setSending(false);
    }
  };

  // 提交登录（手机 / 邮箱）
  const handleLogin = async () => {
    if (submitting) return;
    if (!code.trim()) {
      toast.error("请输入验证码");
      return;
    }
    setSubmitting(true);
    try {
      const invite = inviteCode.trim() || undefined;
      const r =
        method === "phone"
          ? await api.authSmsLogin(phone.trim(), code.trim(), invite)
          : await api.authEmailLogin(email.trim(), code.trim(), invite);
      if (r && r.success) {
        setAccount(r.account || {});
        setCode("");
        setInviteCode("");
        setShowLoginModal(false);
        toast.success(r.isNew ? "注册并登录成功" : "登录成功");
        refreshAccount();
        refreshQuota();
      } else {
        toast.error((r && r.error) || "登录失败");
      }
    } catch (e) {
      toast.error("登录失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  const handlePassportLogin = async () => {
    if (passportPending || submitting) return;
    setPassportPending(true);
    try {
      const result = await api.authPassportLogin();
      if (result?.success && result?.pending) {
        toast.info("已在系统浏览器打开望三通行证");
      } else {
        setPassportPending(false);
        toast.error(result?.error || "统一登录暂不可用");
      }
    } catch {
      setPassportPending(false);
      toast.error("统一登录暂不可用");
    }
  };

  // 微信登录（mock）
  const handleWechat = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const invite = inviteCode.trim() || undefined;
      const r = await api.authWechatLogin(invite);
      if (r && r.success) {
        setAccount(r.account || {});
        toast.success(r.isNew ? "微信注册并登录成功" : "微信登录成功");
        refreshAccount();
        refreshQuota();
      } else {
        toast.error((r && r.error) || "微信登录失败");
      }
    } catch (e) {
      toast.error("微信登录失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    let result;
    try {
      result = await api.authLogout();
    } catch (e) {
      result = null;
    }
    if (!result?.success) {
      toast.error(result?.error || "无法清除本地登录凭据，请重试");
      return;
    }
    setAccount(null);
    // 立即清零本地额度态：不能让原账号的云端字数在退出后继续显示
    clearQuota();
    toast.success("已退出弦外小猫，不影响其他应用的登录状态");
  };

  const handleManagePassport = async () => {
    try {
      const result = await api?.authPassportAccount?.();
      if (!result?.success) toast.error(result?.error || "账号中心暂不可用");
    } catch {
      toast.error("账号中心暂不可用");
    }
  };

  if (initializing) {
    return (
      <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-gray-100 dark:border-neutral-800">
        <div className="p-10 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-neutral-400" />
        </div>
      </div>
    );
  }

  // 引导登录：打开登录弹窗（未登录态）
  const openLoginModal = () => setShowLoginModal(true);

  // 会员区块（额度卡 + 邀请 + 兑换 + 购买）：登录/未登录都展示，改额度操作按登录态引导。
  const membershipSection = (
    <div className="space-y-3">
      <QuotaCard
        quota={quota}
        loading={quotaLoading}
        error={quotaError}
        onRefresh={refreshQuota}
        isLoggedIn={isLoggedIn}
        onLogin={openLoginModal}
      />
      {isLoggedIn && <InviteCard inviteCode={account.inviteCode} />}
      <RedeemCard
        api={api}
        isLoggedIn={isLoggedIn}
        onLoginRequest={openLoginModal}
        onRedeemed={() => {
          refreshQuota();
          refreshAccount();
        }}
      />
      <PlansCard
        api={api}
        isLoggedIn={isLoggedIn}
        onLoginRequest={openLoginModal}
        onPurchased={() => {
          refreshQuota();
          refreshAccount();
        }}
      />
    </div>
  );

  // 已登录：一体化会员卡（账号 + 云端字数 + 邀请 + 兑换）+ 套餐购买
  if (isLoggedIn) {
    return (
      <div className="space-y-3">
        <MembershipHero
          account={account}
          quota={quota}
          quotaLoading={quotaLoading}
          quotaError={quotaError}
          onRefreshQuota={refreshQuota}
          onLogout={handleLogout}
          onManagePassport={
            account.authProvider === "passport"
              ? handleManagePassport
              : undefined
          }
          api={api}
          onRedeemed={() => {
            refreshQuota();
            refreshAccount();
          }}
        />
        {passportEnabled && account.authProvider !== "passport" && (
          <div className="rounded-2xl border border-indigo-100 dark:border-indigo-900/50 bg-indigo-50/70 dark:bg-indigo-950/20 px-4 py-3">
            <p className="text-[12px] text-gray-600 dark:text-neutral-300 mb-2">
              保留当前旧版账号作为回退，并验证它与望三通行证属于同一业务账号。
            </p>
            <button
              type="button"
              onClick={handlePassportLogin}
              disabled={passportPending || submitting}
              className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg text-[13px] font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {passportPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ShieldCheck className="w-4 h-4" />
              )}
              {passportPending ? "等待浏览器授权…" : "验证望三通行证"}
            </button>
          </div>
        )}
        <PlansCard
          api={api}
          isLoggedIn={true}
          onLoginRequest={openLoginModal}
          onPurchased={() => {
            refreshQuota();
            refreshAccount();
          }}
        />
      </div>
    );
  }

  // 未登录：会员区块（含匿名额度）+ 登录表单
  const sendDisabled =
    sending ||
    countdown > 0 ||
    (method === "phone" ? !phone.trim() : !email.trim());

  return (
    <div className="space-y-3">
      {membershipSection}

      {showLoginModal && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setShowLoginModal(false)}
        >
          <div
            id="account-login-form"
            className="bg-white dark:bg-neutral-900 rounded-2xl shadow-xl border border-gray-100 dark:border-neutral-800 max-w-md w-full max-h-[90vh] overflow-y-auto relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setShowLoginModal(false)}
              className="absolute top-3 right-3 p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:text-neutral-500 dark:hover:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors"
              aria-label="关闭"
            >
              <span className="text-xl leading-none">×</span>
            </button>
            <div className="px-6">
              <div className="py-5">
          <h3 className={`${rowLabelClass} chinese-title mb-1`}>登录账号：</h3>
          <p className="text-[12px] text-gray-500 dark:text-neutral-400 mb-4">
            登录后可跨设备同步、购买套餐、使用邀请与兑换码。
          </p>

          {passportEnabled && (
            <>
              <button
                type="button"
                onClick={handlePassportLogin}
                disabled={passportPending || submitting}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 mb-4 rounded-lg text-[14px] font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {passportPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ShieldCheck className="w-4 h-4" />
                )}
                {passportPending ? "等待浏览器授权…" : "望三通行证登录"}
              </button>

              <div className="flex items-center gap-3 mb-4">
                <span className="flex-1 h-px bg-gray-100 dark:bg-neutral-800" />
                <span className="text-[12px] text-gray-400 dark:text-neutral-500">旧版登录（兼容）</span>
                <span className="flex-1 h-px bg-gray-100 dark:bg-neutral-800" />
              </div>
            </>
          )}

          {/* 方式切换 */}
          <div className="inline-flex p-1 rounded-xl bg-gray-100 dark:bg-neutral-800 mb-4">
            {METHODS.map((m) => {
              const Icon = m.icon;
              const active = method === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setMethod(m.id);
                    setCode("");
                  }}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
                    active
                      ? "bg-white dark:bg-neutral-900 text-blue-600 dark:text-blue-400 shadow-sm"
                      : "text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-200"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {m.label}
                </button>
              );
            })}
          </div>

          {/* 账号输入 */}
          <div className="space-y-3">
            <div>
              <label className="block text-[12px] font-medium text-gray-600 dark:text-neutral-300 mb-1">
                {method === "phone" ? "手机号" : "邮箱"}
              </label>
              {method === "phone" ? (
                <input
                  type="tel"
                  inputMode="numeric"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="请输入手机号"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-neutral-700 rounded-lg focus:ring-1 focus:ring-blue-400 focus:border-transparent bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
                />
              ) : (
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-neutral-700 rounded-lg focus:ring-1 focus:ring-blue-400 focus:border-transparent bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
                />
              )}
            </div>

            {/* 验证码 + 发送 */}
            <div>
              <label className="block text-[12px] font-medium text-gray-600 dark:text-neutral-300 mb-1">
                验证码
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="6 位验证码"
                  className="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-300 dark:border-neutral-700 rounded-lg focus:ring-1 focus:ring-blue-400 focus:border-transparent bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
                />
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={sendDisabled}
                  className="flex-shrink-0 px-3 py-2 rounded-lg text-[13px] font-medium whitespace-nowrap bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-200 hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {sending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : countdown > 0 ? (
                    `${countdown}s`
                  ) : (
                    "获取验证码"
                  )}
                </button>
              </div>
            </div>

            {/* 邀请码（可选） */}
            <div>
              <label className="block text-[12px] font-medium text-gray-600 dark:text-neutral-300 mb-1">
                邀请码（可选）
              </label>
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="有邀请码可在此填写"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-neutral-700 rounded-lg focus:ring-1 focus:ring-blue-400 focus:border-transparent bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
              />
            </div>

            <button
              type="button"
              onClick={handleLogin}
              disabled={submitting}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-[14px] font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              登录 / 注册
            </button>
          </div>

          {/* 分隔 + 微信登录（网站应用审核通过前隐藏，见 WECHAT_LOGIN_ENABLED） */}
          {WECHAT_LOGIN_ENABLED && (
            <>
              <div className="flex items-center gap-3 my-4">
                <span className="flex-1 h-px bg-gray-100 dark:bg-neutral-800" />
                <span className="text-[12px] text-gray-400 dark:text-neutral-500">或</span>
                <span className="flex-1 h-px bg-gray-100 dark:bg-neutral-800" />
              </div>

              <button
                type="button"
                onClick={handleWechat}
                disabled={submitting}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-[14px] font-medium text-[#07C160] border border-[#07C160]/40 bg-[#07C160]/5 hover:bg-[#07C160]/10 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                <MessageCircle className="w-4 h-4" />
                微信登录
              </button>
            </>
          )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AccountPanel;
