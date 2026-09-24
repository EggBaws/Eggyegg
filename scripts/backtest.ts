import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, runBacktest, type PairSeries } from '../packages/engine/src/index.ts';
import { fetchMexcKlines } from '../packages/venues/src/index.ts';
import type { PairId } from '../packages/engine/src/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(join(root, 'config/default.json'));
const dataDir = join(root, 'data');
const outPath = join(root, 'logs/backtest.json');
const SYMBOL: Record<PairId, string> = {
  BTCUSDT: 'BTC_USDT',
  ETHUSDT: 'ETH_USDT',
  SOLUSDT: 'SOL_USDT',
};

const endMs = Date.now();
const startMs = endMs - 183 * 24 * 60 * 60_000;

mkdirSync(dataDir, { recursive: true });

function cachePath(pair: PairId, interval: 'Min5' | 'Min60'): string {
  return join(dataDir, `${pair}-${interval}.json`);
}

async function load(pair: PairId, interval: 'Min5' | 'Min60'): Promise<PairSeries['m5']> {
  const path = cachePath(pair, interval);
  if (existsSync(path) && process.env.BACKTEST_REFRESH !== '1') {
    console.log(`cache ${pair} ${interval}`);
    return JSON.parse(readFileSync(path, 'utf8')) as PairSeries['m5'];
  }
  console.log(`fetch ${pair} ${interval}`);
  const candles = await fetchMexcKlines({
    symbol: SYMBOL[pair],
    interval,
    startMs,
    endMs,
  });
  writeFileSync(path, JSON.stringify(candles));
  console.log(`  ${candles.length} bars`);
  return candles;
}

const series = {} as Record<PairId, PairSeries>;
for (const pair of config.pairs) {
  series[pair] = {
    m5: await load(pair, 'Min5'),
    h1: await load(pair, 'Min60'),
  };
}

const started = Date.now();
const report = await runBacktest(config, series, {
  onProgress(done, total) {
    console.log(`replay ${done}/${total}`);
  },
});
const slim = {
  ...report,
  trades: report.trades.map((trade) => ({
    ...trade,
    candles: trade.candles.slice(-80),
  })),
};
writeFileSync(outPath, JSON.stringify(slim));
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `${report.from} → ${report.to}  wins ${report.wins}  losses ${report.losses}  misses ${report.misses}  open ${report.open}  winRate ${
    report.winRate == null ? '—' : (report.winRate * 100).toFixed(1) + '%'
  }  net £${report.netPnlGbp.toFixed(2)}  ${seconds}s`,
);
console.log(`wrote ${isAbsolute(outPath) ? outPath : outPath}`);
for (const pair of config.pairs) {
  const row = report.byPair[pair];
  console.log(`  ${pair} W${row.wins} L${row.losses} miss ${row.misses} £${row.netPnlGbp.toFixed(2)}`);
}
