import { candle } from './candles.ts';
import type { Candle, MarketUpdate } from './types.ts';

const FIVE = 5 * 60_000;

/**
 * Hand-built ETH long that satisfies sweep, 2-candle smash, 3-candle FVG, and a first tag.
 * Clock is 08:00 UK on 24 Sep 2026 — outside the retired 13:30 window — and must still arm.
 *
 * Sweep wick 2639.21 undercuts swing 2645.
 * First touch of the FVG is 2654, but the live price is 2650.20 so the limit rests there.
 * Stop is one tick past the sweep wick: 2639.20. TP = 2650.20 * 1.0112 = 2679.88.
 */
export const ETH_T0 = Date.parse('2026-09-24T06:00:00.000Z');

export function ethLongCandles(t0 = ETH_T0): Candle[] {
  const rows: Array<[number, number, number, number]> = [
    [2662, 2666, 2660, 2664],
    [2664, 2668, 2652, 2656],
    [2656, 2660, 2645, 2650],
    [2650, 2658, 2648, 2656],
    [2656, 2664, 2654, 2662],
    [2662, 2666, 2658, 2660],
    [2660, 2663, 2655, 2658],
    [2658, 2661, 2652, 2654],
    [2649, 2650, 2639.21, 2648],
    [2644, 2651, 2642, 2648],
    [2655, 2670, 2654, 2668],
    [2664, 2666, 2649.8, 2650.2],
  ];
  return rows.map((r, i) => candle(t0 + i * FIVE, r[0], r[1], r[2], r[3]));
}

export function ethNowMs(t0 = ETH_T0): number {
  const lastOpen = t0 + 11 * FIVE;
  return lastOpen + FIVE + 500;
}

export function ethHourly(t0 = ETH_T0): Candle[] {
  const closes = [2700, 2710, 2690, 2720, 2680];
  return closes.map((close, i) => {
    const time = t0 - (closes.length - i) * 60 * 60_000;
    return candle(time, close - 2, close + 4, close - 6, close);
  });
}

export function ethContext30m(t0 = ETH_T0): Candle[] {
  return [
    candle(t0 - 60 * 60_000, 2680, 2690, 2670, 2688),
    candle(t0 - 30 * 60_000, 2688, 2695, 2675, 2692),
  ];
}

export function btcFlatCandles(t0 = ETH_T0): Candle[] {
  const rows: Array<[number, number, number, number]> = [
    [100, 101, 99, 100.5],
    [100.5, 102, 100, 101],
    [101, 103, 100.5, 102],
    [102, 104, 101, 103],
    [103, 105, 102, 104],
    [104, 106, 103, 105],
    [105, 107, 104, 106],
    [106, 108, 105, 107],
  ];
  return rows.map((r, i) => candle(t0 + i * FIVE, r[0], r[1], r[2], r[3]));
}

/** Sweep printed, smash not yet — SOL stays FORMING and may arm on its own later. */
export function solFormingCandles(t0 = ETH_T0): Candle[] {
  const rows: Array<[number, number, number, number]> = [
    [152.5, 152.8, 152, 152.4],
    [152.4, 152.6, 151.4, 151.8],
    [151.8, 152, 150, 150.6],
    [150.6, 151.2, 150.4, 151],
    [151, 151.6, 150.8, 151.4],
    [151.4, 151.8, 151, 151.2],
    [151.2, 151.5, 150.7, 150.9],
    [150.9, 151, 149.2, 149.6],
  ];
  return rows.map((r, i) => candle(t0 + i * FIVE, r[0], r[1], r[2], r[3]));
}

export function demoBook(t0 = ETH_T0): { nowMs: number; updates: MarketUpdate[] } {
  const nowMs = ethNowMs(t0);
  const updates: MarketUpdate[] = [
    {
      pair: 'BTCUSDT',
      candles5m: btcFlatCandles(t0),
      candles1h: ethHourly(t0).map((c, i) => candle(c.time, 100 + i, 101 + i, 99 + i, 100.2 + i)),
      candles30m: ethContext30m(t0),
      lastPrice: 107,
      nowMs,
    },
    {
      pair: 'ETHUSDT',
      candles5m: ethLongCandles(t0),
      candles1h: ethHourly(t0),
      candles30m: ethContext30m(t0),
      lastPrice: 2650.2,
      nowMs,
    },
    {
      pair: 'SOLUSDT',
      candles5m: solFormingCandles(t0),
      candles1h: ethHourly(t0).map((c) => candle(c.time, 150, 152, 148, 151)),
      candles30m: ethContext30m(t0),
      lastPrice: 149.6,
      nowMs,
    },
  ];
  return { nowMs, updates };
}
