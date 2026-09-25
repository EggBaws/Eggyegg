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

export function publicAuthConfig(clientId: string | undefined): { clientId: string | null; configured: boolean } {
  const value = (clientId ?? '').trim();
  const ok = /^[0-9A-Za-z_-]+\.apps\.googleusercontent\.com$/.test(value);
  return { clientId: ok ? value : null, configured: ok };
}

export function isPublicApi(method: string, pathname: string): boolean {
  if (method === 'GET' && pathname === '/api/auth/config') return true;
  if (method === 'POST' && pathname === '/api/auth/google') return true;
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

export async function verifyGoogleIdToken(
  token: string,
  opts: {
    clientId: string;
    allowedEmail: string | null;
    now?: () => number;
    certs?: () => Promise<Jwk[]>;
  },
): Promise<{ ok: true; email: string; sub: string } | { ok: false; error: string }> {
  const now = opts.now ?? (() => Date.now());
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return { ok: false, error: 'malformed' };
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
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return { ok: false, error: 'alg' };
  if (!parts[2]) return { ok: false, error: 'signature' };
  const certs = opts.certs ?? (() => fetchGoogleCerts(now));
  const keys = await certs();
  const jwk = keys.find((key) => key.kid === header.kid && key.kty === 'RSA');
  if (!jwk) return { ok: false, error: 'signature' };
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  let signature: Buffer;
  try {
    signature = Buffer.from(parts[2], 'base64url');
    const key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
    const valid = cryptoVerify('RSA-SHA256', signed, key, signature);
    if (!valid) return { ok: false, error: 'signature' };
  } catch {
    return { ok: false, error: 'signature' };
  }
  const nowSec = Math.floor(now() / 1000);
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') return { ok: false, error: 'issuer' };
  const audOk = claims.aud === opts.clientId || (Array.isArray(claims.aud) && claims.aud.includes(opts.clientId));
  if (!audOk) return { ok: false, error: 'audience' };
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SEC < nowSec) return { ok: false, error: 'expired' };
  if (typeof claims.iat !== 'number' || claims.iat > nowSec + CLOCK_SKEW_SEC) return { ok: false, error: 'expired' };
  if (claims.email_verified !== true && claims.email_verified !== 'true') return { ok: false, error: 'unverified' };
  if (typeof claims.email !== 'string') return { ok: false, error: 'email' };
  const email = claims.email.trim().toLowerCase();
  if (!email) return { ok: false, error: 'email' };
  if (opts.allowedEmail !== null && !emailsMatch(email, opts.allowedEmail.trim().toLowerCase())) {
    return { ok: false, error: 'email' };
  }
  if (typeof claims.sub !== 'string') return { ok: false, error: 'sub' };
  const sub = claims.sub.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sub)) return { ok: false, error: 'sub' };
  return { ok: true, email, sub };
}

let certCache: { keys: Jwk[]; exp: number } | null = null;

async function fetchGoogleCerts(now: () => number): Promise<Jwk[]> {
  if (certCache && certCache.exp > now()) return certCache.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) return certCache?.keys ?? [];
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  const cacheControl = res.headers.get('cache-control') ?? '';
  const match = /max-age=(\d+)/.exec(cacheControl);
  const maxAge = Math.min(Number(match?.[1] ?? 3600), 86_400);
  certCache = { keys, exp: now() + Math.max(60, maxAge) * 1000 };
  return keys;
}

function emailsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function serializeCookie(value: string, secure: boolean, maxAge: number): string {
  const parts = [`${COOKIE}=${value}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
