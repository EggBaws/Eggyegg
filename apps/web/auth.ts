import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';
import { join } from 'node:path';

const COOKIE = 'choke_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_SEC = 60;

export interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
  use?: string;
}

export interface DeskView {
  rev: number;
  pair: 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT';
  timeframe: 1 | 3 | 12 | 48;
  tradeId: string | null;
}

export interface AccountSession {
  email: string;
  sub: string;
}

export interface SessionStore {
  issue(account: AccountSession, secure: boolean): { setCookie: string };
  read(cookieHeader: string | undefined): AccountSession | null;
  revoke(cookieHeader: string | undefined): void;
}

export interface DeskStore {
  get(sub: string): DeskView;
  apply(sub: string, patch: { pair?: unknown; timeframe?: unknown; tradeId?: unknown }): DeskView;
}

interface SessionRow {
  email: string;
  sub: string;
  exp: number;
}

export function allowedAccountEmail(envValue: string | undefined): string | null {
  const raw = (envValue ?? '').trim().toLowerCase();
  if (!raw || raw === '*' || raw === 'any') return null;
  return raw;
}

export function accountKeyFile(dir: string, sub: string): string {
  const id = createHash('sha256').update(sub).digest('hex');
  return join(dir, `${id}.enc`);
}

export const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const GROK_ISSUER = 'https://auth.x.ai';
const GROK_SCOPE = 'openid profile email';
const LOGIN_COOKIE = 'choke_login';

export function publicAuthConfig(): { provider: 'grok'; configured: boolean } {
  return { provider: 'grok', configured: true };
}

export function isPublicApi(method: string, pathname: string): boolean {
  if (method === 'GET' && pathname === '/api/auth/config') return true;
  if (method === 'GET' && pathname === '/api/auth/pending') return true;
  if (method === 'POST' && pathname === '/api/auth/google') return true;
  if (method === 'POST' && pathname === '/api/auth/poll') return true;
  if (method === 'POST' && pathname === '/api/auth/logout') return true;
  return false;
}

export function guardApi(input: {
  method: string;
  pathname: string;
  cookie: string | undefined;
  store: SessionStore;
}): { ok: true; email: string; sub: string } | { ok: false; status: 401 } {
  if (!input.pathname.startsWith('/api/')) return { ok: true, email: '', sub: '' };
  if (isPublicApi(input.method, input.pathname)) return { ok: true, email: '', sub: '' };
  const session = input.store.read(input.cookie);
  if (!session) return { ok: false, status: 401 };
  return { ok: true, email: session.email, sub: session.sub };
}

export function originAllowed(input: { origin?: string; host?: string; secFetchSite?: string }): boolean {
  const origin = (input.origin ?? '').trim();
  if (!origin) {
    const site = (input.secFetchSite ?? '').trim();
    return site === '' || site === 'same-origin' || site === 'none';
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const host = (input.host ?? '').trim();
  return host.length > 0 && parsed.host === host;
}

export function cookieIsSecure(input: { forwardedProto?: string }): boolean {
  return (input.forwardedProto ?? '').split(',')[0]?.trim() === 'https';
}

export function clearSessionCookie(secure: boolean): string {
  return serializeCookie('', secure, 0);
}

export function createRateLimit(opts: { limit: number; windowMs: number; now?: () => number }): (key: string) => boolean {
  const now = opts.now ?? (() => Date.now());
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const fresh = (hits.get(key) ?? []).filter((stamp) => now() - stamp < opts.windowMs);
    if (fresh.length >= opts.limit) {
      hits.set(key, fresh);
      return false;
    }
    fresh.push(now());
    hits.set(key, fresh);
    return true;
  };
}

