const path = require("path");
const { pathToFileURL } = require("url");
const { OIDC_ISSUER } = require("./passportOidc");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_TAB = /^[a-z]{1,32}$/;

function canonicalAimUserId(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== "string" || !/^[1-9][0-9]{0,31}$/.test(value)) return null;
  return value;
}

function isPassportRolloutEnabled(value) {
  if (value === 1) return true;
  return typeof value === "string" && /^(1|true)$/i.test(value);
}

function shouldPreflightSensitivePassport({ hasPassport = false, writeCandidates = [] } = {}) {
  if (!hasPassport) return false;
  const primaryProvider = Array.isArray(writeCandidates) ? writeCandidates[0]?.provider : null;
  return primaryProvider !== "legacy";
}

function hasOnlyQueryParameters(url, allowed) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return false;
  }
  return true;
}

function isTrustedSettingsUrl(rawUrl, { development = false, settingsFilePath } = {}) {
  if (typeof rawUrl !== "string" || typeof settingsFilePath !== "string") return false;
  if (!path.isAbsolute(settingsFilePath)) return false;
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password || url.hash) return false;
    const tab = url.searchParams.get("tab");
    if (tab !== null && !SAFE_TAB.test(tab)) return false;
    if (development) {
      if (!hasOnlyQueryParameters(url, new Set(["page", "tab"]))) return false;
      return (
        url.protocol === "http:" &&
        url.hostname === "localhost" &&
        url.port === "5173" &&
        url.pathname === "/" &&
        url.searchParams.getAll("page").length === 1 &&
        url.searchParams.get("page") === "settings"
      );
    }
    if (!hasOnlyQueryParameters(url, new Set(["tab"]))) return false;
    const expected = new URL(pathToFileURL(settingsFilePath).href);
    return (
      url.protocol === "file:" &&
      url.host === expected.host &&
      url.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

function validPassportIdentity(passportSession) {
  return (
    passportSession?.issuer === OIDC_ISSUER &&
    UUID.test(passportSession?.account?.passport_user_id || "")
  );
}

function evaluateAimMapping({
  authProvider,
  passportSession,
  authenticatedIdentity = null,
  hasLegacyCredential = false,
  legacyAccount = null,
  businessAccount = null,
} = {}) {
  if (authProvider !== "passport") {
    return passportSession ? { status: "reject" } : { status: "neutral" };
  }
  if (!validPassportIdentity(passportSession)) return { status: "auth-required" };
  if (
    authenticatedIdentity?.issuer !== OIDC_ISSUER ||
    !UUID.test(authenticatedIdentity?.passport_user_id || "")
  ) {
    return { status: "auth-required" };
  }
  if (
    authenticatedIdentity.issuer !== passportSession.issuer ||
    authenticatedIdentity.passport_user_id !== passportSession.account.passport_user_id
  ) {
    return { status: "stale-auth-response" };
  }
  const businessUserId = canonicalAimUserId(businessAccount?.userId);
  if (!businessUserId) return { status: "identity-conflict" };
  const establishedMapping = passportSession.aimMapping;
  if (establishedMapping) {
    if (
      establishedMapping.issuer !== passportSession.issuer ||
      establishedMapping.passport_user_id !== passportSession.account.passport_user_id ||
      canonicalAimUserId(establishedMapping.aim_user_id) !== businessUserId
    ) {
      return { status: "identity-conflict" };
    }
  }
  if (hasLegacyCredential || (legacyAccount !== null && legacyAccount !== undefined)) {
    const legacyUserId = canonicalAimUserId(legacyAccount?.userId);
    if (!legacyUserId || legacyUserId !== businessUserId) {
      return { status: "identity-conflict" };
    }
  }
  return { status: "accept", aimUserId: businessUserId };
}

module.exports = {
  evaluateAimMapping,
  isPassportRolloutEnabled,
  isTrustedSettingsUrl,
  shouldPreflightSensitivePassport,
};
