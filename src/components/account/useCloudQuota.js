import { useState, useEffect, useCallback, useRef } from "react";

// 云端额度查询 hook：匿名可用（getCloudQuota 带 device 头）。
// 返回 { quota, loading, error, refresh }。quota 形如
//   { cloudRemaining, subscription:{active,planCode,endAt}, dailyUsed, dailyCap, registered }
// 进面板即拉一次；额度变动（兑换/购买成功）后由调用方主动 refresh。
export function useCloudQuota(api) {
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
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { quota, loading, error, refresh };
}
