import type { ChartMark } from './marks.ts';
import { stepProtect } from './runner.ts';
import { positionQty } from './risk.ts';
import { ukDateIso, ukDateKey } from './time.ts';
import type { AppConfig, Candle, PairId, Side } from './types.ts';
import { ChokeEngine, type NotifierPort, type VenuePort } from './engine.ts';

const FIVE = 5 * 60_000;
const HOUR = 60 * 60_000;
const WINDOW = 360;
const CHART_BARS = 80;
const AHEAD_BARS = 48;

export interface BacktestTrade {
  id: string;
  pair: PairId;
  side: Side;
  sessionDate: string;
  entryTime: number;
  exitTime: number | null;
  entry: number;
  sl: number;
  lock: number;
  tp: number;
  qty: number;
  outcome: 'WIN' | 'LOSS' | 'MISS' | 'OPEN';
  pnlGbp: number;
  exitPrice: number | null;
  candles: Candle[];
  marks: ChartMark[];
}

export interface PairScore {
  wins: number;
  losses: number;
  misses: number;
  open: number;
  netPnlGbp: number;
}

export interface BacktestReport {
  generatedAt: string;
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
  wins: number;
  losses: number;
  misses: number;
  open: number;
  winRate: number | null;
  netPnlGbp: number;
  byPair: Record<PairId, PairScore>;
  trades: BacktestTrade[];
}

export interface PairSeries {
  m5: Candle[];
  h1: Candle[];
}

interface OpenTrade {
  pair: PairId;
  side: Side;
  sessionDate: string;
  armIndex: number;
  entryTime: number;
  entry: number;
  sl: number;
  lock: number;
  tp: number;
  qty: number;
  candles: Candle[];
  marks: ChartMark[];
  filled: boolean;
  locked: boolean;
}

/**
 * Walk-forward replay. Each bar is decided with candles that have already closed.
 * A limit is not filled on the signal bar. The same bar hitting stop and target is a loss.
 * An unfilled or invalidated setup is a miss and is not part of the win rate.
 * Paper pnl is qty × price distance, with the config stake in GBP and no FX conversion.
 */
