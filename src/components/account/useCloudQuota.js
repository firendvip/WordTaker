import { useState, useEffect, useCallback, useRef } from "react";

// 云端额度查询 hook。返回 { quota, loading, error, refresh, clear }。quota 形如
//   { cloudRemaining, subscription:{active,planCode,endAt}, dailyUsed, dailyCap, registered }
// 已登录进面板即拉一次；额度变动（兑换/购买成功）后由调用方主动 refresh。
// 未登录不打网络（后端 /quota 匿名恒 0/registered:false），直接清空展示——省流量、防闪烁。
export function useCloudQuota(api, isLoggedIn = true) {
  const [quota, setQuota] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!api?.getCloudQuota) {
      setLoading(false);
      return;
    }
    // 未登录：不发请求，本地态清空（UI 显示 0 + 引导登录）
    if (!isLoggedIn) {
      setQuota(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await api.getCloudQuota();
      if (!aliveRef.current) return;
      if (r && r.success) {
        setQuota({
          cloudRemaining: r.cloudRemaining ?? null,
          subscription: r.subscription ?? null,
          dailyUsed: r.dailyUsed ?? null,
          dailyCap: r.dailyCap ?? null,
          registered: !!r.registered,
        });
      } else {
        setError((r && r.error) || "查询额度失败");
      }
    } catch (e) {
      if (aliveRef.current) setError("查询额度失败，请检查网络");
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [api, isLoggedIn]);

  // 立即清空本地额度态（退出登录时用）：不打网络，UI 马上回到未登录/清零展示
  const clear = useCallback(() => {
    setQuota(null);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { quota, loading, error, refresh, clear };
}