export function createSessionStore(opts?: { now?: () => number; ttlMs?: number }): SessionStore {
  const now = opts?.now ?? (() => Date.now());
  const ttl = opts?.ttlMs ?? SESSION_TTL_MS;
  const rows = new Map<string, SessionRow>();

  function readId(cookieHeader: string | undefined): string | null {
    if (!cookieHeader) return null;
    const parts = cookieHeader.split(';');
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      if (name !== COOKIE) continue;
      const value = part.slice(eq + 1).trim();
      if (!/^[a-f0-9]{64}$/.test(value)) return null;
      return value;
    }
    return null;
  }

  return {
    issue(account: AccountSession, secure: boolean) {
      const id = randomBytes(32).toString('hex');
      rows.set(id, { email: account.email, sub: account.sub, exp: now() + ttl });
      return { setCookie: serializeCookie(id, secure, Math.floor(ttl / 1000)) };
    },
    read(cookieHeader: string | undefined) {
      const id = readId(cookieHeader);
      if (!id) return null;
      const row = rows.get(id);
      if (!row || row.exp <= now()) {
        if (row) rows.delete(id);
        return null;
      }
      row.exp = now() + ttl;
      return { email: row.email, sub: row.sub };
    },
    revoke(cookieHeader: string | undefined) {
      const id = readId(cookieHeader);
      if (id) rows.delete(id);
    },
  };
}

export function emptyDeskView(): DeskView {
  return { rev: 1, pair: 'BTCUSDT', timeframe: 1, tradeId: null };
}

export function createDeskStore(): DeskStore {
  const views = new Map<string, DeskView>();
  function get(sub: string): DeskView {
    let view = views.get(sub);
    if (!view) {
      view = emptyDeskView();
      views.set(sub, view);
    }
    return view;
  }
  return {
    get,
    apply(sub: string, patch: { pair?: unknown; timeframe?: unknown; tradeId?: unknown }) {
      const next = applyDeskView(get(sub), patch);
      views.set(sub, next);
      return next;
    },
  };
}

export function applyDeskView(current: DeskView, patch: { pair?: unknown; timeframe?: unknown; tradeId?: unknown }): DeskView {
  const next: DeskView = {
    rev: current.rev,
    pair: current.pair,
    timeframe: current.timeframe,
    tradeId: current.tradeId,
  };
  if (patch.pair === 'BTCUSDT' || patch.pair === 'ETHUSDT' || patch.pair === 'SOLUSDT') next.pair = patch.pair;
  if (patch.timeframe === 1 || patch.timeframe === 3 || patch.timeframe === 12 || patch.timeframe === 48) {
    next.timeframe = patch.timeframe;
  }
  if (patch.tradeId === null) next.tradeId = null;
  else if (typeof patch.tradeId === 'string' && patch.tradeId.length <= 80 && /^[A-Za-z0-9._:-]+$/.test(patch.tradeId)) {
    next.tradeId = patch.tradeId;
  }
  if (next.pair === current.pair && next.timeframe === current.timeframe && next.tradeId === current.tradeId) return current;
  next.rev = current.rev + 1;
  return next;
}

export interface GrokLogin {
  begin(secure: boolean): Promise<
    | { ok: true; setCookie: string; verificationUrl: string; intervalSec: number }
    | { ok: false; error: string }
  >;
  pending(cookieHeader: string | undefined): { pending: boolean; verificationUrl?: string };
  finish(cookieHeader: string | undefined, secure: boolean): Promise<
    | { ok: true; pending: true; intervalSec: number }
    | { ok: true; pending: false; email: string; sub: string; setCookie: string; clearLogin: string }
    | { ok: false; error: string; clearLogin?: string }
  >;
}

