import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, runBacktest, useSelectProfile, type PairSeries, type SelectProfile } from '../packages/engine/src/index.ts';
import type { PairId } from '../packages/engine/src/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(join(root, 'config/default.json'));
if (process.env.SWEEP_ARMS) config.max_arms_per_pair_per_day = Number(process.env.SWEEP_ARMS);
const dataDir = join(root, 'data');

function load(pair: PairId, interval: 'Min5' | 'Min60'): PairSeries['m5'] {
  const path = join(dataDir, `${pair}-${interval}.json`);
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as PairSeries['m5'];
}

const series = {
  BTCUSDT: { m5: load('BTCUSDT', 'Min5'), h1: load('BTCUSDT', 'Min60') },
  ETHUSDT: { m5: load('ETHUSDT', 'Min5'), h1: load('ETHUSDT', 'Min60') },
  SOLUSDT: { m5: load('SOLUSDT', 'Min5'), h1: load('SOLUSDT', 'Min60') },
} as Record<PairId, PairSeries>;

const name = process.env.SWEEP_NAME ?? 'default';
const profile = process.env.SWEEP_PROFILE ? (JSON.parse(process.env.SWEEP_PROFILE) as Partial<SelectProfile>) : {};
useSelectProfile(profile);
const report = await runBacktest(config, series);
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
  }),
);
