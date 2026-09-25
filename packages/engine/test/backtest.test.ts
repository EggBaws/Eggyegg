import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { candle } from '../src/candles.ts';
import { loadConfig } from '../src/config.ts';
import { extendChart, runBacktest } from '../src/backtest.ts';
import type { ChartMark } from '../src/marks.ts';
import { ethHourly, ethLongCandles, ETH_T0 } from '../src/synthetic.ts';
import type { Candle, PairId } from '../src/types.ts';
import { findRepoRoot } from './root.ts';

const FIVE = 5 * 60_000;
const DAY = 24 * 60 * 60_000;

function shift(candles: Candle[], delta: number): Candle[] {
  return candles.map((c) => candle(c.time + delta, c.open, c.high, c.low, c.close));
}

describe('backtest', () => {
  it('scores a win and a same-bar stop-and-target loss on two UK days', async () => {
    const config = loadConfig(join(findRepoRoot(), 'config/default.json'));
    const winBar = candle(ETH_T0 + 12 * FIVE, 2652, 2690, 2649.9, 2686);
    const backToLock = candle(ETH_T0 + 13 * FIVE, 2686, 2688, 2685, 2686);
    const day2 = ETH_T0 + DAY;
    const lossBar = candle(day2 + 12 * FIVE, 2652, 2690, 2630, 2644);
    const eth = ethLongCandles().concat([winBar, backToLock], shift(ethLongCandles(day2), 0), [lossBar]);
    const hourly = ethHourly().concat(shift(ethHourly(day2), 0));
    const empty: Candle[] = [];
    const series = {
      BTCUSDT: { m5: empty, h1: empty },
      ETHUSDT: { m5: eth, h1: hourly },
      SOLUSDT: { m5: empty, h1: empty },
    } as Record<PairId, { m5: Candle[]; h1: Candle[] }>;
    const report = await runBacktest(config, series);
    const wins = report.trades.filter((t) => t.outcome === 'WIN');
    const losses = report.trades.filter((t) => t.outcome === 'LOSS');
    assert.equal(wins.length, 1);
    assert.equal(losses.length, 1);
    assert.equal(report.wins, 1);
    assert.equal(report.losses, 1);
    assert.ok(wins[0].pnlGbp > 0);
    assert.ok(losses[0].pnlGbp < 0);
    assert.equal(losses[0].exitPrice, losses[0].sl);
    assert.equal(wins[0].exitPrice, wins[0].sl);
    assert.ok(wins[0].tp > wins[0].exitPrice);
    assert.equal(wins[0].marks.find((m) => m.kind === 'SL')?.price, wins[0].lock);
    assert.ok(wins[0].marks.some((m) => m.kind === 'LOCK'));
    assert.ok(wins[0].marks.some((m) => m.kind === 'FVG'));
    assert.ok(wins[0].marks.some((m) => m.kind === 'BOS'));
    assert.ok(wins[0].marks.some((m) => m.kind === 'MSS'));
    assert.ok(wins[0].marks.some((m) => m.kind === 'ENTRY'));
    assert.ok(wins[0].marks.some((m) => m.kind === 'TP'));
    assert.ok(wins[0].marks.some((m) => m.kind === 'SL'));
    assert.ok(report.winRate != null && report.winRate > 0 && report.winRate < 1);
    assert.equal(report.netPnlGbp, wins[0].pnlGbp + losses[0].pnlGbp);
  });

  it('keeps the smash mark when follow-through is longer than the chart', () => {
    const candles = Array.from({ length: 80 }, (_, i) => candle(i * FIVE, 10, 11, 9, 10.4));
    const marks: ChartMark[] = [
      { kind: 'MSS', label: 'MSS', color: 'amber', fromIndex: 70, toIndex: 70, price: 11 },
      { kind: 'ENTRY', label: 'ENTRY', color: 'green', fromIndex: 71, toIndex: 79, price: 10 },
    ];
    const extra = Array.from({ length: 40 }, (_, i) => candle((80 + i) * FIVE, 10, 11, 9, 10.2));
    const chart = extendChart(candles, marks, extra);
    assert.equal(chart.candles.length, 120);
    assert.equal(chart.marks.find((m) => m.kind === 'MSS')?.fromIndex, 70);
    assert.equal(chart.marks.find((m) => m.kind === 'ENTRY')?.toIndex, 119);
  });
});
