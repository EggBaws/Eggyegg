import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChokeEngine, demoBook, loadConfig, slotStake, type Candle, type MarketUpdate, type PairId } from '../../packages/engine/src/index.ts';
import { ConsoleFileNotifier } from '../../packages/notify/src/index.ts';
import {
  createMexcLive,
  createVenue,
  fetchMexcKlines,
  liveArmGate,
  liveStopGate,
  openMexcTape,
  type MexcLiveAdapter,
  type MexcTape,
  type TapeEvent,
} from '../../packages/venues/src/index.ts';
import {
  accountFromGateToken,
  accountKeyFile,
  allowedAccountEmail,
  clearLoginCookie,
  clearSessionCookie,
  cookieIsSecure,
  createDeskStore,
  createGrokLogin,
  createRateLimit,
  createSessionStore,
  loginCookieFromClient,
  originAllowed,
  publicAuthConfig,
} from './auth.ts';
import { keyStatus, readKeyFile, removeKeyFile, saveKeyFile, validKeyMaterial, type StoredKeys } from './secrets.ts';
import configJson from '../../config/default.json' with { type: 'json' };
import backtestJson from '../../logs/backtest.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));

function runtimeRoot(): string {
  const sourceRoot = join(here, '../..');
  if (existsSync(join(sourceRoot, 'config/default.json'))) return sourceRoot;
  const dir = '/tmp/choke-desk';
  mkdirSync(join(dir, 'config'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  const cfg = join(dir, 'config/default.json');
  if (!existsSync(cfg)) writeFileSync(cfg, JSON.stringify(configJson));
  const backtest = join(dir, 'logs/backtest.json');
  if (!existsSync(backtest)) writeFileSync(backtest, JSON.stringify(backtestJson));
  return dir;
}

const root = runtimeRoot();
const publicDir = existsSync(join(here, 'public')) ? join(here, 'public') : join(root, 'public');
const config = loadConfig(join(root, 'config/default.json'));
const SYMBOL: Record<PairId, string> = {
  BTCUSDT: 'BTC_USDT',
  ETHUSDT: 'ETH_USDT',
  SOLUSDT: 'SOL_USDT',
};
const PAIR_OF: Record<string, PairId> = {
  BTC_USDT: 'BTCUSDT',
  ETH_USDT: 'ETHUSDT',
  SOL_USDT: 'SOLUSDT',
};
const FIVE = 300_000;
const HOUR = 3_600_000;
const ENGINE_BARS = 400;
const CHART_BARS = 1_500;

function abs(path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

const notifier = new ConsoleFileNotifier(abs(config.notify_log), config.notify_debounce_ms);
const dryRunPath = abs(config.dry_run_log);
const stub = createVenue(config.active_venue);

function bootDemo(): ChokeEngine {
  return new ChokeEngine({
    config,
    venue: stub,
    notifier,
    dryRunPath,
    balanceScale: {
      slots: config.balance_slots,
      reserveFrac: config.balance_reserve_frac,
      startUsdt: config.balance_start_usdt,
    },
  });
}

interface PairBook {
  m5: Candle[];
  h1: Candle[];
  lastPrice: number;
}

let engine = bootDemo();
let mode: 'demo' | 'market' = 'demo';
let liveVenue: MexcLiveAdapter | null = null;
let tape: MexcTape | null = null;
let books = new Map<PairId, PairBook>();
let tapeMessage = 'Live fires are off. The desk is connecting to the MEXC tape.';
let chain: Promise<void> = Promise.resolve();
let staleTimer: ReturnType<typeof setTimeout> | null = null;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
};
const BODY_LIMIT = 8192;
const userKeyDir = join(root, 'data/users');
const sessions = createSessionStore({ storePath: join(root, 'data/sessions.json') });
const desks = createDeskStore();
const grokLogin = createGrokLogin({
  allowedEmail: allowedAccountEmail(process.env.GOOGLE_ALLOWED_EMAIL),
});
const loginLimit = createRateLimit({ limit: 8, windowMs: 15 * 60 * 1000 });
let liveOwner: string | null = null;
const SECURITY: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "frame-src 'none'",
    "connect-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'cross-origin-opener-policy': 'same-origin-allow-popups',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};

function enqueue(job: () => Promise<void>): void {
  chain = chain.then(job, job);
}

function sendJson(res: ServerResponse, body: unknown, status = 200, extra?: Record<string, string | string[]>): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY, ...extra });
  res.end(raw);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('BODY_LIMIT'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function headerValue(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function requestSecure(req: IncomingMessage): boolean {
  return cookieIsSecure({ forwardedProto: headerValue(req, 'x-forwarded-proto') });
}

function resolveTradingKeys(sub: string): { keys: StoredKeys | null; source: 'saved' | 'none'; error?: string } {
  const path = accountKeyFile(userKeyDir, sub);
  if (!existsSync(path)) return { keys: null, source: 'none' };
  const passphrase = process.env.KEY_SECRET ?? '';
  if (!passphrase) return { keys: null, source: 'none', error: 'KEY_SECRET is not set. Saved keys stay locked.' };
  const opened = readKeyFile(path, passphrase);
  if (!opened) return { keys: null, source: 'none', error: 'Saved keys could not be opened.' };
  return { keys: opened, source: 'saved' };
}

function foreignLive(sub: string): boolean {
  return engine.isLiveArmed() && liveOwner !== null && liveOwner !== sub;
}

function publicState(sub: string, message?: string) {
  const snap = engine.snapshot();
  return {
    ...snap,
    feed: mode,
    liveVenue: engine.isLiveArmed() ? 'mexc' : null,
    message: message ?? tapeMessage,
    view: desks.get(sub),
  };
}

interface MexcView {
  connected: boolean;
  equity: number | null;
  available: number | null;
  openPnl: number | null;
  totalPnl: number | null;
  tradeStakeUsdt: number | null;
  asOf: number | null;
}

interface MexcCache {
  assetAt: number;
  asset: { equity: number; available: number; unrealized: number } | null;
  openAt: number;
  openRealised: number | null;
  openIds: string;
  historyAt: number;
  closedRealised: number | null;
  closedComplete: boolean;
}

const mexcBooks = new Map<string, MexcCache>();
const emptyMexc: MexcView = {
  connected: false,
  equity: null,
  available: null,
  openPnl: null,
  totalPnl: null,
  tradeStakeUsdt: null,
  asOf: null,
};

async function mexcAccount(sub: string): Promise<MexcView> {
  if (!sub) return emptyMexc;
  const resolved = resolveTradingKeys(sub);
  if (resolved.error || !resolved.keys) return emptyMexc;
  const now = Date.now();
  let row = mexcBooks.get(sub);
  if (!row) {
    row = {
      assetAt: 0,
      asset: null,
      openAt: 0,
      openRealised: null,
      openIds: '',
      historyAt: 0,
      closedRealised: null,
      closedComplete: false,
    };
    mexcBooks.set(sub, row);
  }
  const venue =
    liveVenue && engine.isLiveArmed() && liveOwner === sub
      ? liveVenue
      : createMexcLive({ apiKey: resolved.keys.apiKey, apiSecret: resolved.keys.apiSecret, leverage: config.leverage });
  if (now - row.assetAt >= 900) {
    try {
      const asset = await venue.accountEquity();
      if (asset) {
        row.asset = asset;
        row.assetAt = now;
      }
    } catch {
      // Keep the last equity MEXC did return.
    }
  }
  if (!row.asset) return emptyMexc;
  if (now - row.openAt >= 900) {
    try {
      const open = await venue.openPositionPnl();
      if (open) {
        const ids = [...open.ids].sort().join(',');
        if (ids !== row.openIds) row.historyAt = 0;
        row.openIds = ids;
        row.openRealised = open.realised;
        row.openAt = now;
      }
    } catch {
      // Keep the last open realised figure.
    }
  }
  if (row.closedRealised == null || now - row.historyAt >= 3000) {
    try {
      const closed = await venue.closedPositionPnl();
      if (closed) {
        row.closedRealised = closed.realised;
        row.closedComplete = closed.complete;
        row.historyAt = now;
      }
    } catch {
      // Keep the last closed sum.
    }
  }
  const openPnl = row.asset.unrealized;
  const total =
    row.closedComplete && row.closedRealised != null && row.openRealised != null
      ? row.closedRealised + row.openRealised + openPnl
      : null;
  return {
    connected: true,
    equity: row.asset.equity,
    available: row.asset.available,
    openPnl,
    totalPnl: total,
    tradeStakeUsdt: slotStake(row.asset.equity, row.asset.available, config.balance_slots, config.balance_reserve_frac),
    asOf: row.assetAt,
  };
}

function stateWithMexc(sub: string, book: MexcView, message?: string) {
  const state = publicState(sub, message);
  if (!book.connected || book.equity == null || book.available == null) return { ...state, mexc: book };
  return {
    ...state,
    mexc: book,
    balanceUsdt: book.equity,
    tradeStakeUsdt: book.tradeStakeUsdt,
  };
}

function chartPayload(pair: PairId) {
  const view = engine.snapshot().pairs.find((row) => row.pair === pair);
  const book = books.get(pair);
  const source = book?.m5.length ? book.m5 : (view?.candles ?? []);
  let marks = view?.marks ?? [];
  if (view && source !== view.candles && view.candles.length) {
    const origin = view.candles[0]?.time;
    const offset = source.findIndex((candle) => candle.time === origin);
    if (offset > 0) {
      marks = view.marks.map((mark) => ({
        ...mark,
        fromIndex: mark.fromIndex + offset,
        toIndex: mark.toIndex + offset,
      }));
    }
  }
  return {
    pair,
    barMs: FIVE,
    candles: source,
    marks,
    entry: view?.entry ?? null,
    sl: view?.sl ?? null,
    lock: view?.lock ?? null,
    locked: view?.locked ?? false,
    tp: view?.tp ?? null,
    side: view?.side ?? null,
    state: view?.state ?? 'FLAT',
    lastPrice: book?.lastPrice ?? view?.lastPrice ?? null,
    stamp: view?.stamp ?? '',
    lastPing: view?.lastPing ?? '',
    liveArmed: engine.isLiveArmed(),
  };
}

function closeTape(): void {
  tape?.close();
  tape = null;
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = null;
}

function withClosed(series: Candle[], step: number, now: number): Candle[] {
  return series.map((c) => ({ ...c, closed: c.time + step <= now }));
}

async function ingestPair(pair: PairId, forceStale: boolean): Promise<void> {
  const book = books.get(pair);
  if (!book || !book.m5.length || mode !== 'market') return;
  const now = Date.now();
  const update: MarketUpdate = {
    pair,
    candles5m: withClosed(book.m5, FIVE, now).slice(-ENGINE_BARS),
    candles1h: withClosed(book.h1, HOUR, now).slice(-80),
    lastPrice: book.lastPrice,
    nowMs: now,
    forceStale,
  };
  await engine.ingest(update);
}

async function paintStale(): Promise<void> {
  if (mode !== 'market') return;
  for (const pair of config.pairs) await ingestPair(pair, true);
}

function scheduleStale(): void {
  if (staleTimer || mode !== 'market') return;
  staleTimer = setTimeout(() => {
    staleTimer = null;
    enqueue(() => paintStale());
  }, 1000);
}

function upsert(series: Candle[], bar: Candle, max: number): boolean {
  const prev = series[series.length - 1];
  if (!prev) {
    series.push(bar);
    return false;
  }
  if (prev.time === bar.time) {
    series[series.length - 1] = bar;
    return false;
  }
  if (bar.time < prev.time) return false;
  prev.closed = true;
  series.push(bar);
  if (series.length > max) series.splice(0, series.length - max);
  return true;
}

async function onTape(event: TapeEvent): Promise<void> {
  if (mode !== 'market') return;
  if (event.kind === 'pong') return;
  if (event.kind === 'ticker') {
    const pair = PAIR_OF[event.symbol];
    const book = pair ? books.get(pair) : undefined;
    if (!book) return;
    book.lastPrice = event.lastPrice;
    scheduleStale();
    return;
  }
  const pair = PAIR_OF[event.kline.symbol];
  const book = pair ? books.get(pair) : undefined;
  if (!pair || !book) return;
  const step = event.kline.interval === 'Min5' ? FIVE : HOUR;
  const series = event.kline.interval === 'Min5' ? book.m5 : book.h1;
  const now = Date.now();
  const bar: Candle = {
    time: event.kline.timeMs,
    open: event.kline.open,
    high: event.kline.high,
    low: event.kline.low,
    close: event.kline.close,
    closed: event.kline.timeMs + step <= now,
  };
  const prevTime = series[series.length - 1]?.time;
  const advanced = upsert(series, bar, event.kline.interval === 'Min5' ? CHART_BARS : 80);
  if (event.kline.interval === 'Min60') {
    scheduleStale();
    return;
  }
  if (advanced && prevTime != null) {
    const age = now - (prevTime + FIVE);
    const fresh = age >= -500 && age <= config.stale_close_ms;
    await ingestPair(pair, !fresh);
    return;
  }
  scheduleStale();
}

async function backfill(): Promise<Map<PairId, PairBook> | null> {
  const now = Date.now();
  const map = new Map<PairId, PairBook>();
  await Promise.all(
    config.pairs.map(async (pair) => {
      const symbol = SYMBOL[pair];
      const [m5, h1] = await Promise.all([
        fetchMexcKlines({ symbol, interval: 'Min5', startMs: now - CHART_BARS * FIVE, endMs: now, pauseMs: 0 }),
        fetchMexcKlines({ symbol, interval: 'Min60', startMs: now - 80 * HOUR, endMs: now, pauseMs: 0 }),
      ]);
      if (!m5.length) return;
      const last = m5[m5.length - 1];
      map.set(pair, { m5: m5.slice(-CHART_BARS), h1: h1.slice(-80), lastPrice: last.close });
    }),
  );
  if (map.size < config.pairs.length) return null;
  return map;
}

async function startTape(): Promise<string> {
  closeTape();
  if (engine.isLiveArmed()) return 'Stop live fires before changing the tape.';
  tapeMessage = 'Loading the MEXC tape…';
  try {
    const loaded = await backfill();
    if (!loaded) throw new Error('empty');
    const next = bootDemo();
    const updates: MarketUpdate[] = config.pairs.map((pair) => {
      const book = loaded.get(pair);
      if (!book) throw new Error(`missing ${pair}`);
      return {
        pair,
        candles5m: book.m5,
        candles1h: book.h1,
        lastPrice: book.lastPrice,
        nowMs: Date.now(),
        forceStale: true,
      };
    });
    await next.runBook(updates);
    engine = next;
    books = loaded;
    mode = 'market';
    tape = openMexcTape({
      symbols: config.pairs.map((pair) => SYMBOL[pair]),
      onEvent: (event) => enqueue(() => onTape(event)),
    });
    tapeMessage =
      'MEXC 5m tape. Live fires are off. A fresh close can write a dry-run LIMIT. Nothing is sent to the exchange.';
    return tapeMessage;
  } catch (err) {
    console.error('mexc tape', err instanceof Error ? err.message : err);
    closeTape();
    mode = 'demo';
    books = new Map();
    engine = bootDemo();
    await engine.runBook(demoBook().updates);
    tapeMessage = 'MEXC tape did not connect. Showing the synthetic book. Nothing was sent.';
    return tapeMessage;
  }
}

async function cancelWorking(): Promise<{ failed: string[]; cancelled: number }> {
  const failed: string[] = [];
  let cancelled = 0;
  if (!liveVenue) return { failed, cancelled };
  for (const order of engine.workingOrders()) {
    const result = await liveVenue.cancelExternal(order.pair, order.clientOrderId);
    if (!result.ok) {
      failed.push(order.pair);
      continue;
    }
    cancelled += 1;
    engine.releaseUnfilled(order.pair, Date.now(), 'LIVE_STOPPED');
  }
  return { failed, cancelled };
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const method = req.method ?? 'GET';
  try {
    if (method === 'POST' && !originAllowed({
      origin: headerValue(req, 'origin'),
      host: headerValue(req, 'host'),
      secFetchSite: headerValue(req, 'sec-fetch-site'),
    })) {
      sendJson(res, { error: 'Cross-site request blocked.' }, 403);
      return;
    }
    const secure = requestSecure(req);
    let session = sessions.read(req.headers.cookie);
    let minted: string | undefined;
    if (!session) {
      const presented = headerValue(req, 'x-choke-session');
      if (presented.split('.').length === 3) {
        const account = await accountFromGateToken(presented, {
          allowedEmail: allowedAccountEmail(process.env.GOOGLE_ALLOWED_EMAIL),
        });
        if (account) session = account;
      }
    }
    if (!session) {
      const gateToken = headerValue(req, 'x-grok-id-token');
      if (gateToken) {
        const account = await accountFromGateToken(gateToken, {
          allowedEmail: allowedAccountEmail(process.env.GOOGLE_ALLOWED_EMAIL),
        });
        if (account) {
          minted = sessions.issue(account, secure).setCookie;
          session = account;
        }
      }
    }
    const reply = (body: unknown, status = 200, extra?: Record<string, string | string[]>) => {
      const prior = extra?.['set-cookie'];
      const cookies = [minted, ...(Array.isArray(prior) ? prior : prior ? [prior] : [])].filter((item): item is string => Boolean(item));
      const headers = { ...extra };
      if (cookies.length) headers['set-cookie'] = cookies;
      sendJson(res, body, status, headers);
    };
    if (method === 'GET' && url.pathname === '/api/auth/config') {
      reply(publicAuthConfig());
      return;
    }
    if (method === 'GET' && url.pathname === '/api/auth/pending') {
      reply(grokLogin.pending(req.headers.cookie));
      return;
    }
    if (method === 'POST' && url.pathname === '/api/auth/google') {
      const ip = req.socket.remoteAddress ?? 'local';
      if (!loginLimit(ip)) {
        reply({ error: 'Too many sign-in attempts. Wait and try again.' }, 429);
        return;
      }
      const started = await grokLogin.begin(secure);
      if (!started.ok) {
        reply({ error: started.error }, 503);
        return;
      }
      const login = started.setCookie.split(';')[0]?.split('=').slice(1).join('=') ?? '';
      reply({ verificationUrl: started.verificationUrl, intervalSec: started.intervalSec, login }, 200, { 'set-cookie': started.setCookie });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/auth/poll') {
      let ticket: unknown;
      try {
        ticket = (await readJson(req)).login;
      } catch {
        ticket = undefined;
      }
      const finished = await grokLogin.finish(loginCookieFromClient(ticket, req.headers.cookie), secure);
      if (!finished.ok) {
        reply({ error: finished.error }, 401, finished.clearLogin ? { 'set-cookie': finished.clearLogin } : undefined);
        return;
      }
      if (finished.pending) {
        reply(
          { pending: true, intervalSec: finished.intervalSec },
          200,
          finished.setCookie ? { 'set-cookie': finished.setCookie } : undefined,
        );
        return;
      }
      if (!('email' in finished) || !finished.email || !finished.sub || !finished.session || !finished.clearLogin) {
        reply({ pending: false });
        return;
      }
      const issued = sessions.issue({ email: finished.email, sub: finished.sub }, secure);
      reply({ email: finished.email, session: finished.session }, 200, { 'set-cookie': [issued.setCookie, finished.clearLogin] });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/auth/logout') {
      sessions.revoke(req.headers.cookie);
      reply({ ok: true }, 200, { 'set-cookie': [clearSessionCookie(secure), clearLoginCookie(secure)] });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (!session) {
        reply({ error: 'Sign in required.' }, 401);
        return;
      }
      if (method === 'GET' && url.pathname === '/api/auth/me') {
        reply({ email: session.email });
        return;
      }
    }
    const sub = session?.sub ?? '';
    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, stateWithMexc(sub, await mexcAccount(sub)));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/account') {
      sendJson(res, await mexcAccount(sub));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/chart') {
      const pair = url.searchParams.get('pair');
      if (pair !== 'BTCUSDT' && pair !== 'ETHUSDT' && pair !== 'SOLUSDT') {
        sendJson(res, { error: 'unknown pair' }, 400);
        return;
      }
      sendJson(res, chartPayload(pair));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/backtest') {
      const path = join(root, 'logs/backtest.json');
      if (!existsSync(path)) {
        sendJson(res, { ready: false, message: 'No backtest yet. Run npm run backtest.' });
        return;
      }
      sendJson(res, { ready: true, ...(JSON.parse(readFileSync(path, 'utf8')) as object) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/review') {
      const snap = engine.snapshot();
      sendJson(res, {
        clockUk: snap.clockUk,
        liveArmed: snap.liveArmed,
        window: snap.window,
        pairs: snap.pairs.map((p) => ({
          pair: p.pair,
          state: p.state,
          reason: p.reason,
          review: p.review,
          btcAligned: p.btcAligned,
          zone: p.zone,
          sl: p.sl,
          tp: p.tp,
          warnings: p.warnings,
        })),
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/keys') {
      const resolved = resolveTradingKeys(sub);
      sendJson(res, keyStatus(resolved.source, resolved.error));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/keys') {
      const passphrase = process.env.KEY_SECRET ?? '';
      if (!passphrase) {
        sendJson(res, { error: 'Set KEY_SECRET before saving keys. Nothing was stored.' }, 400);
        return;
      }
      const body = await readJson(req);
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      const apiSecret = typeof body.apiSecret === 'string' ? body.apiSecret.trim() : '';
      if (!validKeyMaterial(apiKey) || !validKeyMaterial(apiSecret)) {
        sendJson(res, { error: 'Keys were rejected. Nothing was stored.' }, 400);
        return;
      }
      saveKeyFile(accountKeyFile(userKeyDir, sub), { apiKey, apiSecret }, passphrase);
      sendJson(res, keyStatus('saved'));
      return;
    }
    if (req.method === 'DELETE' && url.pathname === '/api/keys') {
      removeKeyFile(accountKeyFile(userKeyDir, sub));
      sendJson(res, keyStatus('none'));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/session/view') {
      const body = await readJson(req);
      const view = desks.apply(sub, {
        pair: body.pair,
        timeframe: body.timeframe,
        tradeId: body.tradeId === null ? null : body.tradeId,
      });
      sendJson(res, { view });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/tape') {
      if (engine.isLiveArmed()) {
        sendJson(res, { error: 'Stop live fires before loading the tape.' }, 409);
        return;
      }
      const message = await startTape();
      sendJson(res, publicState(sub, message));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/live/start') {
      if (foreignLive(sub)) {
        const message = 'Another account has live fires on. Nothing was sent.';
        sendJson(res, { ok: false, liveArmed: true, message, state: publicState(sub, message) }, 409);
        return;
      }
      const body = await readJson(req);
      const confirm = typeof body.confirm === 'string' ? body.confirm : '';
      const resolved = resolveTradingKeys(sub);
      const apiKey = resolved.keys?.apiKey ?? '';
      const apiSecret = resolved.keys?.apiSecret ?? '';
      if (resolved.error || !apiKey || !apiSecret || confirm !== 'START_LIVE') {
        const gate = liveArmGate({ confirm, apiKey, apiSecret, accountOk: false });
        const message = resolved.error
          ? `${resolved.error} Nothing was sent.`
          : !apiKey || !apiSecret
            ? 'No MEXC keys are saved for this account. Nothing was sent.'
            : gate.message;
        sendJson(res, { ok: false, liveArmed: false, message, state: publicState(sub, message) }, 400);
        return;
      }
      liveVenue = createMexcLive({ apiKey, apiSecret, leverage: config.leverage });
      let accountOk = false;
      try {
        accountOk = await liveVenue.pingAccount();
      } catch {
        accountOk = false;
      }
      const gate = liveArmGate({ confirm: 'START_LIVE', apiKey, apiSecret, accountOk });
      if (!gate.arm || !liveVenue) {
        liveVenue = null;
        sendJson(res, { ok: false, liveArmed: false, message: gate.message, state: publicState(sub, gate.message) }, 400);
        return;
      }
      if (mode !== 'market') {
        const message = await startTape();
        if (mode !== 'market') {
          liveVenue = null;
          sendJson(res, { ok: false, liveArmed: false, message, state: publicState(sub, message) }, 502);
          return;
        }
      }
      engine.setVenue(liveVenue);
      engine.setLiveArmed(true);
      liveOwner = sub;
      const sawBalance = await engine.pullEquity(Date.now());
      const message = sawBalance
        ? 'Live fires are on. Each trade uses half the MEXC USDT balance. Two can be open. The next fresh 5m close can send a LIMIT with a stop and a target.'
        : 'Live fires are on, but MEXC did not return a USDT balance. Nothing is sent until that balance is read.';
      tapeMessage = message;
      sendJson(res, { ok: true, liveArmed: true, message, state: publicState(sub, message) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/live/stop') {
      if (foreignLive(sub)) {
        const message = 'Another account started live fires. This account cannot stop them.';
        sendJson(res, { ok: false, liveArmed: true, message, state: publicState(sub, message) }, 409);
        return;
      }
      const body = await readJson(req);
      const confirm = typeof body.confirm === 'string' ? body.confirm : '';
      const gate = liveStopGate(confirm);
      if (!gate.stop) {
        sendJson(res, { ok: false, liveArmed: engine.isLiveArmed(), message: gate.message, state: publicState(sub, gate.message) }, 400);
        return;
      }
      const { failed, cancelled } = await cancelWorking();
      engine.setLiveArmed(false);
      engine.setVenue(stub);
      liveOwner = null;
      const message = failed.length
        ? `Live fires are off. Cancel failed for ${failed.join(', ')}. Check the exchange.`
        : cancelled
          ? 'Live fires are off. Working MEXC limits were cancelled.'
          : 'Live fires are off. The MEXC tape keeps painting. Nothing further is sent.';
      tapeMessage = message;
      sendJson(res, { ok: failed.length === 0, liveArmed: false, message, state: publicState(sub, message) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/kill') {
      const body = await readJson(req);
      if (body.confirm !== 'FLATTEN') {
        sendJson(res, { error: 'confirm must be FLATTEN' }, 400);
        return;
      }
      if (foreignLive(sub)) {
        sendJson(res, { error: 'Another account has live fires on. This account cannot flatten them.' }, 409);
        return;
      }
      if (engine.isLiveArmed()) {
        const { failed } = await cancelWorking();
        if (failed.length) {
          sendJson(res, { error: `Cancel failed for ${failed.join(', ')}. Book was not muted.` }, 502);
          return;
        }
      }
      engine.killToday(Date.now());
      sendJson(res, publicState(sub));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/replay') {
      if (engine.isLiveArmed()) {
        sendJson(res, { error: 'Stop live fires before replay.' }, 409);
        return;
      }
      closeTape();
      mode = 'demo';
      books = new Map();
      engine = bootDemo();
      await engine.runBook(demoBook().updates);
      tapeMessage = 'Synthetic replay. Live fires are off. Nothing is sent.';
      sendJson(res, publicState(sub));
      return;
    }
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = normalize(join(publicDir, rel));
    if (!file.startsWith(`${publicDir}/`) || !existsSync(file)) {
      res.writeHead(404, SECURITY);
      res.end('not found');
      return;
    }
    const fileHeaders: Record<string, string | string[]> = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', ...SECURITY };
    if (minted) fileHeaders['set-cookie'] = minted;
    res.writeHead(200, fileHeaders);
    res.end(readFileSync(file));
  } catch (err) {
    const limited = err instanceof Error && err.message === 'BODY_LIMIT';
    const badJson = err instanceof SyntaxError;
    if (!limited && !badJson) console.error('desk', err instanceof Error ? err.name : 'error');
    if (!res.headersSent) {
      sendJson(res, { error: limited ? 'Request is too large.' : badJson ? 'Request was not valid.' : 'Request failed.' }, limited || badJson ? 400 : 500);
    }
  }
}

export function handleDesk(req: IncomingMessage, res: ServerResponse): Promise<void> {
  bootDesk();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    res.once('finish', finish);
    res.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    void onRequest(req, res).then(finish, (err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Request failed.');
      }
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

let tapeBooted = false;
export function bootDesk(): void {
  if (tapeBooted) return;
  tapeBooted = true;
  void startTape();
}

const port = Number(process.env.PORT ?? 4173);
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  createServer((req, res) => {
    void onRequest(req, res);
  }).listen(port, '0.0.0.0', () => {
    console.log(`Choke Watcher UI http://127.0.0.1:${port}  LIVE_ARMED=${String(engine.isLiveArmed())}`);
    bootDesk();
  });
}
