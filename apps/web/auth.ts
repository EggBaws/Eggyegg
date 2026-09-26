import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  const site = (input.secFetchSite ?? '').trim();
  if (site === 'cross-site') return false;
  // The browser sets this. A page on the published host is same-origin even when the proxy rewrites Host.
  if (site === 'same-origin') return true;
  const origin = (input.origin ?? '').trim();
  if (!origin) return site === '' || site === 'none';
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

export function createSessionStore(opts?: { now?: () => number; ttlMs?: number; storePath?: string }): SessionStore {
  const now = opts?.now ?? (() => Date.now());
  const ttl = opts?.ttlMs ?? SESSION_TTL_MS;
  const storePath = opts?.storePath;
  const rows = storePath ? readSessionFile(storePath, now()) : new Map<string, SessionRow>();

  function persist(): void {
    if (!storePath) return;
    try {
      writeSessionFile(storePath, rows);
    } catch {
      // A read-only disk still keeps the session for this process.
    }
  }

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
      persist();
      return { setCookie: serializeCookie(id, secure, Math.floor(ttl / 1000)) };
    },
    read(cookieHeader: string | undefined) {
      const id = readId(cookieHeader);
      if (!id) return null;
      const row = rows.get(id);
      if (!row || row.exp <= now()) {
        if (row) {
          rows.delete(id);
          persist();
        }
        return null;
      }
      row.exp = now() + ttl;
      return { email: row.email, sub: row.sub };
    },
    revoke(cookieHeader: string | undefined) {
      const id = readId(cookieHeader);
      if (id && rows.delete(id)) persist();
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
  pending(cookieHeader: string | undefined): { pending: boolean; verificationUrl?: string; intervalSec?: number };
  finish(cookieHeader: string | undefined, secure: boolean): Promise<
    | { ok: true; pending: true; intervalSec: number; setCookie?: string }
    | { ok: true; pending: false; email: string; sub: string; session: string; clearLogin: string }
    | { ok: true; pending: false }
    | { ok: false; error: string; clearLogin?: string }
  >;
}

interface LoginRow {
  deviceCode: string;
  verificationUrl: string;
  intervalSec: number;
  exp: number;
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
      const intervalSec = typeof payload.interval === 'number' && payload.interval > 0 ? Math.min(payload.interval, 60) : 5;
      const expiresIn = loginLifetimeSec(payload.expires_in);
      if (started.status !== 200 || !deviceCode || !verificationUrl.startsWith('https://accounts.x.ai/')) {
        return { ok: false, error: 'Sign-in did not start.' };
      }
      const row: LoginRow = { deviceCode, verificationUrl, intervalSec, exp: now() + expiresIn * 1000 };
      return {
        ok: true,
        setCookie: serializeNamedCookie(LOGIN_COOKIE, encodeTicket(row), secure, expiresIn),
        verificationUrl,
        intervalSec,
      };
    },
    pending(cookieHeader: string | undefined) {
      const found = loginFromCookie(cookieHeader, now());
      if (!found || found.expired) return { pending: false };
      return { pending: true, verificationUrl: found.row.verificationUrl, intervalSec: found.row.intervalSec };
    },
    async finish(cookieHeader: string | undefined, secure: boolean) {
      const found = loginFromCookie(cookieHeader, now());
      if (!found) return { ok: true, pending: false };
      if (found.expired) {
        return { ok: false, error: 'Sign-in expired. Try again.', clearLogin: clearNamedCookie(LOGIN_COOKIE, secure) };
      }
      const row = found.row;
      let token: { status: number; body: unknown };
      try {
        token = await fetchImpl('https://auth.x.ai/oauth2/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: clientId,
            device_code: row.deviceCode,
          }).toString(),
        });
      } catch {
        return { ok: true, pending: true, intervalSec: row.intervalSec };
      }
      const payload = asRecord(token.body);
      const err = typeof payload.error === 'string' ? payload.error : '';
      if (token.status >= 500 || err === 'temporarily_unavailable') {
        return { ok: true, pending: true, intervalSec: row.intervalSec };
      }
      if (err === 'authorization_pending') {
        return { ok: true, pending: true, intervalSec: row.intervalSec };
      }
      if (err === 'slow_down') {
        const intervalSec = Math.min(row.intervalSec + 5, 60);
        const next: LoginRow = { ...row, intervalSec };
        const life = Math.max(1, Math.ceil((row.exp - now()) / 1000));
        return {
          ok: true,
          pending: true,
          intervalSec,
          setCookie: serializeNamedCookie(LOGIN_COOKIE, encodeTicket(next), secure, life),
        };
      }
      const clearLogin = clearNamedCookie(LOGIN_COOKIE, secure);
      if (err === 'expired_token') return { ok: false, error: 'Sign-in expired. Try again.', clearLogin };
      if (token.status !== 200 || typeof payload.id_token !== 'string') {
        return { ok: false, error: 'Sign-in failed.', clearLogin };
      }
      const verdict = await verifyXaiIdToken(payload.id_token, { clientId, allowedEmail, now, certs });
      if (!verdict.ok) return { ok: false, error: 'Sign-in failed.', clearLogin };
      return { ok: true, pending: false, email: verdict.email, sub: verdict.sub, session: payload.id_token, clearLogin };
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

