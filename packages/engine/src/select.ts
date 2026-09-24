import type { Candle, FvgBox, NeckPoint, Side, SmashPoint, Structure } from './types.ts';

/**
 * Floors measured on the six-month MEXC tape.
 * Neck at least 0.10% of the sweep, any real gap (2-candle or 3-candle),
 * stop at least 0.15% of entry and one tick past the sweep wick.
 * The limit sits on the first-touch edge of the gap.
 * The ETH morning book still clears this (neck ~0.45%, smash close through the neck).
 */
export const MIN_NECK_FRAC = 0.001;
export const MIN_FVG_FRAC = 0;
export const MIN_STOP_FRAC = 0.0015;

export interface SelectProfile {
  minNeckFrac: number;
  minFvgFrac: number;
  minStopFrac: number;
  requireBos: boolean;
  /** A 2-candle gap counts when it clears the FVG floor. */
  allowTwoCandle: boolean;
  /** When false, the stop stays one tick past the sweep wick. */
  tighterWick: boolean;
  /** far = deep edge of the FVG. near = first-touch edge. mid = gap midpoint. */
  entryAnchor: 'far' | 'near' | 'mid';
}

const DEFAULT_PROFILE: SelectProfile = {
  minNeckFrac: MIN_NECK_FRAC,
  minFvgFrac: MIN_FVG_FRAC,
  minStopFrac: MIN_STOP_FRAC,
  requireBos: true,
  allowTwoCandle: true,
  tighterWick: false,
  entryAnchor: 'near',
};

let active: SelectProfile = { ...DEFAULT_PROFILE };

export function selectProfile(): SelectProfile {
  return active;
}

export function useSelectProfile(next: Partial<SelectProfile>): void {
  active = { ...DEFAULT_PROFILE, ...next };
}

export function neckIsSized(neck: NeckPoint | null, sweepPrice: number): boolean {
  if (!neck || !(sweepPrice > 0)) return false;
  return neck.height / sweepPrice >= active.minNeckFrac;
}

/** Fire path. A 2-candle gap counts only when the active profile allows it and the floor clears. */
export function fvgIsTradable(fvg: FvgBox | null, sweepPrice: number): boolean {
  if (!fvg || !(sweepPrice > 0)) return false;
  if (fvg.kind === '2candle' && !active.allowTwoCandle) return false;
  return (fvg.upper - fvg.lower) / sweepPrice >= active.minFvgFrac;
}

export function stopIsWideEnough(entry: number, sl: number): boolean {
  if (!(entry > 0)) return false;
  return Math.abs(entry - sl) / entry >= active.minStopFrac;
}

/** Long stop sits under the entry. Short stop sits over it. The other side is not a stop. */
export function stopProtects(side: Side, entry: number, sl: number): boolean {
  if (!(entry > 0)) return false;
  return side === 'long' ? sl < entry : sl > entry;
}

/** Smash close through the neck. Same test the chart uses for the BOS label. */
export function smashBrokeNeck(candles: Candle[], structure: Structure): boolean {
  if (!structure.side || !structure.smash || !structure.neck) return false;
  return closeBrokeNeck(candles, structure.side, structure.smash, structure.neck);
}

export function closeBrokeNeck(candles: Candle[], side: Side, smash: SmashPoint, neck: NeckPoint): boolean {
  const bar = candles[smash.index];
  if (!bar) return false;
  return side === 'long' ? bar.close > neck.line : bar.close < neck.line;
}

export interface ReadyPattern {
  sweep: { price: number };
  smash: SmashPoint | null;
  neck: NeckPoint | null;
  fvg: FvgBox | null;
}

/** Structure is large enough to be the choke we keep when a later sweep is noise. */
export function patternClears(candles: Candle[], side: Side, pattern: ReadyPattern): boolean {
  if (!pattern.smash || !pattern.neck?.ok) return false;
  const ref = pattern.sweep.price;
  if (active.requireBos && !closeBrokeNeck(candles, side, pattern.smash, pattern.neck)) return false;
  if (!neckIsSized(pattern.neck, ref)) return false;
  return fvgIsTradable(pattern.fvg, ref);
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
  const broke = structure.smash != null && structure.neck != null && structure.side != null
    ? !active.requireBos || closeBrokeNeck(candles, structure.side, structure.smash, structure.neck)
    : false;
  const completed =
    structure.smash != null &&
    neckReal &&
    broke &&
    neckIsSized(structure.neck, sweepPrice);
  return {
    hasSmash: completed,
    hasFvg: fvgIsTradable(structure.fvg, sweepPrice),
    neckEvaluated: structure.fakeNeck || completed,
    neckOk: neckReal,
  };
}
