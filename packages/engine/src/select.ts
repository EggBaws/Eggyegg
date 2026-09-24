import type { Candle, FvgBox, NeckPoint, Side, Structure } from './types.ts';

/**
 * A setup has to be large enough that a 1-tick sweep cannot fund a stop.
 * These floors still pass the locked ETH morning book (neck ~0.45%, 3-candle
 * FVG ~0.15%, stop ~0.30%, smash close through the neck).
 * Anything smaller stays unfilled: a miss, not a loss.
 */
export const MIN_NECK_FRAC = 0.003;
export const MIN_FVG_FRAC = 0.0008;
export const MIN_STOP_FRAC = 0.002;

export function neckIsSized(neck: NeckPoint | null, sweepPrice: number): boolean {
  if (!neck || !(sweepPrice > 0)) return false;
  return neck.height / sweepPrice >= MIN_NECK_FRAC;
}

/** Fire path only. A 2-candle imbalance is still detected; it is not a take. */
export function fvgIsTradable(fvg: FvgBox | null, sweepPrice: number): boolean {
  if (!fvg || fvg.kind !== '3candle' || !(sweepPrice > 0)) return false;
  return (fvg.upper - fvg.lower) / sweepPrice >= MIN_FVG_FRAC;
}

export function stopIsWideEnough(entry: number, sl: number): boolean {
  if (!(entry > 0)) return false;
  return Math.abs(entry - sl) / entry >= MIN_STOP_FRAC;
}

/** Long stop sits under the entry. Short stop sits over it. The other side is not a stop. */
export function stopProtects(side: Side, entry: number, sl: number): boolean {
  if (!(entry > 0)) return false;
  return side === 'long' ? sl < entry : sl > entry;
}

/** Smash close through the neck. Same test the chart uses for the BOS label. */
export function smashBrokeNeck(candles: Candle[], structure: Structure): boolean {
  if (!structure.side || !structure.smash || !structure.neck) return false;
  const bar = candles[structure.smash.index];
  if (!bar) return false;
  return structure.side === 'long' ? bar.close > structure.neck.line : bar.close < structure.neck.line;
}

export interface SelectiveFacts {
  hasSmash: boolean;
  hasFvg: boolean;
  neckEvaluated: boolean;
  neckOk: boolean;
}

/**
 * FAKE_NECK stays a hard spit. A smash that does not close through a sized neck
 * stays FORMING so the book misses it instead of arming it.
 */
export function selectiveFacts(candles: Candle[], structure: Structure): SelectiveFacts {
  const sweepPrice = structure.sweep?.price ?? 0;
  const neckReal = structure.neck?.ok === true;
  const completed =
    structure.smash != null &&
    neckReal &&
    smashBrokeNeck(candles, structure) &&
    neckIsSized(structure.neck, sweepPrice);
  return {
    hasSmash: completed,
    hasFvg: fvgIsTradable(structure.fvg, sweepPrice),
    neckEvaluated: structure.fakeNeck || completed,
    neckOk: neckReal,
  };
}
