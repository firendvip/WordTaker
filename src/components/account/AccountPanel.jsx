import React, { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import { Loader2, Smartphone } from "lucide-react";
import { useCloudQuota } from "./useCloudQuota";
import { QuotaCard } from "./QuotaCard";
import { InviteCard } from "./InviteCard";
import { RedeemCard } from "./RedeemCard";
import { PlansCard } from "./PlansCard";
import { MembershipHero } from "./MembershipHero";

const CODE_RESEND_SECONDS = 60;
const PHONE_PATTERN = /^1[3-9]\d{9}$/;

// 账户/会员面板：登录闭环 + 云端额度 + 邀请码 + 兑换码 + 套餐购买（dev mock 支付）。
// 额度卡匿名可见；改额度操作（兑换/购买）需登录，未登录时引导先登录。
export function AccountPanel({ rowLabelClass }) {
  const api = typeof window !== "undefined" ? window.electronAPI : null;

  const [initializing, setInitializing] = useState(true);
  const [readingAuth, setReadingAuth] = useState(false);
  const [authReadError, setAuthReadError] = useState(false);
  const [account, setAccount] = useState(null); // 已登录账号摘要
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const timerRef = useRef(null);
  const mountedRef = useRef(false);
  const authGenerationRef = useRef(0);
  const authReadRef = useRef(null);
  const authActionPendingRef = useRef(false);

  const isCurrentAuth = useCallback((generation) =>
    mountedRef.current && authGenerationRef.current === generation, []);

  const isLoggedIn = !!account;
  const validPhone = PHONE_PATTERN.test(phone.trim());
  const smsAvailable = typeof api?.authSmsSend === "function" && typeof api?.authSmsLogin === "function";

  // 云端额度：进面板即拉一次（未登录拉匿名设备赠送额度）；兑换/购买/登录后 refresh；
  // 退出登录先 clear 清零，随后 hook 依 isLoggedIn 变化自动重拉（拿到匿名设备额度，可能为 0）。
  const { quota, loading: quotaLoading, error: quotaError, refresh: refreshQuota, clear: clearQuota } =
    useCloudQuota(api, isLoggedIn);

  // 已登录时向后端拉最新账号摘要（含 inviteCode / 订阅），失败静默不影响本地态。
  const refreshAccount = useCallback(async () => {
    if (!mountedRef.current || !api?.authMe) return;
    const generation = authGenerationRef.current;
    try {
      const r = await api.authMe();
      if (!isCurrentAuth(generation)) return;
      if (r && r.success && r.account) {
        setAccount((prev) => ({ ...(prev || {}), ...r.account }));
      } else if (r && r.loggedIn === false) {
        setAccount(null);
      }
    } catch (e) {
      /* 网络失败保留本地摘要 */
    }
  }, [api, isCurrentAuth]);

  // 读取失败是未知态，手动重试或窗口恢复焦点后再查；同一读取不重复派发。
  const readAuthState = useCallback(async () => {
    if (!mountedRef.current || authReadRef.current !== null || authActionPendingRef.current) return;
    const generation = ++authGenerationRef.current;
    authReadRef.current = generation;
    setReadingAuth(true);
    try {
      const st = api?.getAuthState ? await api.getAuthState() : null;
      if (!isCurrentAuth(generation)) return;
      if (st?.success === false || typeof st?.loggedIn !== "boolean") {
        setAuthReadError(true);
        return;
      }
      setAuthReadError(false);
      setAccount(st.loggedIn ? st.account || {} : null);
      if (st.loggedIn) refreshAccount();
    } catch {
      if (isCurrentAuth(generation)) setAuthReadError(true);
    } finally {
      if (authReadRef.current === generation) authReadRef.current = null;
      if (isCurrentAuth(generation)) {
        setReadingAuth(false);
        setInitializing(false);
      }
    }
  }, [api, isCurrentAuth, refreshAccount]);

  useEffect(() => {
    mountedRef.current = true;
    readAuthState();
    const onFocus = () => readAuthState();
    window.addEventListener("focus", onFocus);
    return () => {
      mountedRef.current = false;
      authGenerationRef.current += 1;
      authReadRef.current = null;
      window.removeEventListener("focus", onFocus);
    };
  }, [readAuthState]);

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

  // 发送验证码
  const handleSend = async () => {
    if (sending || submitting || countdown > 0 || !smsAvailable) return;
    if (!validPhone) {
      toast.error("请输入正确的 11 位手机号");
      return;
    }
    setSending(true);
    try {
      const r = await api.authSmsSend(phone.trim());
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

  // 提交手机验证码；首次验证通过由后端自动创建账号。
  const handleLogin = async () => {
    if (authActionPendingRef.current || submitting || sending || !smsAvailable) return;
    if (!validPhone) {
      toast.error("请输入正确的 11 位手机号");
      return;
    }
    if (!/^\d{6}$/.test(code.trim())) {
      toast.error("请输入 6 位数字验证码");
      return;
    }
    authActionPendingRef.current = true;
    const generation = ++authGenerationRef.current;
    authReadRef.current = null;
    setReadingAuth(false);
    setSubmitting(true);
    try {
      const invite = inviteCode.trim() || undefined;
      const r = await api.authSmsLogin(phone.trim(), code.trim(), invite);
      if (!isCurrentAuth(generation)) return;
      if (r && r.success) {
        setAuthReadError(false);
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
      if (isCurrentAuth(generation)) toast.error("登录失败，请重试");
    } finally {
      authActionPendingRef.current = false;
      if (isCurrentAuth(generation)) setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    if (authActionPendingRef.current) return;
    authActionPendingRef.current = true;
    const generation = ++authGenerationRef.current;
    authReadRef.current = null;
    setReadingAuth(false);
    try {
      const result = await api.authLogout();
      if (!isCurrentAuth(generation)) return;
      if (!result?.success) {
        toast.error(result?.error || "退出登录失败，请重试");
        return;
      }
    } catch (e) {
      if (isCurrentAuth(generation)) toast.error("退出登录失败，请重试");
      return;
    } finally {
      authActionPendingRef.current = false;
    }
    setAuthReadError(false);
    setAccount(null);
    // 立即清零本地额度态：不能让原账号的云端字数在退出后继续显示
    clearQuota();
    toast.success("已退出登录");
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

  if (authReadError) {
    return (
      <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-gray-100 dark:border-neutral-800 p-6">
        <p role="alert" className="text-sm text-gray-600 dark:text-neutral-300 mb-3">
          暂时无法读取登录状态，请稍后重试。
        </p>
        <button
          type="button"
          onClick={readAuthState}
          disabled={readingAuth}
          aria-busy={readingAuth}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {readingAuth && <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin" />}
          重试读取登录状态
        </button>
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
          api={api}
          onRedeemed={() => {
            refreshQuota();
            refreshAccount();
          }}
        />
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
  const sendDisabled = sending || submitting || countdown > 0 || !validPhone || !smsAvailable;

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
          <h3 className={`${rowLabelClass} chinese-title mb-1 inline-flex items-center gap-2`}>
            <Smartphone className="w-4 h-4" />手机验证码登录
          </h3>
          <p className="text-[12px] text-gray-500 dark:text-neutral-400 mb-4">
            验证通过即登录，未注册的手机号将自动创建账号。
          </p>
          {!smsAvailable && <p role="alert" className="text-sm text-red-600 mb-3">当前环境暂不支持手机验证码登录，请重新打开应用。</p>}

          {/* 账号输入 */}
          <div className="space-y-3">
            <div>
              <label htmlFor="login-phone" className="block text-[12px] font-medium text-gray-600 dark:text-neutral-300 mb-1">
                手机号（中国大陆 +86）
              </label>
                <input
                  id="login-phone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  maxLength={11}
                  disabled={sending || submitting}
                  value={phone}
                  onChange={(e) => { setPhone(e.target.value); setCode(""); }}
                  placeholder="请输入手机号"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-neutral-700 rounded-lg focus:ring-1 focus:ring-blue-400 focus:border-transparent bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
                />
            </div>

            {/* 验证码 + 发送 */}
            <div>
              <label htmlFor="login-code" className="block text-[12px] font-medium text-gray-600 dark:text-neutral-300 mb-1">
                验证码
              </label>
              <div className="flex gap-2">
                <input
                  id="login-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  disabled={submitting}
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
              disabled={submitting || sending || !smsAvailable}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-[14px] font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              登录 / 注册
            </button>
          </div>

              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AccountPanel;
