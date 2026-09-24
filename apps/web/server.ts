import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChokeEngine, demoBook, loadConfig } from '../../packages/engine/src/index.ts';
import { ConsoleFileNotifier } from '../../packages/notify/src/index.ts';
import { createVenue } from '../../packages/venues/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const publicDir = join(here, 'public');
const config = loadConfig(join(root, 'config/default.json'));

function abs(path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

function boot(): ChokeEngine {
  const engine = new ChokeEngine({
    config,
    venue: createVenue(config.active_venue),
    notifier: new ConsoleFileNotifier(abs(config.notify_log), config.notify_debounce_ms),
    dryRunPath: abs(config.dry_run_log),
  });
  engine.runBook(demoBook().updates);
  return engine;
}

let engine = boot();

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, engine.snapshot());
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
    if (req.method === 'POST' && url.pathname === '/api/kill') {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as { confirm?: string }) : {};
      if (body.confirm !== 'FLATTEN') {
        sendJson(res, { error: 'confirm must be FLATTEN' }, 400);
        return;
      }
      sendJson(res, engine.killToday(Date.now()));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/replay') {
      engine = boot();
      sendJson(res, engine.snapshot());
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
  console.log(`Choke Watcher UI http://127.0.0.1:${port}  LIVE_ARMED=${String(config.live_armed)}`);
});
