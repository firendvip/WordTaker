/**
 * Executes an AIM request with an explicit credential order.
 *
 * Compatibility retry is deliberately limited to safe/idempotent methods. A
 * payment/order/redeem POST is never replayed with another token after a 401.
 */

const SAFE_RETRY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function containsTokenDelimiter(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}

function usableCredentials(credentials) {
  if (!Array.isArray(credentials)) return [];
  const seen = new Set();
  const result = [];
  for (const credential of credentials) {
    if (
      !credential ||
      !["passport", "legacy"].includes(credential.provider) ||
      seen.has(credential.provider) ||
      typeof credential.accessToken !== "string" ||
      credential.accessToken.length < 8 ||
      containsTokenDelimiter(credential.accessToken)
    ) {
      continue;
    }
    seen.add(credential.provider);
    result.push(credential);
    if (result.length === 2) break;
  }
  return result;
}

async function fetchWithAuthFallback({ fetchFn, url, options = {}, credentials = [] }) {
  if (typeof fetchFn !== "function") throw new TypeError("fetchFn is required");
  const method = String(options.method || "GET").toUpperCase();
  const candidates = usableCredentials(credentials);
  const attempts =
    SAFE_RETRY_METHODS.has(method) && candidates.length > 1
      ? candidates.slice(0, 2)
      : candidates.slice(0, 1);

  if (attempts.length === 0) {
    return {
      response: await fetchFn(url, {
        ...options,
        headers: { ...(options.headers || {}) },
      }),
      provider: null,
      rejectedProviders: [],
    };
  }

  let response;
  let provider = attempts[0].provider;
  const rejectedProviders = [];
  for (let index = 0; index < attempts.length; index += 1) {
    const credential = attempts[index];
    provider = credential.provider;
    response = await fetchFn(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${credential.accessToken}`,
      },
    });
    if (response.status === 401) rejectedProviders.push(credential.provider);
    if (response.status !== 401 || index === attempts.length - 1) break;
    try {
      await response.body?.cancel?.();
    } catch {
      // A failed body cleanup must not prevent the single safe compatibility retry.
    }
  }
  return { response, provider, rejectedProviders };
}

module.exports = { fetchWithAuthFallback };