export function createGrokLogin(opts?: {
  now?: () => number;
  clientId?: string;
  allowedEmail?: string | null;
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; body: unknown }>;
  certs?: () => Promise<Jwk[]>;
}): GrokLogin {
  const now = opts?.now ?? (() => Date.now());
  const clientId = opts?.clientId ?? GROK_CLIENT_ID;
  const allowedEmail = opts?.allowedEmail ?? null;
  const fetchImpl = opts?.fetchImpl ?? defaultFetch;
  const certs = opts?.certs;
  const rows = new Map<string, { deviceCode: string; verificationUrl: string; intervalSec: number; exp: number }>();

  function readLoginId(cookieHeader: string | undefined): string | null {
    return readCookie(cookieHeader, LOGIN_COOKIE);
  }

  return {
    async begin(secure: boolean) {
      const started = await fetchImpl('https://auth.x.ai/oauth2/device/code', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, scope: GROK_SCOPE }).toString(),
      });
      const payload = asRecord(started.body);
      const deviceCode = typeof payload.device_code === 'string' ? payload.device_code : '';
      const verificationUrl = typeof payload.verification_uri_complete === 'string'
        ? payload.verification_uri_complete
        : typeof payload.verification_uri === 'string'
          ? payload.verification_uri
          : '';
      const intervalSec = typeof payload.interval === 'number' && payload.interval > 0 ? payload.interval : 5;
      const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 0;
      if (started.status !== 200 || !deviceCode || !verificationUrl.startsWith('https://accounts.x.ai/')) {
        return { ok: false, error: 'Sign-in did not start.' };
      }
      const id = randomBytes(32).toString('hex');
      rows.set(id, { deviceCode, verificationUrl, intervalSec, exp: now() + expiresIn * 1000 });
      return {
        ok: true,
        setCookie: serializeNamedCookie(LOGIN_COOKIE, id, secure, expiresIn),
        verificationUrl,
        intervalSec,
      };
    },
    pending(cookieHeader: string | undefined) {
      const row = currentRow(rows, readLoginId(cookieHeader), now);
      if (!row) return { pending: false };
      return { pending: true, verificationUrl: row.verificationUrl };
    },
    async finish(cookieHeader: string | undefined, secure: boolean) {
      const id = readLoginId(cookieHeader);
      const row = currentRow(rows, id, now);
      if (!id || !row) return { ok: false, error: 'Sign-in expired. Try again.', clearLogin: clearNamedCookie(LOGIN_COOKIE, secure) };
      const token = await fetchImpl('https://auth.x.ai/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: clientId,
          device_code: row.deviceCode,
        }).toString(),
      });
      const payload = asRecord(token.body);
      if (payload.error === 'authorization_pending' || payload.error === 'slow_down') {
        if (payload.error === 'slow_down') row.intervalSec += 5;
        return { ok: true, pending: true, intervalSec: row.intervalSec };
      }
      rows.delete(id);
      const clearLogin = clearNamedCookie(LOGIN_COOKIE, secure);
      if (token.status !== 200 || typeof payload.id_token !== 'string') {
        return { ok: false, error: 'Sign-in failed.', clearLogin };
      }
      const verdict = await verifyXaiIdToken(payload.id_token, { clientId, allowedEmail, now, certs });
      if (!verdict.ok) return { ok: false, error: 'Sign-in failed.', clearLogin };
      return { ok: true, pending: false, email: verdict.email, sub: verdict.sub, setCookie: '', clearLogin };
    },
  };
}

