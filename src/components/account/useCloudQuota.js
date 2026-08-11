import { useState, useEffect, useCallback, useRef } from "react";

// 云端额度查询 hook。返回 { quota, loading, error, refresh, clear }。quota 形如
//   { cloudRemaining, subscription:{active,planCode,endAt}, dailyUsed, dailyCap, registered }
// 进面板即拉一次（登录与否都拉）；额度变动（兑换/购买成功）后由调用方主动 refresh。
// 未登录也请求：后端 /quota 匿名按 X-Device-Id 返回本机赠送额度（registered:false）。
// isLoggedIn 仅作为依赖参与 refresh 重建：登录/退出时自动重新拉取对应额度。
export function useCloudQuota(api, isLoggedIn = true) {
  const [quota, setQuota] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const aliveRef = useRef(true);
  const requestGenerationRef = useRef(0);
  const loginStateRef = useRef(isLoggedIn);
  if (loginStateRef.current !== isLoggedIn) {
    loginStateRef.current = isLoggedIn;
    requestGenerationRef.current += 1;
  }

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const requestGeneration = ++requestGenerationRef.current;
    if (!api?.getCloudQuota) {
      if (requestGeneration === requestGenerationRef.current) setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await api.getCloudQuota();
      if (!aliveRef.current || requestGeneration !== requestGenerationRef.current) return;
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
      if (aliveRef.current && requestGeneration === requestGenerationRef.current) {
        setError("查询额度失败，请检查网络");
      }
    } finally {
      if (aliveRef.current && requestGeneration === requestGenerationRef.current) {
        setLoading(false);
      }
    }
    // isLoggedIn 变化时重建 refresh → useEffect 自动重新拉取（登录拿账号额度 / 退出拿匿名设备额度）
  }, [api, isLoggedIn]);

  // 立即清空本地额度态（退出登录时用）：不打网络，随后 refresh 会拿到匿名设备额度（可能为 0）
  const clear = useCallback(() => {
    requestGenerationRef.current += 1;
    setQuota(null);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { quota, loading, error, refresh, clear };
}
