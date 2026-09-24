import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChokeEngine, demoBook, loadConfig, type MarketUpdate, type PairId } from '../../packages/engine/src/index.ts';
import { ConsoleFileNotifier } from '../../packages/notify/src/index.ts';
import { createMexcLive, createVenue, fetchMexcKlines, liveArmGate, liveStopGate, type MexcLiveAdapter } from '../../packages/venues/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const publicDir = join(here, 'public');
const config = loadConfig(join(root, 'config/default.json'));
const SYMBOL: Record<PairId, string> = {
  BTCUSDT: 'BTC_USDT',
  ETHUSDT: 'ETH_USDT',
  SOLUSDT: 'SOL_USDT',
};

function abs(path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

const notifier = new ConsoleFileNotifier(abs(config.notify_log), config.notify_debounce_ms);
const dryRunPath = abs(config.dry_run_log);
const stub = createVenue(config.active_venue);

function bootDemo(): ChokeEngine {
  const engine = new ChokeEngine({
    config,
    venue: stub,
    notifier,
    dryRunPath,
  });
  return engine;
}

let engine = bootDemo();
await engine.runBook(demoBook().updates);

let mode: 'demo' | 'market' = 'demo';
let liveVenue: MexcLiveAdapter | null = null;
let paintTimer: ReturnType<typeof setInterval> | null = null;
let fireTimer: ReturnType<typeof setTimeout> | null = null;
let polling = false;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

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
    message: message ?? '',
  };
}

async function marketUpdates(fire: boolean): Promise<MarketUpdate[]> {
  const now = Date.now();
  const updates: MarketUpdate[] = [];
  await Promise.all(
    config.pairs.map(async (pair) => {
      const symbol = SYMBOL[pair];
      const [m5, h1] = await Promise.all([
        fetchMexcKlines({ symbol, interval: 'Min5', startMs: now - 400 * 300_000, endMs: now, pauseMs: 0 }),
        fetchMexcKlines({ symbol, interval: 'Min60', startMs: now - 48 * 3_600_000, endMs: now, pauseMs: 0 }),
      ]);
      if (!m5.length) return;
      const last = m5[m5.length - 1];
      updates.push({
        pair,
        candles5m: m5.slice(-400),
        candles1h: h1,
        lastPrice: last.close,
        nowMs: now,
        forceStale: !fire,
      });
    }),
  );
  return updates;
}

async function paintMarket(fire: boolean): Promise<void> {
  if (mode !== 'market' || polling) return;
  polling = true;
  try {
    const updates = await marketUpdates(fire && engine.isLiveArmed());
    if (updates.length) await engine.runBook(updates);
  } catch (err) {
    console.error('market poll', err instanceof Error ? err.message : err);
  } finally {
    polling = false;
  }
}

function startPaint(): void {
  if (paintTimer) return;
  paintTimer = setInterval(() => {
    void paintMarket(false);
  }, 20_000);
}

function stopTimers(): void {
  if (paintTimer) clearInterval(paintTimer);
  if (fireTimer) clearTimeout(fireTimer);
  paintTimer = null;
  fireTimer = null;
}

function armFireTimer(): void {
  if (fireTimer) clearTimeout(fireTimer);
  if (!engine.isLiveArmed() || mode !== 'market') return;
  const now = Date.now();
  const five = 300_000;
  const next = Math.ceil(now / five) * five + 700;
  fireTimer = setTimeout(() => {
    void fireClose(0);
  }, Math.max(250, next - now));
}

async function fireClose(attempt: number): Promise<void> {
  if (mode !== 'market' || !engine.isLiveArmed()) return;
  await paintMarket(true);
  if (attempt < 2) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await fireClose(attempt + 1);
    return;
  }
  armFireTimer();
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
      let updates: MarketUpdate[] = [];
      try {
        updates = await marketUpdates(false);
      } catch (err) {
        console.error('live start candles', err instanceof Error ? err.message : err);
      }
      if (updates.length < config.pairs.length) {
        liveVenue = null;
        const message = 'MEXC public candles did not load. Nothing was sent.';
        sendJson(res, { ok: false, liveArmed: false, message, state: publicState(message) }, 502);
        return;
      }
      if (mode !== 'market') {
        engine = new ChokeEngine({ config, venue: stub, notifier, dryRunPath });
        mode = 'market';
      }
      await engine.runBook(updates.map((u) => ({ ...u, forceStale: true })));
      engine.setVenue(liveVenue);
      engine.setLiveArmed(true);
      startPaint();
      armFireTimer();
      sendJson(res, { ok: true, liveArmed: true, message: gate.message, state: publicState(gate.message) });
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
      if (fireTimer) clearTimeout(fireTimer);
      fireTimer = null;
      const { failed, cancelled } = await cancelWorking();
      engine.setLiveArmed(false);
      engine.setVenue(stub);
      const message = failed.length
        ? `Live fires are off. Cancel failed for ${failed.join(', ')}. Check the exchange.`
        : cancelled
          ? 'Live fires are off. Working MEXC limits were cancelled.'
          : 'Live fires are off.';
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
      stopTimers();
      mode = 'demo';
      engine = bootDemo();
      await engine.runBook(demoBook().updates);
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
});