function loginLifetimeSec(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : 0;
  if (!Number.isFinite(parsed) || parsed <= 0) return 900;
  return Math.min(Math.floor(parsed), 3600);
}

function readSessionFile(path: string, nowMs: number): Map<string, SessionRow> {
  const rows = new Map<string, SessionRow>();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return rows;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return rows;
  for (const [id, value] of Object.entries(raw)) {
    if (!/^[a-f0-9]{64}$/.test(id) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Partial<SessionRow>;
    if (typeof row.email !== 'string' || !row.email.includes('@')) continue;
    if (typeof row.sub !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.sub)) continue;
    if (typeof row.exp !== 'number' || row.exp <= nowMs) continue;
    rows.set(id, { email: row.email, sub: row.sub, exp: row.exp });
  }
  return rows;
}

function writeSessionFile(path: string, rows: Map<string, SessionRow>): void {
  const body: Record<string, SessionRow> = {};
  for (const [id, row] of rows) body[id] = row;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function encodeTicket(row: LoginRow): string {
  return Buffer.from(JSON.stringify(row)).toString('base64url');
}

function loginFromCookie(cookieHeader: string | undefined, nowMs: number): { row: LoginRow; expired: false } | { expired: true } | null {
  const value = readNamedCookie(cookieHeader, LOGIN_COOKIE);
  if (!value) return null;
  if (value.length < 20 || value.length > 3500 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Partial<LoginRow>;
  if (typeof row.deviceCode !== 'string' || row.deviceCode.length < 8 || row.deviceCode.length > 512) return null;
  if (typeof row.verificationUrl !== 'string' || !row.verificationUrl.startsWith('https://accounts.x.ai/')) return null;
  if (typeof row.exp !== 'number' || !Number.isFinite(row.exp)) return null;
  if (row.exp <= nowMs) return { expired: true };
  const intervalSec = typeof row.intervalSec === 'number' && row.intervalSec > 0 ? Math.min(row.intervalSec, 60) : 5;
  return {
    expired: false,
    row: { deviceCode: row.deviceCode, verificationUrl: row.verificationUrl, intervalSec, exp: row.exp },
  };
}

function readNamedCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    if (!value || value.length > 3500) return null;
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

/** The published host drops Set-Cookie, so the page sends the login ticket back itself. */
export function loginCookieFromClient(ticket: unknown, cookieHeader: string | undefined): string | undefined {
  if (typeof ticket === 'string' && /^[A-Za-z0-9_-]{20,3500}$/.test(ticket)) return `${LOGIN_COOKIE}=${ticket}`;
  return cookieHeader;
}

function serializeNamedCookie(name: string, value: string, secure: boolean, maxAge: number): string {
  const parts = [`${name}=${value}`, 'HttpOnly', 'Path=/', `Max-Age=${Math.max(0, Math.floor(maxAge))}`];
  if (secure) parts.push('Secure');
  parts.push('SameSite=Lax');
  return parts.join('; ');
}

function clearNamedCookie(name: string, secure: boolean): string {
  return serializeNamedCookie(name, '', secure, 0);
}
