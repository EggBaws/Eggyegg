export interface TapeKline {
  symbol: string;
  interval: 'Min5' | 'Min60';
  timeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type TapeEvent =
  | { kind: 'kline'; kline: TapeKline }
  | { kind: 'ticker'; symbol: string; lastPrice: number }
  | { kind: 'pong' };

const FIVE = 300_000;
const HOUR = 3_600_000;

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Public MEXC contract tape. `ro/rc/rh/rl` are the real prices when present.
 * This parser does not place orders.
 */
export function parseMexcTapeMessage(raw: string): TapeEvent | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const rec = msg as { channel?: unknown; symbol?: unknown; data?: unknown };
  if (rec.channel === 'pong') return { kind: 'pong' };
  const data = rec.data;
  if (!data || typeof data !== 'object') return null;
  const row = data as Record<string, unknown>;
  if (typeof row.lastPrice === 'number' || (typeof row.lastPrice === 'string' && row.lastPrice !== '')) {
    const last = num(row.lastPrice);
    if (last == null) return null;
    const symbol = String(row.symbol ?? rec.symbol ?? '');
    if (!symbol) return null;
    return { kind: 'ticker', symbol, lastPrice: last };
  }
  if (row.interval !== 'Min5' && row.interval !== 'Min60') return null;
  const timeSec = num(row.t);
  const open = num(row.ro ?? row.o);
  const close = num(row.rc ?? row.c);
  let high = num(row.rh ?? row.h);
  let low = num(row.rl ?? row.l);
  if (timeSec == null || open == null || close == null || high == null || low == null) return null;
  high = Math.max(high, open, close, low);
  low = Math.min(low, open, close, high);
  const symbol = String(row.symbol ?? rec.symbol ?? '');
  if (!symbol) return null;
  return {
    kind: 'kline',
    kline: {
      symbol,
      interval: row.interval,
      timeMs: timeSec * 1000,
      open,
      high,
      low,
      close,
    },
  };
}

export function tapeIntervalMs(interval: TapeKline['interval']): number {
  return interval === 'Min5' ? FIVE : HOUR;
}

export interface MexcTape {
  close(): void;
}

/**
 * One websocket for 5m, 1h, and last price. Reconnects on its own.
 * Ping every 15s so the contract edge does not drop the socket.
 */
export function openMexcTape(opts: {
  symbols: string[];
  onEvent: (event: TapeEvent) => void;
  url?: string;
  WebSocketImpl?: typeof WebSocket;
}): MexcTape {
  const WS = opts.WebSocketImpl ?? WebSocket;
  const url = opts.url ?? 'wss://contract.mexc.com/edge';
  let stopped = false;
  let socket: WebSocket | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  function clearPing(): void {
    if (ping) clearInterval(ping);
    ping = null;
  }

  function connect(): void {
    if (stopped) return;
    const ws = new WS(url);
    socket = ws;
    ws.addEventListener('open', () => {
      if (stopped || socket !== ws) return;
      for (const symbol of opts.symbols) {
        ws.send(JSON.stringify({ method: 'sub.kline', param: { symbol, interval: 'Min5' } }));
        ws.send(JSON.stringify({ method: 'sub.kline', param: { symbol, interval: 'Min60' } }));
        ws.send(JSON.stringify({ method: 'sub.ticker', param: { symbol } }));
      }
      clearPing();
      ping = setInterval(() => {
        if (socket === ws && ws.readyState === WS.OPEN) ws.send(JSON.stringify({ method: 'ping' }));
      }, 15_000);
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (stopped || socket !== ws) return;
      const parsed = parseMexcTapeMessage(String(ev.data));
      if (parsed) opts.onEvent(parsed);
    });
    const schedule = () => {
      clearPing();
      if (socket === ws) socket = null;
      if (stopped || retry) return;
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, 5_000);
    };
    ws.addEventListener('close', schedule);
    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        schedule();
      }
    });
  }

  connect();
  return {
    close() {
      stopped = true;
      if (retry) clearTimeout(retry);
      retry = null;
      clearPing();
      const ws = socket;
      socket = null;
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
    },
  };
}
