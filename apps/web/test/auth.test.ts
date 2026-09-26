import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  GROK_CLIENT_ID,
  accountFromGateToken,
  accountKeyFile,
  allowedAccountEmail,
  applyDeskView,
  clearSessionCookie,
  createDeskStore,
  createGrokLogin,
  createRateLimit,
  createSessionStore,
  emptyDeskView,
  guardApi,
  isPublicApi,
  loginCookieFromClient,
  originAllowed,
  publicAuthConfig,
  verifyXaiIdToken,
  type Jwk,
} from '../auth.ts';
import { keyStatus, openKeys, readKeyFile, saveKeyFile, sealKeys } from '../secrets.ts';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' }) as Jwk & JsonWebKey;
jwk.kid = 'test-ec';
jwk.alg = 'ES256';
jwk.use = 'sig';

const EMAIL = 'person@gmail.com';
const SUB = 'acct-owner-1';
const NOW = 1_800_000_000_000;

function mint(claims: Record<string, unknown>, opts?: { alg?: string; tamper?: boolean; kid?: string }): string {
  const header = { alg: opts?.alg ?? 'ES256', kid: opts?.kid ?? 'test-ec', typ: 'JWT' };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const data = `${h}.${body}`;
  if (header.alg === 'none') return `${data}.`;
  const sig = sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  if (!opts?.tamper) return `${data}.${sig}`;
  const forged = Buffer.from(JSON.stringify({ ...claims, email: 'other@example.com' })).toString('base64url');
  return `${h}.${forged}.${sig}`;
}

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://auth.x.ai',
    aud: GROK_CLIENT_ID,
    exp: Math.floor(NOW / 1000) + 3600,
    iat: Math.floor(NOW / 1000),
    email: EMAIL,
    email_verified: true,
    sub: SUB,
    ...over,
  };
}

function jsonResponse(status: number, body: unknown): { status: number; body: unknown } {
  return { status, body };
}

function loginHeader(setCookie: string): string {
  const value = /choke_login=([^;]+)/.exec(setCookie)?.[1];
  if (!value) throw new Error('login cookie missing');
  return `choke_login=${value}`;
}