export async function runBacktest(
  config: AppConfig,
  series: Record<PairId, PairSeries>,
  opts: { window?: number; barMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<BacktestReport> {
  const window = opts.window ?? WINDOW;
  const barMs = opts.barMs ?? FIVE;
  const engine = new ChokeEngine({
    config,
    venue: paperVenue(),
    notifier: silentNotifier(),
    dryRunPath: 'backtest-unused.json',
    skipOrderLog: true,
  });

  const indexOf = new Map<PairId, Map<number, number>>();
  const times = new Set<number>();
  for (const pair of config.pairs) {
    const map = new Map<number, number>();
    const bars = series[pair]?.m5 ?? [];
    for (let i = 0; i < bars.length; i++) {
      map.set(bars[i].time, i);
      times.add(bars[i].time);
    }
    indexOf.set(pair, map);
  }
  const timeline = [...times].sort((a, b) => a - b);
  const open = new Map<PairId, OpenTrade>();
  const trades: BacktestTrade[] = [];

  for (let n = 0; n < timeline.length; n++) {
    const time = timeline[n];
    const nowMs = time + barMs + 500;
    const day = ukDateKey(nowMs);

    for (const pair of config.pairs) {
      const idx = indexOf.get(pair)?.get(time);
      if (idx == null) continue;
      const trade = open.get(pair);
      if (!trade) continue;
      const bars = series[pair].m5;
      if (!trade.filled && trade.sessionDate !== day) {
        trades.push(asTrade(trade, 'MISS', null, null));
        engine.releaseUnfilled(pair, nowMs, 'UNFILLED');
        open.delete(pair);
        continue;
      }
      if (idx <= trade.armIndex) continue;
      const step = stepProtect(trade, bars[idx]);
      trade.filled = step.filled;
      trade.locked = step.locked;
      if (!step.outcome || step.exit == null) continue;
      const outcome = step.outcome;
      const exitPrice = step.exit;
      const pnl = paperPnl(trade.side, trade.qty, trade.entry, exitPrice);
      if (trade.locked) {
        for (const mark of trade.marks) {
          if (mark.kind === 'SL') mark.price = trade.lock;
        }
      }
      const followEnd = Math.min(bars.length, idx + 1 + AHEAD_BARS);
      const chart = extendChart(trade.candles, trade.marks, bars.slice(trade.armIndex + 1, followEnd));
      engine.realizePnl(pnl, nowMs);
      engine.markClosed(pair, nowMs);
      trades.push({
        ...asTrade(trade, outcome, exitPrice, bars[idx].time + barMs),
        pnlGbp: pnl,
        candles: chart.candles,
        marks: chart.marks,
      });
      open.delete(pair);
    }

    const batch: { pair: PairId; idx: number }[] = [];
    for (const pair of config.pairs) {
      if (open.get(pair)?.filled) continue;
      const idx = indexOf.get(pair)?.get(time);
      if (idx == null) continue;
      batch.push({ pair, idx });
    }
    batch.sort((a, b) => pairRank(a.pair) - pairRank(b.pair));
    for (const item of batch) {
      const bars = series[item.pair].m5;
      const start = Math.max(0, item.idx + 1 - window);
      const candles5m = bars.slice(start, item.idx + 1);
      const last = candles5m[candles5m.length - 1];
      const view = await engine.ingest({
        pair: item.pair,
        candles5m,
        candles1h: hourlyInto(series[item.pair].h1, nowMs),
        lastPrice: last.close,
        nowMs,
      });
      const rt = engine.runtime(item.pair);
      const existing = open.get(item.pair);
      if (existing && !existing.filled && rt.state !== 'WORKING') {
        trades.push(asTrade(existing, 'MISS', null, null));
        open.delete(item.pair);
        continue;
      }
      if (!existing && rt.state === 'WORKING' && rt.order && rt.side) {
        const frozen = freezeChart(view.candles, view.marks);
        open.set(item.pair, {
          pair: item.pair,
          side: rt.side,
          sessionDate: day,
          armIndex: item.idx,
          entryTime: time,
          entry: rt.order.price,
          sl: rt.order.sl,
          lock: rt.order.lockPrice,
          tp: rt.order.tp,
          qty: rt.order.qty,
          candles: frozen.candles,
          marks: frozen.marks,
          filled: false,
          locked: false,
        });
      }
    }
    if (opts.onProgress && (n + 1) % 5000 === 0) opts.onProgress(n + 1, timeline.length);
  }

  const endTime = timeline.length ? timeline[timeline.length - 1] : 0;
  for (const trade of open.values()) {
    const bars = series[trade.pair].m5;
    const extra = bars.slice(trade.armIndex + 1, Math.min(bars.length, trade.armIndex + 1 + 160));
    if (trade.locked) {
      for (const mark of trade.marks) {
        if (mark.kind === 'SL') mark.price = trade.lock;
      }
    }
    const chart = extendChart(trade.candles, trade.marks, extra);
    const row = asTrade(trade, trade.filled ? 'OPEN' : 'MISS', null, null);
    row.candles = chart.candles;
    row.marks = chart.marks;
    trades.push(row);
  }
  if (opts.onProgress) opts.onProgress(timeline.length, timeline.length);
  return summarize(config.pairs, trades, timeline[0] ?? endTime, endTime, barMs);
}

export function paperPnl(side: Side, qty: number, entry: number, exit: number): number {
  const diff = side === 'long' ? exit - entry : entry - exit;
  return qty * diff;
}

export function stakeQty(config: AppConfig, entry: number, sl: number): number {
  return positionQty(config.stake_gbp, config.leverage, entry, sl, config.max_margin_risk);
}

function asTrade(
  trade: OpenTrade,
  outcome: BacktestTrade['outcome'],
  exitPrice: number | null,
  exitTime: number | null,
): BacktestTrade {
  return {
    id: `${trade.pair}-${trade.entryTime}`,
    pair: trade.pair,
    side: trade.side,
    sessionDate: trade.sessionDate,
    entryTime: trade.entryTime,
    exitTime,
    entry: trade.entry,
    sl: trade.locked ? trade.lock : trade.sl,
    lock: trade.lock,
    tp: trade.tp,
    qty: trade.qty,
    outcome,
    pnlGbp: 0,
    exitPrice,
    candles: trade.candles,
    marks: trade.marks,
  };
}

function summarize(pairs: PairId[], trades: BacktestTrade[], fromMs: number, toMs: number, barMs = FIVE): BacktestReport {
  const byPair = {} as Record<PairId, PairScore>;
  for (const pair of pairs) byPair[pair] = { wins: 0, losses: 0, misses: 0, open: 0, netPnlGbp: 0 };
  let wins = 0;
  let losses = 0;
  let misses = 0;
  let open = 0;
  let net = 0;
  for (const trade of trades) {
    const row = byPair[trade.pair];
    if (trade.outcome === 'WIN') {
      wins += 1;
      row.wins += 1;
      row.netPnlGbp += trade.pnlGbp;
      net += trade.pnlGbp;
    } else if (trade.outcome === 'LOSS') {
      losses += 1;
      row.losses += 1;
      row.netPnlGbp += trade.pnlGbp;
      net += trade.pnlGbp;
    } else if (trade.outcome === 'OPEN') {
      open += 1;
      row.open += 1;
    } else {
      misses += 1;
      row.misses += 1;
    }
  }
  const decided = wins + losses;
  return {
    generatedAt: new Date().toISOString(),
    from: fromMs ? ukDateIso(fromMs) : '',
    to: toMs ? ukDateIso(toMs + barMs) : '',
    fromMs,
    toMs,
    wins,
    losses,
    misses,
    open,
    winRate: decided === 0 ? null : wins / decided,
    netPnlGbp: net,
    byPair,
    trades: trades.sort((a, b) => a.entryTime - b.entryTime),
  };
}

function hourlyInto(candles: Candle[], nowMs: number): Candle[] {
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time + HOUR <= nowMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ans < 0) return [];
  return candles.slice(Math.max(0, ans - 4), ans + 1);
}

export function freezeChart(candles: Candle[], marks: ChartMark[]): { candles: Candle[]; marks: ChartMark[] } {
  let start = Math.max(0, candles.length - CHART_BARS);
  for (const mark of marks) {
    if (mark.kind === 'SWEEP' || mark.kind === 'FVG' || mark.kind === 'MSS' || mark.kind === 'ENTRY') {
      start = Math.min(start, Math.max(0, mark.fromIndex - 2));
    }
  }
  if (candles.length - start > CHART_BARS) start = candles.length - CHART_BARS;
  return shiftMarks(candles.slice(start), marks, start);
}

export function extendChart(
  candles: Candle[],
  marks: ChartMark[],
  extra: Candle[],
): { candles: Candle[]; marks: ChartMark[] } {
  if (extra.length === 0) return { candles, marks };
  const merged = candles.concat(extra);
  const last = Math.max(0, merged.length - 1);
  const next: ChartMark[] = [];
  for (const mark of marks) {
    if (mark.fromIndex > last) continue;
    if (mark.kind === 'MSS' || mark.kind === 'BOS') {
      next.push({ ...mark, toIndex: mark.fromIndex });
      continue;
    }
    next.push({ ...mark, toIndex: last });
  }
  return { candles: merged, marks: next };
}

function shiftMarks(candles: Candle[], marks: ChartMark[], drop: number): { candles: Candle[]; marks: ChartMark[] } {
  const last = Math.max(0, candles.length - 1);
  const next: ChartMark[] = [];
  for (const mark of marks) {
    if (mark.kind === 'MSS' || mark.kind === 'BOS') {
      const idx = mark.fromIndex - drop;
      if (idx < 0 || idx > last) continue;
      next.push({ ...mark, fromIndex: idx, toIndex: idx });
      continue;
    }
    if (mark.fromIndex - drop > last) continue;
    next.push({ ...mark, fromIndex: Math.max(0, mark.fromIndex - drop), toIndex: last });
  }
  return { candles, marks: next };
}

function pairRank(pair: PairId): number {
  if (pair === 'BTCUSDT') return 0;
  if (pair === 'ETHUSDT') return 1;
  return 2;
}

function paperVenue(): VenuePort {
  return {
    id: 'kucoin',
    health: () => ({ ok: true }),
    placeLimitWithProtection: () => ({ ok: true, orderId: 'paper' }),
  };
}

function silentNotifier(): NotifierPort {
  return { ping() {} };
}
