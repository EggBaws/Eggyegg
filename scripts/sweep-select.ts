import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, runBacktest, useSelectProfile, type PairSeries, type SelectProfile } from '../packages/engine/src/index.ts';
import type { PairId } from '../packages/engine/src/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(join(root, 'config/default.json'));
if (process.env.SWEEP_ARMS) config.max_arms_per_pair_per_day = Number(process.env.SWEEP_ARMS);
if (process.env.SWEEP_FILLS) config.max_fills_across_book = Number(process.env.SWEEP_FILLS);
if (process.env.SWEEP_TP) config.tp_price_pct = Number(process.env.SWEEP_TP);
const dataDir = join(root, 'data');

function load(pair: PairId, interval: 'Min5' | 'Min60' | 'Min3'): PairSeries['m5'] {
  const path = join(dataDir, `${pair}-${interval}.json`);
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as PairSeries['m5'];
}

const barMs = process.env.SWEEP_BAR === '3' ? 180_000 : 300_000;
const series = {
  BTCUSDT: { m5: load('BTCUSDT', barMs === 180_000 ? 'Min3' : 'Min5'), h1: barMs === 180_000 ? [] : load('BTCUSDT', 'Min60') },
  ETHUSDT: { m5: load('ETHUSDT', barMs === 180_000 ? 'Min3' : 'Min5'), h1: barMs === 180_000 ? [] : load('ETHUSDT', 'Min60') },
  SOLUSDT: { m5: load('SOLUSDT', barMs === 180_000 ? 'Min3' : 'Min5'), h1: barMs === 180_000 ? [] : load('SOLUSDT', 'Min60') },
} as Record<PairId, PairSeries>;

const name = process.env.SWEEP_NAME ?? 'default';
const profile = process.env.SWEEP_PROFILE ? (JSON.parse(process.env.SWEEP_PROFILE) as Partial<SelectProfile>) : {};
useSelectProfile(profile);
const report = await runBacktest(config, series, { barMs, window: barMs === 180_000 ? 800 : 360 });
const decided = report.wins + report.losses;
console.log(
  JSON.stringify({
    name,
    profile,
    wins: report.wins,
    losses: report.losses,
    misses: report.misses,
    open: report.open,
    winRate: report.winRate,
    net: Math.round(report.netPnlGbp * 100) / 100,
    decided,
    perMonth: Math.round((report.wins / 6) * 10) / 10,
    months: monthWins(report.trades),
  }),
);

function monthWins(trades: { sessionDate: string; outcome: string }[]): string {
  const by = new Map<string, number>();
  for (const trade of trades) {
    if (trade.outcome !== 'WIN') continue;
    const key = trade.sessionDate.slice(0, 6);
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  return [...by.entries()].sort().map(([k, n]) => `${k}:${n}`).join(',');
}