export async function verifyXaiIdToken(
  token: string,
  opts: {
    clientId?: string;
    allowedEmail: string | null;
    now?: () => number;
    certs?: () => Promise<Jwk[]>;
  },
): Promise<{ ok: true; email: string; sub: string } | { ok: false; error: string }> {
  const now = opts.now ?? (() => Date.now());
  const clientId = opts.clientId ?? GROK_CLIENT_ID;
  if (typeof token !== 'string' || token.length < 20 || token.length > 8192) return { ok: false, error: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1]) return { ok: false, error: 'malformed' };
  let header: { alg?: unknown; kid?: unknown };
  let claims: {
    iss?: unknown;
    aud?: unknown;
    exp?: unknown;
    iat?: unknown;
    email?: unknown;
    email_verified?: unknown;
    sub?: unknown;
  };
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as typeof header;
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as typeof claims;
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (header.alg !== 'ES256' || typeof header.kid !== 'string' || !header.kid) return { ok: false, error: 'alg' };
  if (!parts[2]) return { ok: false, error: 'signature' };
  const certs = opts.certs ?? (() => fetchXaiKeys(now));
  const keys = await certs();
  const jwk = keys.find((key) => key.kid === header.kid && key.kty === 'EC');
  if (!jwk) return { ok: false, error: 'signature' };
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  try {
    const signature = Buffer.from(parts[2], 'base64url');
    const key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
    const valid = cryptoVerify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, signature);
    if (!valid) return { ok: false, error: 'signature' };
  } catch {
    return { ok: false, error: 'signature' };
  }
  const nowSec = Math.floor(now() / 1000);
  if (claims.iss !== GROK_ISSUER) return { ok: false, error: 'issuer' };
  const audOk = claims.aud === clientId || (Array.isArray(claims.aud) && claims.aud.includes(clientId));
  if (!audOk) return { ok: false, error: 'audience' };
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SEC < nowSec) return { ok: false, error: 'expired' };
  if (typeof claims.iat !== 'number' || claims.iat > nowSec + CLOCK_SKEW_SEC) return { ok: false, error: 'expired' };
  if (claims.email_verified === false || claims.email_verified === 'false') return { ok: false, error: 'unverified' };
  if (typeof claims.email !== 'string') return { ok: false, error: 'email' };
  const email = claims.email.trim().toLowerCase();
  if (!email || !email.includes('@')) return { ok: false, error: 'email' };
  if (opts.allowedEmail !== null && !emailsMatch(email, opts.allowedEmail.trim().toLowerCase())) {
    return { ok: false, error: 'email' };
  }
  if (typeof claims.sub !== 'string') return { ok: false, error: 'sub' };
  const sub = claims.sub.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sub)) return { ok: false, error: 'sub' };
  return { ok: true, email, sub };
}

export async function accountFromGateToken(
  token: string,
  opts?: { allowedEmail?: string | null; now?: () => number; certs?: () => Promise<Jwk[]> },
): Promise<AccountSession | null> {
  const verdict = await verifyXaiIdToken(token, {
    allowedEmail: opts?.allowedEmail ?? null,
    now: opts?.now,
    certs: opts?.certs,
  });
  if (!verdict.ok) return null;
  return { email: verdict.email, sub: verdict.sub };
}

let certCache: { keys: Jwk[]; exp: number } | null = null;

async function fetchXaiKeys(now: () => number): Promise<Jwk[]> {
  if (certCache && certCache.exp > now()) return certCache.keys;
  const res = await fetch('https://auth.x.ai/.well-known/jwks.json');
  if (!res.ok) return certCache?.keys ?? [];
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  const cacheControl = res.headers.get('cache-control') ?? '';
  const match = /max-age=(\d+)/.exec(cacheControl);
  const maxAge = Math.min(Number(match?.[1] ?? 3600), 86_400);
  certCache = { keys, exp: now() + Math.max(60, maxAge) * 1000 };
  return keys;
}

async function defaultFetch(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const body: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function currentRow(
  rows: Map<string, { deviceCode: string; verificationUrl: string; intervalSec: number; exp: number }>,
  id: string | null,
  now: () => number,
): { deviceCode: string; verificationUrl: string; intervalSec: number; exp: number } | null {
  if (!id) return null;
  const row = rows.get(id);
  if (!row || row.exp <= now()) {
    if (row) rows.delete(id);
    return null;
  }
  return row;
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    if (!/^[a-f0-9]{64}$/.test(value)) return null;
    return value;
  }
  return null;
}

function emailsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function serializeCookie(value: string, secure: boolean, maxAge: number): string {
  return serializeNamedCookie(COOKIE, value, secure, maxAge);
}

export function clearLoginCookie(secure: boolean): string {
  return clearNamedCookie(LOGIN_COOKIE, secure);
}

function serializeNamedCookie(name: string, value: string, secure: boolean, maxAge: number): string {
  const parts = [`${name}=${value}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${Math.max(0, Math.floor(maxAge))}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearNamedCookie(name: string, secure: boolean): string {
  return serializeNamedCookie(name, '', secure, 0);
}
