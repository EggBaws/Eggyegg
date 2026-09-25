import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  accountKeyFile,
  allowedAccountEmail,
  applyDeskView,
  clearSessionCookie,
  createDeskStore,
  createRateLimit,
  createSessionStore,
  emptyDeskView,
  guardApi,
  isPublicApi,
  originAllowed,
  publicAuthConfig,
  verifyGoogleIdToken,
  type Jwk,
} from '../auth.ts';
import { keyStatus, openKeys, readKeyFile, saveKeyFile, sealKeys } from '../secrets.ts';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' }) as Jwk;
jwk.kid = 'test-key';
jwk.alg = 'RS256';
jwk.use = 'sig';

const CLIENT = 'desk-client.apps.googleusercontent.com';
const EMAIL = 'pigpunkcoin@gmail.com';
const SUB = 'acct-owner-1';
const NOW = 1_800_000_000_000;

function mint(claims: Record<string, unknown>, opts?: { alg?: string; tamper?: boolean; kid?: string }): string {
  const header = { alg: opts?.alg ?? 'RS256', kid: opts?.kid ?? 'test-key', typ: 'JWT' };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const data = `${h}.${body}`;
  if (header.alg === 'none') return `${data}.`;
  const sig = sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url');
  if (!opts?.tamper) return `${data}.${sig}`;
  const forged = Buffer.from(JSON.stringify({ ...claims, email: 'other@example.com' })).toString('base64url');
  return `${h}.${forged}.${sig}`;
}

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT,
    exp: Math.floor(NOW / 1000) + 3600,
    iat: Math.floor(NOW / 1000),
    email: EMAIL,
    email_verified: true,
    sub: SUB,
    ...over,
  };
}

describe('Google sign-in', () => {
  it('accepts a verified token for the allowed account', async () => {
    const verdict = await verifyGoogleIdToken(mint(claims()), {
      clientId: CLIENT,
      allowedEmail: EMAIL,
      now: () => NOW,
      certs: async () => [jwk],
    });
    assert.deepEqual(verdict, { ok: true, email: EMAIL, sub: SUB });
  });

  it('accepts any verified Google account when the desk is not locked to one address', async () => {
    assert.equal(allowedAccountEmail(undefined), null);
    assert.equal(allowedAccountEmail(''), null);
    assert.equal(allowedAccountEmail('*'), null);
    assert.equal(allowedAccountEmail('any'), null);
    assert.equal(allowedAccountEmail('Pig@gmail.com'), 'pig@gmail.com');
    const verdict = await verifyGoogleIdToken(mint(claims({ email: 'someone@gmail.com', sub: 'acct-other-2' })), {
      clientId: CLIENT,
      allowedEmail: null,
      now: () => NOW,
      certs: async () => [jwk],
    });
    assert.deepEqual(verdict, { ok: true, email: 'someone@gmail.com', sub: 'acct-other-2' });
    const missing = claims();
    delete missing.sub;
    const noSub = await verifyGoogleIdToken(mint(missing), {
      clientId: CLIENT,
      allowedEmail: null,
      now: () => NOW,
      certs: async () => [jwk],
    });
    assert.equal(noSub.ok, false);
    if (!noSub.ok) assert.equal(noSub.error, 'sub');
  });

  it('rejects another Google account, an expired token, alg none, and a tampered signature', async () => {
    const opts = { clientId: CLIENT, allowedEmail: EMAIL, now: () => NOW, certs: async () => [jwk] };
    const wrong = await verifyGoogleIdToken(mint(claims({ email: 'someone@gmail.com' })), opts);
    const expired = await verifyGoogleIdToken(mint(claims({ exp: Math.floor(NOW / 1000) - 120 })), opts);
    const none = await verifyGoogleIdToken(mint(claims(), { alg: 'none' }), opts);
    const tampered = await verifyGoogleIdToken(mint(claims(), { tamper: true }), opts);
    const unverified = await verifyGoogleIdToken(mint(claims({ email_verified: false })), opts);
    assert.equal(wrong.ok, false);
    assert.equal(expired.ok, false);
    assert.equal(none.ok, false);
    assert.equal(tampered.ok, false);
    assert.equal(unverified.ok, false);
    if (!wrong.ok) assert.equal(wrong.error, 'email');
    if (!none.ok) assert.equal(none.error, 'alg');
    if (!tampered.ok) assert.equal(tampered.error, 'signature');
  });

  it('does not publish the allowed email in the sign-in config', () => {
    const cfg = publicAuthConfig(CLIENT);
    assert.deepEqual(cfg, { clientId: CLIENT, configured: true });
    assert.equal(JSON.stringify(cfg).includes(EMAIL), false);
    assert.deepEqual(publicAuthConfig('not-a-client'), { clientId: null, configured: false });
  });
});

