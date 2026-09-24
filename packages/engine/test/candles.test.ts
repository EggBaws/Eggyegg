import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  candle,
  clipZone,
  detectStructure,
  entryCapLong,
  entryCapShort,
  hasTimeGap,
  selectStructureCandles,
  smaClose,
  swingHighs,
  swingLows,
  zoneFromEdges,
} from '../src/candles.ts';
import { ethLongCandles, ETH_T0, ethHourly } from '../src/synthetic.ts';
import { ukMidnightMs } from '../src/time.ts';

const T0 = Date.parse('2026-09-24T06:00:00.000Z');
const FIVE = 300_000;

function bars(rows: Array<[number, number, number, number]>, t0 = T0): ReturnType<typeof candle>[] {
  return rows.map((r, i) => candle(t0 + i * FIVE, r[0], r[1], r[2], r[3]));
}

describe('swings and sweeps', () => {
  it('marks a strict swing low', () => {
    const candles = bars([
      [11, 12, 10, 11],
      [11, 12, 9, 10],
      [10, 11, 8, 9],
      [9, 11, 9, 10],
      [10, 12, 10, 11],
      [11, 12, 10.5, 11],
    ]);
    const lows = swingLows(candles);
    assert.deepEqual(lows.map((s) => s.index), [2]);
    assert.equal(lows[0].price, 8);
  });

  it('sweeps when the session low undercuts the prior swing by at least one tick', () => {
    const candles = bars([
      [106, 107, 105, 106],
      [106, 107, 103, 104],
      [104, 105, 100, 102],
      [102, 104, 101, 103],
      [103, 106, 102, 105],
      [105, 106, 103, 104],
      [104, 105, 101, 102],
      [102, 103, 99, 100],
    ]);
    const structure = detectStructure(candles, 0.1, ukMidnightMs(T0));
    assert.equal(structure.side, 'long');
    assert.equal(structure.sweep?.price, 99);
    assert.equal(structure.sweep?.priorSwingPrice, 100);
    assert.ok((structure.sweep?.priorSwingPrice ?? 0) - (structure.sweep?.price ?? 0) >= 0.1);
  });

  it('does not sweep on a half-tick undercut', () => {
    const candles = bars([
      [106, 107, 105, 106],
      [106, 107, 103, 104],
      [104, 105, 100, 102],
      [102, 104, 101, 103],
      [103, 106, 102, 105],
      [105, 106, 103, 104],
      [104, 105, 101, 102],
      [102, 103, 99.95, 100],
    ]);
    const structure = detectStructure(candles, 0.1, ukMidnightMs(T0));
    assert.equal(structure.sweep, null);
    assert.equal(structure.side, null);
  });

  it('detects a sweep before the retired 13:30 UK window', () => {
    const structure = detectStructure(ethLongCandles(), 0.01, ukMidnightMs(ETH_T0));
    assert.equal(structure.side, 'long');
    assert.equal(structure.sweep?.price, 2639.21);
    assert.equal(structure.fakeNeck, false);
    assert.equal(structure.smash?.kind, 'two-candle');
    assert.equal(structure.smash?.extreme, 2670);
    assert.equal(structure.fvg?.kind, '3candle');
    assert.equal(structure.fvg?.lower, 2650);
    assert.equal(structure.fvg?.upper, 2654);
    assert.equal(structure.neck?.ok, true);
    assert.equal(structure.neck?.line, 2651);
    assert.ok(Math.abs((structure.neck?.height ?? 0) - 11.79) < 1e-9);
  });
});

