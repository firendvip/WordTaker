const { evaluateAimMapping } = require("./passportDesktopPolicy");

function resultError(error, fallback = "获取账号失败") {
  return {
    success: false,
    code: error?.code || "PASSPORT_UNAVAILABLE",
    error: error?.message || fallback,
  };
}

function identityMatches(passportSession, identity) {
  return Boolean(
    passportSession &&
    identity &&
    passportSession.issuer === identity.issuer &&
    passportSession.account?.passport_user_id === identity.passport_user_id,
  );
}

function generationMatches(tokenStore, provider, context) {
  return Boolean(
    context &&
    Number.isSafeInteger(context.generation) &&
    tokenStore.getProviderGeneration?.(provider) === context.generation,
  );
}

function createPassportAimMapper({
  tokenStore,
  passportAuthManager = null,
  backendClient,
  passportEnabled = true,
} = {}) {
  if (!tokenStore || typeof tokenStore.getPassport !== "function") {
    throw new TypeError("createPassportAimMapper requires tokenStore");
  }
  if (!backendClient || typeof backendClient.authMe !== "function") {
    throw new TypeError("createPassportAimMapper requires backendClient");
  }
  let resolvePromise = null;
  let resolvePromiseKey = null;
  let resolvePromiseSensitive = false;
  const isPassportEnabled = () => typeof passportEnabled === "function"
    ? passportEnabled() === true
    : passportEnabled === true;

  function currentCredentialKey() {
    return `${tokenStore.getProviderGeneration?.("passport") ?? "x"}:` +
      `${tokenStore.getProviderGeneration?.("legacy") ?? "x"}`;
  }

  async function invalidatePassport() {
    try {
      if (passportAuthManager?.invalidatePassportSession) {
        await passportAuthManager.invalidatePassportSession();
        return true;
      }
      return tokenStore.clearProvider("passport") === true;
    } catch {
      return false;
    }
  }

  function conflictResult(invalidated) {
    const legacy = tokenStore.getLegacy();
    return {
      success: false,
      code: invalidated ? "IDENTITY_CONFLICT" : "LOCAL_SESSION_CLEAR_FAILED",
      error: invalidated
        ? "统一身份与本地业务账号映射冲突"
        : "身份冲突且无法安全失效本地映射",
      fallbackAccount: legacy?.account || null,
      compatibilityFallback: Boolean(legacy),
    };
  }

  async function performResolve({ sensitive = false } = {}) {
    const allowPassport = isPassportEnabled();
    const initialPassport = allowPassport ? tokenStore.getPassport() : null;
    if (initialPassport && passportAuthManager?.ensureSessionReady) {
      try {
        await passportAuthManager.ensureSessionReady({ forceProfile: sensitive });
      } catch (error) {
        // A temporary central outage must not turn a recoverable secure RT into
        // an anonymous AIM request. Legacy may still be used as compatibility.
        if (sensitive || !tokenStore.getLegacy()) return resultError(error);
      }
    }

    try {
      const authResult = await backendClient.authMe();
      const json = authResult?.response ?? authResult;
      const authProvider = authResult?.authProvider || null;
      const data = json?.data || {};
      const businessAccount = data.account || json?.data || null;
      const passportSession = allowPassport ? tokenStore.getPassport() : null;
      const legacy = tokenStore.getLegacy();
      const passportRequestMatches =
        generationMatches(tokenStore, "passport", authResult?.authContext?.passport) &&
        identityMatches(passportSession, authResult.authContext.passport.identity);
      const legacyRequestMatches = generationMatches(
        tokenStore,
        "legacy",
        authResult?.authContext?.legacy,
      );
      const legacyWasCandidate = Boolean(authResult?.authContext?.legacy);

      if (
        (!allowPassport && authProvider === "passport") ||
        (authProvider === "passport" && !passportRequestMatches) ||
        (authProvider === "passport" && legacyWasCandidate && !legacyRequestMatches) ||
        (authProvider === "legacy" && !legacyRequestMatches)
      ) {
        return { success: false, code: "AUTH_REQUIRED", error: "登录状态已变化，请重试" };
      }

      if (!authProvider) {
        let cleared = true;
        if (passportRequestMatches) cleared = await invalidatePassport();
        if (legacyRequestMatches) cleared = tokenStore.clearProvider("legacy") === true && cleared;
        return cleared
          ? { success: false, code: "AUTH_REQUIRED", error: "登录已失效", loggedIn: false }
          : {
              success: false,
              code: "LOCAL_SESSION_CLEAR_FAILED",
              error: "无法安全清除失效登录凭据",
            };
      }

      const decision = evaluateAimMapping({
        authProvider,
        passportSession:
          authProvider === "passport" || passportRequestMatches ? passportSession : null,
        authenticatedIdentity: authResult?.authIdentity || null,
        hasLegacyCredential: Boolean(legacy) || legacyWasCandidate,
        legacyAccount: legacy?.account || null,
        businessAccount,
      });
      if (decision.status === "stale-auth-response") {
        return { success: false, code: "AUTH_REQUIRED", error: "登录状态已变化，请重试" };
      }
      if (decision.status === "auth-required") {
        const cleared = !passportRequestMatches || await invalidatePassport();
        return cleared
          ? { success: false, code: "AUTH_REQUIRED", error: "统一登录已失效" }
          : {
              success: false,
              code: "LOCAL_SESSION_CLEAR_FAILED",
              error: "无法安全失效统一登录会话",
            };
      }
      if (decision.status === "identity-conflict") {
        return conflictResult(!passportRequestMatches || await invalidatePassport());
      }
      if (decision.status === "accept") {
        if (!tokenStore.markPassportAimApiAccepted(true, decision.aimUserId)) {
          return {
            success: false,
            code: "LOCAL_SESSION_CLEAR_FAILED",
            error: "无法安全保存统一身份映射",
          };
        }
      } else if (decision.status === "reject") {
        if (passportRequestMatches && !tokenStore.markPassportAimApiAccepted(false)) {
          return {
            success: false,
            code: "LOCAL_SESSION_CLEAR_FAILED",
            error: "无法安全失效统一身份映射",
          };
        }
      }

      const account = authProvider === "passport" && passportSession
        ? { ...(businessAccount || {}), ...(passportSession.account || {}) }
        : authProvider === "legacy" && businessAccount
          ? { ...businessAccount, authProvider: "legacy" }
          : businessAccount;
      if (allowPassport && authProvider === "legacy" && legacy && account) {
        if (!tokenStore.setLegacy({ accessToken: legacy.accessToken, account })) {
          return {
            success: false,
            code: "SECURE_STORAGE_REQUIRED",
            error: "系统安全凭据存储不可用，无法更新旧版登录",
          };
        }
      }
      const providerContext = authProvider === "legacy"
        ? { generation: tokenStore.getProviderGeneration?.("legacy"), identity: null }
        : authResult?.authContext?.passport;
      return {
        success: true,
        account,
        cloudRemaining: data.cloudRemaining ?? null,
        subscription: data.subscription ?? null,
        authProvider,
        authEvidence: {
          provider: authProvider,
          generation: providerContext?.generation ?? null,
          identity: authProvider === "passport" ? providerContext?.identity || null : null,
        },
        compatibilityFallback: authProvider === "legacy" && Boolean(passportSession),
      };
    } catch (error) {
      if (error?.status === 401) {
        let cleared = true;
        const currentPassport = allowPassport ? tokenStore.getPassport() : null;
        const passportAttempt = error.authContext?.passport;
        const legacyAttempt = error.authContext?.legacy;
        if (
          error.authProvider === "passport" &&
          currentPassport &&
          (passportAttempt
            ? generationMatches(tokenStore, "passport", passportAttempt) &&
              identityMatches(currentPassport, passportAttempt.identity)
            : !error.authIdentity || identityMatches(currentPassport, error.authIdentity))
        ) {
          cleared = await invalidatePassport();
        }
        if (
          error.authProvider === "legacy" &&
          tokenStore.getLegacy() &&
          (!legacyAttempt || generationMatches(tokenStore, "legacy", legacyAttempt))
        ) {
          cleared = tokenStore.clearProvider("legacy") === true && cleared;
        }
        return cleared
          ? { success: false, code: "AUTH_REQUIRED", error: "登录已失效", loggedIn: false }
          : {
              success: false,
              code: "LOCAL_SESSION_CLEAR_FAILED",
              error: "无法安全清除失效登录凭据",
            };
      }
      if (error?.status === 409 || error?.code === "IDENTITY_CONFLICT") {
        const currentPassport = allowPassport ? tokenStore.getPassport() : null;
        const passportAttempt = error.authContext?.passport;
        if (
          error.authProvider !== "passport" ||
          !currentPassport ||
          (passportAttempt
            ? !generationMatches(tokenStore, "passport", passportAttempt) ||
              !identityMatches(currentPassport, passportAttempt.identity)
            : !error.authIdentity || !identityMatches(currentPassport, error.authIdentity))
        ) {
          return { success: false, code: "AUTH_REQUIRED", error: "登录状态已变化，请重试" };
        }
        return conflictResult(!currentPassport || await invalidatePassport());
      }
      return resultError(error);
    }
  }

  async function resolve({ sensitive = false } = {}) {
    const credentialKey = currentCredentialKey();
    if (resolvePromise) {
      const active = resolvePromise;
      const activeKey = resolvePromiseKey;
      const activeWasSensitive = resolvePromiseSensitive;
      const result = await active;
      return credentialKey !== activeKey || (sensitive && !activeWasSensitive)
        ? resolve({ sensitive })
        : result;
    }
    const operation = performResolve({ sensitive }).finally(() => {
      if (resolvePromise === operation) {
        resolvePromise = null;
        resolvePromiseKey = null;
        resolvePromiseSensitive = false;
      }
    });
    resolvePromise = operation;
    resolvePromiseKey = credentialKey;
    resolvePromiseSensitive = sensitive;
    return operation;
  }

  return { resolve };
}

module.exports = { createPassportAimMapper };