describe('session gate', () => {
  it('keeps the cookie HttpOnly and shares nothing but the account on a second device', () => {
    let clock = 1_000;
    const store = createSessionStore({ now: () => clock, ttlMs: 5_000 });
    const phone = store.issue({ email: EMAIL, sub: SUB }, false);
    const laptop = store.issue({ email: EMAIL, sub: SUB }, true);
    const other = store.issue({ email: 'someone@gmail.com', sub: 'acct-other-2' }, false);
    assert.match(phone.setCookie, /HttpOnly/);
    assert.match(phone.setCookie, /SameSite=Lax/);
    assert.doesNotMatch(phone.setCookie, /Secure/);
    assert.match(laptop.setCookie, /Secure/);
    assert.equal(phone.setCookie.includes(EMAIL), false);
    assert.equal(phone.setCookie.includes(SUB), false);
    const phoneId = /choke_session=([a-f0-9]{64})/.exec(phone.setCookie)?.[1];
    const laptopId = /choke_session=([a-f0-9]{64})/.exec(laptop.setCookie)?.[1];
    const otherId = /choke_session=([a-f0-9]{64})/.exec(other.setCookie)?.[1];
    assert.notEqual(phoneId, laptopId);
    assert.equal(store.read(`choke_session=${phoneId}`)?.email, EMAIL);
    assert.equal(store.read(`choke_session=${phoneId}`)?.sub, SUB);
    assert.equal(store.read(`choke_session=${laptopId}`)?.sub, SUB);
    assert.equal(store.read(`choke_session=${otherId}`)?.sub, 'acct-other-2');
    store.revoke(`choke_session=${phoneId}`);
    assert.equal(store.read(`choke_session=${phoneId}`), null);
    assert.equal(store.read(`choke_session=${laptopId}`)?.email, EMAIL);
    clock = 10_000;
    assert.equal(store.read(`choke_session=${laptopId}`), null);
    assert.match(clearSessionCookie(false), /Max-Age=0/);
  });

  it('rejects desk routes without a session', () => {
    const store = createSessionStore();
    assert.equal(isPublicApi('GET', '/api/auth/config'), true);
    assert.equal(isPublicApi('GET', '/api/state'), false);
    assert.equal(isPublicApi('GET', '/api/chart'), false);
    assert.equal(isPublicApi('GET', '/api/backtest'), false);
    assert.equal(isPublicApi('POST', '/api/live/start'), false);
    const blocked = guardApi({ method: 'GET', pathname: '/api/state', cookie: undefined, store });
    assert.deepEqual(blocked, { ok: false, status: 401 });
    const issued = store.issue({ email: EMAIL, sub: SUB }, false);
    const id = /choke_session=([a-f0-9]{64})/.exec(issued.setCookie)?.[1];
    const open = guardApi({ method: 'GET', pathname: '/api/keys', cookie: `choke_session=${id}`, store });
    assert.deepEqual(open, { ok: true, email: EMAIL, sub: SUB });
  });

  it('blocks a cross-site post and limits sign-in attempts', () => {
    assert.equal(originAllowed({ origin: 'http://127.0.0.1:4173', host: '127.0.0.1:4173' }), true);
    assert.equal(originAllowed({ origin: 'https://evil.example', host: '127.0.0.1:4173' }), false);
    assert.equal(originAllowed({ secFetchSite: 'cross-site' }), false);
    assert.equal(originAllowed({ secFetchSite: 'same-origin' }), true);
    let clock = 0;
    const allow = createRateLimit({ limit: 2, windowMs: 1000, now: () => clock });
    assert.equal(allow('1.1.1.1'), true);
    assert.equal(allow('1.1.1.1'), true);
    assert.equal(allow('1.1.1.1'), false);
    clock = 1001;
    assert.equal(allow('1.1.1.1'), true);
  });

  it('keeps one desk view for both devices of the same account', () => {
    let view = emptyDeskView();
    view = applyDeskView(view, { pair: 'ETHUSDT', timeframe: 12, tradeId: 'ETHUSDT-1774599900000' });
    assert.equal(view.rev, 2);
    assert.equal(view.pair, 'ETHUSDT');
    assert.equal(view.timeframe, 12);
    assert.equal(view.tradeId, 'ETHUSDT-1774599900000');
    const same = applyDeskView(view, { pair: 'ETHUSDT' });
    assert.equal(same, view);
    const junk = applyDeskView(view, { pair: 'DOGEUSDT', timeframe: 99, tradeId: '../keys' });
    assert.equal(junk, view);
    const desks = createDeskStore();
    const owner = desks.apply(SUB, { pair: 'SOLUSDT', timeframe: 48 });
    const phone = desks.apply(SUB, { tradeId: 'SOLUSDT-1' });
    const stranger = desks.get('acct-other-2');
    assert.equal(owner.pair, 'SOLUSDT');
    assert.equal(phone.pair, 'SOLUSDT');
    assert.equal(desks.get(SUB).timeframe, 48);
    assert.equal(desks.get(SUB).tradeId, 'SOLUSDT-1');
    assert.equal(desks.get(SUB).rev, phone.rev);
    assert.equal(stranger.pair, 'BTCUSDT');
    assert.equal(stranger.tradeId, null);
    assert.notEqual(stranger.rev, desks.get(SUB).rev);
  });
});

