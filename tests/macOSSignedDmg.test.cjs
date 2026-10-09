const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateSignedUrl, assertTransportContext, downloadSignedAsset, safeTransportError, withTemporarySecret } = require('../scripts/macos-signed-dmg.cjs');
const now = Date.parse('2026-10-10T02:00:00Z');
const url = (query = {}) => {
  const value = new URL('https://release-assets.githubusercontent.com/1234/asset');
  for (const [key, item] of Object.entries({ sp: 'r', spr: 'https', sr: 'b', se: new Date(now + 30 * 60000).toISOString(), sig: 'FIXTURE_SECRET_ONLY', ...query })) value.searchParams.set(key, item);
  return value.href;
};
const env = () => ({ GITHUB_REPOSITORY: 'firendvip/WordTaker', GITHUB_REF: 'refs/heads/codex/macos14-acceptance', GITHUB_EVENT_NAME: 'push', GITHUB_ACTIONS: 'true' });
test('only a short-lived HTTPS official single-file read-only URL is accepted', () => {
  assert.deepEqual(validateSignedUrl(url(), now), { expiresAt: new Date(now + 30 * 60000).toISOString(), remainingSeconds: 1800 });
});
for (const [label, value] of [
  ['malformed', 'not-a-url-FIXTURE_SECRET_ONLY'], ['insecure', url().replace('https:', 'http:')], ['wrong host', url().replace('release-assets.githubusercontent.com', 'evil.example')],
  ['userinfo', url().replace('https://', 'https://user:password@')], ['port', url().replace('.com/', '.com:444/')], ['fragment', `${url()}#secret`],
  ['write permission', url({ sp: 'rw' })], ['non-https permission', url({ spr: 'https,http' })], ['non-file resource', url({ sr: 'c' })],
  ['missing signature', url({ sig: '' })], ['missing expiry', url({ se: '' })], ['unknown expiry', url({ se: 'bad' })],
  ['expired', url({ se: new Date(now - 1).toISOString() })], ['too long', url({ se: new Date(now + 60 * 60000 + 1).toISOString() })],
  ['duplicate expiry', `${url()}&se=another-secret`],
]) test(`rejects ${label} without printing the URL or signature`, () => {
  assert.throws(() => validateSignedUrl(value, now), error => {
    assert.ok(!String(error).includes('FIXTURE_SECRET_ONLY') && !String(error).includes('https://'));
    return true;
  });
});
test('JWT expiry, if present, also caps the original provider URL lifetime', () => {
  const jwt = `header.${Buffer.from(JSON.stringify({ exp: (now + 10 * 60000) / 1000 })).toString('base64url')}.signature`;
  assert.equal(validateSignedUrl(url({ jwt }), now).remainingSeconds, 600);
});
for (const jwt of ['malformed', 'header.bad.signature', `header.${Buffer.from('{}').toString('base64url')}.signature`, `header.${Buffer.from(JSON.stringify({ exp: (now - 1000) / 1000 })).toString('base64url')}.signature`]) {
  test('rejects unknown or expired JWT expiry without raw payload disclosure', () => assert.throws(() => validateSignedUrl(url({ jwt }), now)));
}
test('transport is restricted to the exact non-fork QA ref and IDs', () => assert.doesNotThrow(() => assertTransportContext(env(), '408254714', '625938591')));
for (const [key, value] of [['GITHUB_REPOSITORY', 'fork/WordTaker'], ['GITHUB_REF', 'refs/pull/1/merge'], ['GITHUB_REF', 'refs/heads/main'], ['GITHUB_EVENT_NAME', 'pull_request'], ['GITHUB_EVENT_NAME', 'pull_request_target'], ['GITHUB_ACTIONS', 'false']]) {
  test(`rejects unsafe context ${key}/${value}`, () => assert.throws(() => assertTransportContext({ ...env(), [key]: value }, '408254714', '625938591')));
}
test('refuses different draft or asset IDs', () => {
  assert.throws(() => assertTransportContext(env(), '408254715', '625938591'));
  assert.throws(() => assertTransportContext(env(), '408254714', '625938592'));
});
test('unknown nested fetch errors never expose URL/cause/message', () => {
  const error = new Error(`fetch failed ${url()}`, { cause: new Error(url()) });
  assert.deepEqual(safeTransportError(error), { code: 'TRANSPORT_UNEXPECTED_ERROR' });
});
const bytes = Buffer.from('actual-small-test-payload');
const expected = { dmgSize: bytes.length, dmgSha256: crypto.createHash('sha256').update(bytes).digest('hex') };
const response = (status = 200, body = [bytes], length = bytes.length) => ({ status, headers: new Headers({ 'content-length': String(length) }), body });
test('download uses no authorization, manual redirects, streamed bytes and complete hash', async () => {
  const writes = [], fetchImpl = async (value, options) => {
    assert.equal(value, url()); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers, undefined); assert.equal(options.credentials, 'omit');
    return response();
  };
  const result = await downloadSignedAsset(url(), chunk => writes.push(chunk), { now, expected, fetchImpl });
  assert.equal(Buffer.concat(writes).toString(), bytes.toString());
  assert.deepEqual(result, { size: bytes.length, sha256: expected.dmgSha256 });
});
test('network exception, even containing the signed URL, is reduced to a constant safe code', async () => {
  await assert.rejects(downloadSignedAsset(url(), () => {}, { now, expected, fetchImpl: async () => { throw new Error(url()); } }), error => error.code === 'SIGNED_DOWNLOAD_NETWORK_ERROR' && !String(error).includes('FIXTURE_SECRET_ONLY'));
});
for (const status of [301, 302, 307, 403, 500]) test(`rejects HTTP ${status} without following redirect`, async () => {
  await assert.rejects(downloadSignedAsset(url(), () => {}, { now, expected, fetchImpl: async () => response(status) }), error => error.code === 'SIGNED_DOWNLOAD_HTTP_ERROR');
});
test('rejects header length mismatch', async () => {
  await assert.rejects(downloadSignedAsset(url(), () => {}, { now, expected, fetchImpl: async () => response(200, [bytes], bytes.length + 1) }), error => error.code === 'SIGNED_DOWNLOAD_LENGTH_MISMATCH');
});
test('rejects oversized, truncated, wrong-hash or failed-body data', async () => {
  for (const body of [[Buffer.concat([bytes, bytes])], [bytes.subarray(0, 1)], [Buffer.alloc(bytes.length)], { async *[Symbol.asyncIterator]() { throw new Error(url()); } }]) {
    await assert.rejects(downloadSignedAsset(url(), () => {}, { now, expected, fetchImpl: async () => response(200, body) }), error => !String(error).includes('FIXTURE_SECRET_ONLY'));
  }
});
test('known errors remain safe fixed codes', () => {
  assert.equal(safeTransportError({ code: 'SIGNED_DOWNLOAD_HASH_MISMATCH', message: url() }).code, 'SIGNED_DOWNLOAD_HASH_MISMATCH');
});
test('pre-existing secret is never overwritten or deleted', async () => {
  await assert.rejects(withTemporarySecret({ exists: () => true, create: () => assert.fail('overwrite'), remove: () => assert.fail('delete'), use: () => assert.fail('use') }), error => error.code === 'TEMP_SECRET_ALREADY_EXISTS');
});
test('successful consumption deletes the owned secret immediately and finally is idempotent', async () => {
  let present = false, deleted = 0;
  await withTemporarySecret({ exists: () => present, create: () => { present = true; }, remove: () => { present = false; deleted++; }, use: async cleanup => { await cleanup(); assert.equal(present, false); } });
  assert.equal(deleted, 1);
});
test('failed or cancelled acceptance deletes only the newly created secret in finally', async () => {
  let present = false;
  await assert.rejects(withTemporarySecret({ exists: () => present, create: () => { present = true; }, remove: () => { present = false; }, use: () => { throw new Error('cancelled'); } }));
  assert.equal(present, false);
});
test('unknown create outcome is checked and cleaned without leaving an async secret', async () => {
  let present = false;
  await assert.rejects(withTemporarySecret({ exists: () => present, create: () => { present = true; throw new Error('network after server commit'); }, remove: () => { present = false; }, use: () => assert.fail('unconfirmed creation') }));
  assert.equal(present, false);
});
test('create failure before server commit never deletes an unrelated object', async () => {
  await assert.rejects(withTemporarySecret({ exists: () => false, create: () => { throw new Error('failed'); }, remove: () => assert.fail('absent secret'), use: () => assert.fail('failed creation') }));
});
test('cleanup failure or still-present secret has only a safe fixed error', async () => {
  for (const remove of [() => { throw new Error(url()); }, () => {}]) {
    let present = false;
    await assert.rejects(withTemporarySecret({ exists: () => present, create: () => { present = true; }, remove, use: () => {} }), error => error.code === 'TEMP_SECRET_CLEANUP_FAILED' && !String(error).includes('FIXTURE_SECRET_ONLY'));
  }
});
