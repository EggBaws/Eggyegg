export interface KlineCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  closed: boolean;
}

const INTERVAL_MS = { Min5: 300_000, Min60: 3_600_000 } as const;
export type MexcInterval = keyof typeof INTERVAL_MS;

interface Columnar {
  time?: number[];
  open?: number[];
  close?: number[];
  high?: number[];
  low?: number[];
  realOpen?: number[];
  realClose?: number[];
  realHigh?: number[];
  realLow?: number[];
}

/**
 * Public MEXC contract klines. `real*` prices are used when the exchange sends them.
 * The forming bar is dropped so a replay never treats the live candle as closed.
 */
export function parseMexcKlines(payload: unknown, interval: MexcInterval, nowMs: number): KlineCandle[] {
  const data = (payload as { data?: Columnar } | null)?.data;
  if (!data || !Array.isArray(data.time)) return [];
  const step = INTERVAL_MS[interval];
  const out: KlineCandle[] = [];
  for (let i = 0; i < data.time.length; i++) {
    const time = Number(data.time[i]) * 1000;
    if (!Number.isFinite(time)) continue;
    if (time + step > nowMs) continue;
    const open = num(data.realOpen?.[i] ?? data.open?.[i]);
    const close = num(data.realClose?.[i] ?? data.close?.[i]);
    let high = num(data.realHigh?.[i] ?? data.high?.[i]);
    let low = num(data.realLow?.[i] ?? data.low?.[i]);
    if (open == null || close == null || high == null || low == null) continue;
    high = Math.max(high, open, close, low);
    low = Math.min(low, open, close, high);
    out.push({ time, open, high, low, close, closed: true });
  }
  out.sort((a, b) => a.time - b.time);
  const deduped: KlineCandle[] = [];
  for (const candle of out) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.time === candle.time) deduped[deduped.length - 1] = candle;
    else deduped.push(candle);
  }
  return deduped;
}

export async function fetchMexcKlines(opts: {
  symbol: string;
  interval: MexcInterval;
  startMs: number;
  endMs: number;
  fetchImpl?: typeof fetch;
  pauseMs?: number;
}): Promise<KlineCandle[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const step = INTERVAL_MS[opts.interval];
  const chunkSec = opts.interval === 'Min5' ? 6 * 86_400 : 80 * 86_400;
  const pause = opts.pauseMs ?? 120;
  const merged: KlineCandle[] = [];
  let cursor = Math.floor(opts.startMs / 1000);
  const endSec = Math.floor(opts.endMs / 1000);
  while (cursor < endSec) {
    const chunkEnd = Math.min(endSec, cursor + chunkSec);
    const url = `https://contract.mexc.com/api/v1/contract/kline/${opts.symbol}?interval=${opts.interval}&start=${cursor}&end=${chunkEnd}`;
    const payload = await getJson(fetchImpl, url);
    merged.push(...parseMexcKlines(payload, opts.interval, opts.endMs));
    cursor = chunkEnd;
    if (cursor < endSec && pause > 0) await delay(pause);
  }
  merged.sort((a, b) => a.time - b.time);
  const deduped: KlineCandle[] = [];
  for (const candle of merged) {
    if (candle.time < opts.startMs || candle.time + step > opts.endMs) continue;
    const prev = deduped[deduped.length - 1];
    if (prev && prev.time === candle.time) deduped[deduped.length - 1] = candle;
    else deduped.push(candle);
  }
  return deduped;
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  let last = 'fetch failed';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) {
        last = `HTTP ${res.status}`;
        await delay(400 * (attempt + 1));
        continue;
      }
      const body = (await res.json()) as { success?: boolean; code?: number; message?: string };
      if (body.success === false || (body.code != null && body.code !== 0)) {
        throw new Error(body.message || 'MEXC kline rejected');
      }
      return body;
    } catch (err) {
      last = err instanceof Error ? err.message : 'fetch failed';
      if (attempt === 2) break;
      await delay(400 * (attempt + 1));
    }
  }
  throw new Error(last);
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
