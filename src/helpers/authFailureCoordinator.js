const { OIDC_ISSUER } = require("./passportOidc");

function localSessionClearError() {
  const error = new Error("无法安全清除本地登录凭据");
  error.kind = "auth";
  error.code = "LOCAL_SESSION_CLEAR_FAILED";
  return error;
}

function samePassportIdentity(current, expected) {
  return Boolean(
    current &&
    expected &&
    current.issuer === OIDC_ISSUER &&
    expected.issuer === OIDC_ISSUER &&
    current.account?.passport_user_id === expected.passport_user_id,
  );
}

function createAuthFailureHandler({ tokenStore, passportAuthManager = null } = {}) {
  if (!tokenStore || typeof tokenStore.clearProvider !== "function") {
    throw new TypeError("createAuthFailureHandler requires tokenStore");
  }
  return async (attempts = []) => {
    const handled = new Set();
    for (const attempt of Array.isArray(attempts) ? attempts : []) {
      const provider = attempt?.provider;
      if (!['passport', 'legacy'].includes(provider) || handled.has(provider)) continue;
      handled.add(provider);
      if (
        Number.isSafeInteger(attempt.generation) &&
        typeof tokenStore.getProviderGeneration === "function" &&
        tokenStore.getProviderGeneration(provider) !== attempt.generation
      ) {
        continue;
      }
      if (provider === "passport") {
        const current = tokenStore.getPassport?.() || null;
        // A late 401 for Passport A must never clear a newly selected B session.
        if (attempt.identity && !samePassportIdentity(current, attempt.identity)) continue;
        if (passportAuthManager?.invalidatePassportSession) {
          await passportAuthManager.invalidatePassportSession();
        } else if (tokenStore.clearProvider("passport") !== true) {
          throw localSessionClearError();
        }
      } else if (tokenStore.clearProvider("legacy") !== true) {
        throw localSessionClearError();
      }
    }
    return true;
  };
}

module.exports = { createAuthFailureHandler };