describe('stored keys', () => {
  it('round-trips under KEY_SECRET and does not leave the secret in the status or the file', () => {
    const payload = { apiKey: 'mx-test-key-do-not-leak-abc', apiSecret: 'mx-test-secret-do-not-leak-xyz' };
    const blob = sealKeys(payload, 'machine-secret');
    assert.equal(blob.includes(Buffer.from(payload.apiKey)), false);
    assert.equal(blob.includes(Buffer.from(payload.apiSecret)), false);
    assert.deepEqual(openKeys(blob, 'machine-secret'), payload);
    assert.equal(openKeys(blob, 'other-secret'), null);
    const flipped = Buffer.from(blob);
    flipped[flipped.length - 1] ^= 1;
    assert.equal(openKeys(flipped, 'machine-secret'), null);
    const dir = mkdtempSync(join(tmpdir(), 'choke-keys-'));
    const path = join(dir, 'mexc-keys.enc');
    saveKeyFile(path, payload, 'machine-secret');
    const stored = readFileSync(path);
    assert.equal(stored.includes(Buffer.from(payload.apiKey)), false);
    assert.deepEqual(readKeyFile(path, 'machine-secret'), payload);
    const status = keyStatus('saved');
    assert.deepEqual(status, { configured: true, source: 'saved' });
    assert.equal(JSON.stringify(status).includes(payload.apiKey), false);
    assert.equal(JSON.stringify(keyStatus('none')).includes('apiSecret'), false);
    const left = accountKeyFile(dir, SUB);
    const right = accountKeyFile(dir, 'acct-other-2');
    assert.notEqual(left, right);
    assert.equal(left.includes(SUB), false);
    assert.match(left, /[a-f0-9]{64}\.enc$/);
    assert.match(right, /[a-f0-9]{64}\.enc$/);
  });
});