describe('smash, neck, fvg', () => {
  it('spits a fake neck when a new low prints between sweep and smash', () => {
    const candles = bars([
      [106, 107, 105, 106],
      [106, 107, 103, 104],
      [104, 105, 100, 101],
      [101, 103, 100.5, 102],
      [102, 104, 101, 103],
      [103, 104, 101.5, 102],
      [102, 103, 99, 100.5],
      [100.5, 101, 98, 99.5],
      [99.2, 99.4, 99, 99.3],
      [99.3, 104, 99.2, 103],
    ]);
    const structure = detectStructure(candles, 0.1, ukMidnightMs(T0));
    assert.equal(structure.fakeNeck, true);
    assert.equal(structure.neck?.ok, false);
  });

  it('accepts a 2-candle imbalance when no 3-candle gap exists', () => {
    const candles = bars([
      [106, 107, 105, 106],
      [106, 107, 103, 104],
      [104, 105, 100, 101],
      [101, 103, 100.5, 102],
      [102, 104, 101, 103],
      [103, 104, 101.5, 102],
      [102, 102.4, 99, 100],
      [100, 100.4, 99.6, 100.2],
      [100.6, 103, 100.6, 102.5],
    ]);
    const structure = detectStructure(candles, 0.1, ukMidnightMs(T0));
    assert.equal(structure.side, 'long');
    assert.equal(structure.fakeNeck, false);
    assert.ok(structure.fvg);
    assert.equal(structure.fvg?.kind, '2candle');
    assert.equal(structure.fvg?.lower, 100.4);
    assert.equal(structure.fvg?.upper, 100.6);
  });

  it('has no fvg when displacement leaves no gap', () => {
    const candles = bars([
      [106, 107, 105, 106],
      [106, 107, 103, 104],
      [104, 105, 100, 101],
      [101, 103, 100.5, 102],
      [102, 104, 101, 103],
      [103, 104, 101.5, 102],
      [102, 103, 99, 100.2],
      [100.2, 100.8, 99.8, 100.4],
      [100.3, 104, 100, 103],
    ]);
    const structure = detectStructure(candles, 0.1, ukMidnightMs(T0));
    assert.equal(structure.side, 'long');
    assert.equal(structure.neck?.ok, true);
    assert.equal(structure.fvg, null);
  });

  it('mirrors a short sweep, smash, and bearish fvg', () => {
    const candles = bars([
      [100, 101, 99, 100],
      [100, 105, 99.5, 104],
      [104, 110, 103, 106],
      [106, 108, 104, 105],
      [105, 107, 103, 104],
      [104, 106, 102, 103],
      [103, 105, 101, 102],
      [102, 104, 100, 101],
      [102, 112, 100.8, 101.5],
      [101.6, 102, 101.2, 101.5],
      [100.2, 100.3, 96, 97],
    ]);
    const structure = detectStructure(candles, 0.01, ukMidnightMs(T0));
    assert.equal(structure.side, 'short');
    assert.equal(structure.sweep?.price, 112);
    assert.equal(structure.fakeNeck, false);
    assert.equal(structure.smash?.kind, 'two-candle');
    assert.equal(structure.fvg?.kind, '3candle');
    assert.equal(structure.fvg?.upper, 100.8);
    assert.equal(structure.fvg?.lower, 100.3);
    assert.ok(swingHighs(candles).some((s) => s.price === 110));
  });
});

describe('zone and entry cap', () => {
  it('caps a long entry at the min of MA5, midpoint, and fvg lower edge', () => {
    const cap = entryCapLong(2700, 2639.21, 2670, 2650);
    assert.equal(cap, 2650);
    assert.deepEqual(zoneFromEdges(2650, cap), { low: 2650, high: 2650 });
    const deeper = entryCapLong(100.2, 99, 104, 100.5);
    assert.equal(deeper, 100.2);
    assert.deepEqual(zoneFromEdges(100.5, deeper), { low: 100.2, high: 100.5 });
  });

  it('caps a short entry at the max of the mirrored references', () => {
    const cap = entryCapShort(90, 112, 96, 100.8);
    assert.equal(cap, 104);
    assert.deepEqual(zoneFromEdges(100.8, cap), { low: 100.8, high: 104 });
  });

  it('clips a long zone so it does not sit above the live price while inside', () => {
    const clipped = clipZone('long', { low: 100, high: 102 }, 101);
    assert.deepEqual(clipped, { low: 100, high: 101 });
    const above = clipZone('long', { low: 100, high: 100 }, 101);
    assert.deepEqual(above, { low: 100, high: 100 });
  });

  it('uses 1h closes only as an average input', () => {
    assert.equal(smaClose(ethHourly(), 5), 2700);
  });
});

describe('timeframe backup', () => {
  it('keeps 5m when the series is intact', () => {
    const c5 = ethLongCandles();
    const picked = selectStructureCandles(c5, []);
    assert.equal(picked.timeframe, '5m');
    assert.equal(hasTimeGap(c5, FIVE), false);
  });

  it('uses 3m only when a 5m candle is missing', () => {
    const c5 = ethLongCandles();
    const gapped = [c5[0], c5[2]];
    const c3 = [candle(T0, 1, 2, 0.5, 1.5)];
    const picked = selectStructureCandles(gapped, c3);
    assert.equal(picked.timeframe, '3m');
    assert.equal(picked.candles, c3);
  });
});