describe('Grok sign-in', () => {
  const opts = { allowedEmail: null as string | null, now: () => NOW, certs: async () => [jwk] };

  it('accepts a Grok identity token and any verified account', async () => {
    const verdict = await verifyXaiIdToken(mint(claims()), opts);
    assert.deepEqual(verdict, { ok: true, email: EMAIL, sub: SUB });
    assert.equal(allowedAccountEmail(undefined), null);
    assert.equal(allowedAccountEmail(''), null);
    assert.equal(allowedAccountEmail('*'), null);
    const other = await verifyXaiIdToken(mint(claims({ email: 'someone@gmail.com', sub: 'acct-other-2' })), opts);
    assert.deepEqual(other, { ok: true, email: 'someone@gmail.com', sub: 'acct-other-2' });
    const gate = await accountFromGateToken(mint(claims()), opts);
    assert.deepEqual(gate, { email: EMAIL, sub: SUB });
    assert.equal(await accountFromGateToken(mint(claims(), { tamper: true }), opts), null);
  });

  it('rejects another account when locked, an expired token, alg none, and a tampered signature', async () => {
    const locked = { ...opts, allowedEmail: EMAIL };
    const wrong = await verifyXaiIdToken(mint(claims({ email: 'someone@gmail.com' })), locked);
    const expired = await verifyXaiIdToken(mint(claims({ exp: Math.floor(NOW / 1000) - 120 })), opts);
    const none = await verifyXaiIdToken(mint(claims(), { alg: 'none' }), opts);
    const tampered = await verifyXaiIdToken(mint(claims(), { tamper: true }), opts);
    const unverified = await verifyXaiIdToken(mint(claims({ email_verified: false })), opts);
    assert.equal(wrong.ok, false);
    assert.equal(expired.ok, false);
    assert.equal(none.ok, false);
    assert.equal(tampered.ok, false);
    assert.equal(unverified.ok, false);
    if (!wrong.ok) assert.equal(wrong.error, 'email');
    if (!none.ok) assert.equal(none.error, 'alg');
    if (!tampered.ok) assert.equal(tampered.error, 'signature');
  });

  it('starts Continue with Google through Grok and keeps the device secret on the server', async () => {
    let polls = 0;
    const login = createGrokLogin({
      now: () => NOW,
      allowedEmail: null,
      certs: async () => [jwk],
      fetchImpl: async (url) => {
        if (url.endsWith('/device/code')) {
          return jsonResponse(200, {
            device_code: 'device-secret',
            user_code: 'ABCD-EFGH',
            verification_uri_complete: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH',
            expires_in: 60,
            interval: 5,
          });
        }
        polls += 1;
        if (polls === 1) return jsonResponse(400, { error: 'authorization_pending' });
        return jsonResponse(200, {
          id_token: mint(claims()),
          access_token: 'should-not-leak',
          refresh_token: 'should-not-leak',
        });
      },
    });
    const started = await login.begin(false);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.verificationUrl.startsWith('https://accounts.x.ai/'), true);
    assert.equal(JSON.stringify(started).includes('device-secret'), false);
    assert.match(started.setCookie, /choke_login=/);
    assert.match(started.setCookie, /HttpOnly/);
    assert.match(started.setCookie, /SameSite=Lax/);
    assert.doesNotMatch(started.setCookie, /SameSite=None/);
    assert.equal(started.setCookie.includes(EMAIL), false);
    assert.equal(started.setCookie.includes('device-secret'), false);
    const cookie = loginHeader(started.setCookie);
    const waiting = await login.finish(cookie, false);
    assert.deepEqual(waiting, { ok: true, pending: true, intervalSec: 5 });
    const done = await login.finish(cookie, false);
    assert.equal(done.ok, true);
    if (!done.ok || done.pending) return;
    assert.equal(done.email, EMAIL);
    assert.equal(done.sub, SUB);
    assert.equal(typeof done.session, 'string');
    assert.equal(done.session.split('.').length, 3);
    assert.equal(JSON.stringify(done).includes('should-not-leak'), false);
    assert.equal(JSON.stringify(done).includes('device-secret'), false);
    assert.match(done.clearLogin, /Max-Age=0/);
    assert.equal(login.pending(undefined).pending, false);
  });

  it('opens a waiting Google login from the cookie alone once authorised', async () => {
    let stage = 'wait';
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/device/code')) {
        return jsonResponse(200, {
          device_code: 'device-secret',
          verification_uri_complete: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH',
          expires_in: '1800',
          interval: 5,
        });
      }
      if (stage === 'wait') return jsonResponse(500, { error: 'temporarily_unavailable' });
      if (stage === 'slow') return jsonResponse(400, { error: 'slow_down' });
      if (stage === 'dead') return jsonResponse(400, { error: 'expired_token' });
      return jsonResponse(200, { id_token: mint(claims()) });
    };
    const first = createGrokLogin({ now: () => NOW, allowedEmail: null, certs: async () => [jwk], fetchImpl });
    const started = await first.begin(true);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.match(started.setCookie, /Max-Age=1800/);
    assert.match(started.setCookie, /Secure/);
    assert.match(started.setCookie, /SameSite=Lax/);
    assert.doesNotMatch(started.setCookie, /Partitioned/);
    assert.equal(started.setCookie.includes('device-secret'), false);
    const cookie = loginHeader(started.setCookie);
    const waiting = await first.finish(cookie, true);
    assert.deepEqual(waiting, { ok: true, pending: true, intervalSec: 5 });
    const idle = await first.finish(undefined, true);
    assert.deepEqual(idle, { ok: true, pending: false });
    assert.equal(JSON.stringify(idle).includes('clearLogin'), false);
    stage = 'slow';
    const slowed = await first.finish(cookie, true);
    assert.equal(slowed.ok && slowed.pending && slowed.intervalSec, 10);
    if (!slowed.ok || !slowed.pending || !slowed.setCookie) return;
    assert.match(slowed.setCookie, /SameSite=Lax/);
    const next = loginHeader(slowed.setCookie);
    stage = 'dead';
    const dead = await first.finish(next, true);
    assert.equal(dead.ok, false);
    if (dead.ok) return;
    assert.equal(dead.error, 'Sign-in expired. Try again.');
    assert.match(dead.clearLogin ?? '', /Max-Age=0/);
    stage = 'done';
    const restarted = createGrokLogin({ now: () => NOW, allowedEmail: null, certs: async () => [jwk], fetchImpl });
    assert.equal(restarted.pending(cookie).pending, true);
    assert.equal(restarted.pending(cookie).intervalSec, 5);
    const done = await restarted.finish(cookie, true);
    assert.equal(done.ok, true);
    if (!done.ok || done.pending) return;
    assert.equal(done.email, EMAIL);
    assert.match(done.clearLogin, /Max-Age=0/);
    assert.equal(restarted.pending(undefined).pending, false);
  });

  it('still waits when the device response omits expires_in', async () => {
    const login = createGrokLogin({
      now: () => NOW,
      fetchImpl: async (url) => {
        if (url.endsWith('/device/code')) {
          return jsonResponse(200, {
            device_code: 'device-secret',
            verification_uri_complete: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH',
          });
        }
        return jsonResponse(400, { error: 'authorization_pending' });
      },
    });
    const started = await login.begin(false);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.match(started.setCookie, /Max-Age=900/);
    const waiting = await login.finish(loginHeader(started.setCookie), false);
    assert.equal(waiting.ok && waiting.pending, true);
  });

  it('does not publish an email or a Google client id in the sign-in config', () => {
    const cfg = publicAuthConfig();
    assert.deepEqual(cfg, { provider: 'grok', configured: true });
    assert.equal(JSON.stringify(cfg).includes(EMAIL), false);
    assert.equal(JSON.stringify(cfg).includes('googleusercontent'), false);
    assert.equal(isPublicApi('POST', '/api/auth/google'), true);
    assert.equal(isPublicApi('POST', '/api/auth/poll'), true);
    assert.equal(isPublicApi('GET', '/api/auth/pending'), true);
    assert.equal(loginCookieFromClient('not a ticket', 'choke_login=abc'), 'choke_login=abc');
    assert.equal(loginCookieFromClient('abc', undefined), undefined);
    const ticket = 'a'.repeat(40);
    assert.equal(loginCookieFromClient(ticket, undefined), `choke_login=${ticket}`);
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
    assert.match(laptop.setCookie, /SameSite=Lax/);
    assert.doesNotMatch(laptop.setCookie, /SameSite=None/);
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
    const dir = mkdtempSync(join(tmpdir(), 'choke-session-'));
    const path = join(dir, 'sessions.json');
    const kept = createSessionStore({ now: () => 5_000, ttlMs: 60_000, storePath: path });
    const issued = kept.issue({ email: EMAIL, sub: SUB }, true);
    assert.equal(readFileSync(path, 'utf8').includes(EMAIL), true);
    assert.equal(readFileSync(path, 'utf8').includes('apiSecret'), false);
    const again = createSessionStore({ now: () => 5_000, ttlMs: 60_000, storePath: path });
    const sid = /choke_session=([a-f0-9]{64})/.exec(issued.setCookie)?.[1];
    assert.equal(again.read(`choke_session=${sid}`)?.email, EMAIL);
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
    assert.equal(originAllowed({ origin: 'https://gogo.grok.me', host: '10.0.0.8:8080', secFetchSite: 'same-origin' }), true);
    assert.equal(originAllowed({ origin: 'https://evil.example', host: 'gogo.grok.me', secFetchSite: 'cross-site' }), false);
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
