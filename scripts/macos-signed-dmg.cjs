// Test-only signed transport. Never preserve the URL or native fetch error messages.
const crypto = require('node:crypto');
const { PRODUCT } = require('./macos-dmg-guard.cjs');
const SAFE_CODES = new Set(['SIGNED_URL_INVALID', 'SIGNED_URL_POLICY_REJECTED', 'SIGNED_URL_EXPIRY_REJECTED', 'SIGNED_URL_JWT_REJECTED', 'SIGNED_TRANSPORT_CONTEXT_REJECTED', 'SIGNED_DOWNLOAD_NETWORK_ERROR', 'SIGNED_DOWNLOAD_HTTP_ERROR', 'SIGNED_DOWNLOAD_LENGTH_MISMATCH', 'SIGNED_DOWNLOAD_TOO_LARGE', 'SIGNED_DOWNLOAD_HASH_MISMATCH', 'SIGNED_DOWNLOAD_BODY_ERROR', 'TEMP_SECRET_ALREADY_EXISTS', 'TEMP_SECRET_CLEANUP_FAILED']);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
function safeTransportError(error) { return { code: SAFE_CODES.has(error?.code) ? error.code : 'TRANSPORT_UNEXPECTED_ERROR' }; }
function validateSignedUrl(secret, now = Date.now()) {
  let value;
  try { value = new URL(secret); } catch { fail('SIGNED_URL_INVALID'); }
  if (value.protocol !== 'https:' || value.hostname !== 'release-assets.githubusercontent.com' || value.port || value.username || value.password || value.hash) fail('SIGNED_URL_POLICY_REJECTED');
  const query = value.searchParams;
  for (const key of ['se', 'sp', 'spr', 'sr', 'sig', 'jwt']) if (query.getAll(key).length > 1) fail('SIGNED_URL_POLICY_REJECTED');
  if (query.get('sp') !== 'r' || query.get('spr') !== 'https' || query.get('sr') !== 'b' || !query.get('sig')) fail('SIGNED_URL_POLICY_REJECTED');
  const expiry = Date.parse(query.get('se'));
  if (!Number.isFinite(expiry) || expiry <= now || expiry - now > 60 * 60000) fail('SIGNED_URL_EXPIRY_REJECTED');
  let expiresAt = expiry;
  if (query.has('jwt')) {
    let jwt;
    try {
      const parts = query.get('jwt').split('.');
      if (parts.length !== 3) fail('SIGNED_URL_JWT_REJECTED');
      jwt = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { fail('SIGNED_URL_JWT_REJECTED'); }
    if (!Number.isFinite(jwt.exp) || jwt.exp * 1000 <= now) fail('SIGNED_URL_JWT_REJECTED');
    expiresAt = Math.min(expiry, jwt.exp * 1000);
  }
  return { expiresAt: new Date(expiresAt).toISOString(), remainingSeconds: Math.floor((expiresAt - now) / 1000) };
}
function assertTransportContext(env, draft, asset) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'firendvip/WordTaker' || env.GITHUB_REF !== 'refs/heads/codex/macos14-acceptance' || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) || draft !== '408254714' || asset !== String(PRODUCT.assetId)) fail('SIGNED_TRANSPORT_CONTEXT_REJECTED');
}
async function downloadSignedAsset(secret, writeChunk, { now = Date.now(), expected = PRODUCT, fetchImpl = fetch } = {}) {
  validateSignedUrl(secret, now);
  let response;
  try { response = await fetchImpl(secret, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(300000) }); }
  catch { fail('SIGNED_DOWNLOAD_NETWORK_ERROR'); }
  if (response.status !== 200) fail('SIGNED_DOWNLOAD_HTTP_ERROR');
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) !== expected.dmgSize) fail('SIGNED_DOWNLOAD_LENGTH_MISMATCH');
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    for await (const bytes of response.body) {
      size += bytes.length;
      if (size > expected.dmgSize) fail('SIGNED_DOWNLOAD_TOO_LARGE');
      hash.update(bytes);
      writeChunk(bytes);
    }
  } catch (error) { if (SAFE_CODES.has(error?.code)) throw error; fail('SIGNED_DOWNLOAD_BODY_ERROR'); }
  if (size !== expected.dmgSize) fail('SIGNED_DOWNLOAD_LENGTH_MISMATCH');
  const sha256 = hash.digest('hex');
  if (sha256 !== expected.dmgSha256) fail('SIGNED_DOWNLOAD_HASH_MISMATCH');
  return { size, sha256 };
}
async function withTemporarySecret({ exists, create, remove, use }) {
  if (await exists()) fail('TEMP_SECRET_ALREADY_EXISTS');
  let owned = false;
  const cleanup = async () => {
    if (!owned) return;
    try {
      if (await exists()) await remove();
      if (await exists()) fail('TEMP_SECRET_CLEANUP_FAILED');
    } catch { fail('TEMP_SECRET_CLEANUP_FAILED'); }
    owned = false;
  };
  try {
    owned = true; // Creation outcome may be unknown after a network failure.
    await create();
    await use(cleanup);
  } finally { await cleanup(); }
}
module.exports = { validateSignedUrl, assertTransportContext, downloadSignedAsset, safeTransportError, withTemporarySecret };
