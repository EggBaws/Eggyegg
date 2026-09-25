import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChokeEngine, demoBook, loadConfig, type Candle, type MarketUpdate, type PairId } from '../../packages/engine/src/index.ts';
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

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const publicDir = join(here, 'public');
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
};

function enqueue(job: () => Promise<void>): void {
  chain = chain.then(job, job);
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(raw);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function publicState(message?: string) {
  const snap = engine.snapshot();
  return {
    ...snap,
    feed: mode,
    liveVenue: engine.isLiveArmed() ? 'mexc' : null,
    message: message ?? tapeMessage,
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, publicState());
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
    if (req.method === 'POST' && url.pathname === '/api/tape') {
      if (engine.isLiveArmed()) {
        sendJson(res, { error: 'Stop live fires before loading the tape.' }, 409);
        return;
      }
      const message = await startTape();
      sendJson(res, publicState(message));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/live/start') {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as { confirm?: string }) : {};
      const apiKey = process.env.MEXC_API_KEY ?? '';
      const apiSecret = process.env.MEXC_API_SECRET ?? '';
      if (!apiKey || !apiSecret || body.confirm !== 'START_LIVE') {
        const gate = liveArmGate({ confirm: body.confirm ?? '', apiKey, apiSecret, accountOk: false });
        sendJson(res, { ok: false, liveArmed: false, message: gate.message, state: publicState(gate.message) }, 400);
        return;
      }
      liveVenue = createMexcLive({ apiKey, apiSecret, leverage: config.leverage });
      const accountOk = await liveVenue.pingAccount();
      const gate = liveArmGate({ confirm: 'START_LIVE', apiKey, apiSecret, accountOk });
      if (!gate.arm || !liveVenue) {
        liveVenue = null;
        sendJson(res, { ok: false, liveArmed: false, message: gate.message, state: publicState(gate.message) }, 400);
        return;
      }
      if (mode !== 'market') {
        const message = await startTape();
        if (mode !== 'market') {
          liveVenue = null;
          sendJson(res, { ok: false, liveArmed: false, message, state: publicState(message) }, 502);
          return;
        }
      }
      engine.setVenue(liveVenue);
      engine.setLiveArmed(true);
      const message = 'Live fires are on. The next fresh 5m close can send a LIMIT with a stop and a target. Market orders are never sent.';
      tapeMessage = message;
      sendJson(res, { ok: true, liveArmed: true, message, state: publicState(message) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/live/stop') {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as { confirm?: string }) : {};
      const gate = liveStopGate(body.confirm ?? '');
      if (!gate.stop) {
        sendJson(res, { ok: false, liveArmed: engine.isLiveArmed(), message: gate.message, state: publicState(gate.message) }, 400);
        return;
      }
      const { failed, cancelled } = await cancelWorking();
      engine.setLiveArmed(false);
      engine.setVenue(stub);
      const message = failed.length
        ? `Live fires are off. Cancel failed for ${failed.join(', ')}. Check the exchange.`
        : cancelled
          ? 'Live fires are off. Working MEXC limits were cancelled.'
          : 'Live fires are off. The MEXC tape keeps painting. Nothing further is sent.';
      tapeMessage = message;
      sendJson(res, { ok: failed.length === 0, liveArmed: false, message, state: publicState(message) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/kill') {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as { confirm?: string }) : {};
      if (body.confirm !== 'FLATTEN') {
        sendJson(res, { error: 'confirm must be FLATTEN' }, 400);
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
      sendJson(res, publicState());
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
      sendJson(res, publicState());
      return;
    }
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = normalize(join(publicDir, rel));
    if (!file.startsWith(`${publicDir}/`) || !existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(err instanceof Error ? err.message : 'error');
  }
});

const port = Number(process.env.PORT ?? 4173);
server.listen(port, '0.0.0.0', () => {
  console.log(`Choke Watcher UI http://127.0.0.1:${port}  LIVE_ARMED=${String(engine.isLiveArmed())}`);
  void startTape();
});
