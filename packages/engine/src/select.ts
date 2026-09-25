import type { Candle, FvgBox, NeckPoint, Side, SmashPoint, Structure } from './types.ts';

/**
 * Floors measured on the six-month MEXC tape for a 0.50% target.
 * Neck at least 0.10% of the sweep, any real gap (2-candle or 3-candle).
 * Stop one tick past the sweep and at least 0.15% of entry.
 * The 1.12% target paid about eight times a month. 0.50% is what puts a full
 * month inside 15–25 wins. The ETH morning book still clears this.
 */
export const MIN_NECK_FRAC = 0.001;
export const MIN_FVG_FRAC = 0;
export const MIN_STOP_FRAC = 0.0015;
/** 1 = off. A hard cap here cuts the monthly win count back under 15. */
export const MAX_STOP_FRAC = 1;
export const MAX_NECK_FRAC = 1;
export const MAX_SMASH_AGE = 10_000;
export const MAX_SWEEP_BARS = 10_000;

export interface SelectProfile {
  minNeckFrac: number;
  minFvgFrac: number;
  minStopFrac: number;
  /** Stop distance at or beyond this fraction of entry does not arm. */
  maxStopFrac: number;
  /** Neck taller than this fraction of the sweep does not arm. */
  maxNeckFrac: number;
  /** Bars from the smash close to the signal. Older displacement does not arm. */
  maxSmashAge: number;
  /** Bars from sweep to smash. A slow break does not arm. */
  maxSweepBars: number;
  requireBos: boolean;
  /** A 2-candle gap counts when it clears the FVG floor. */
  allowTwoCandle: boolean;
  /** When false, the stop stays one tick past the sweep wick. */
  tighterWick: boolean;
  /** far = deep edge of the FVG. near = first-touch edge. mid = gap midpoint. */
  entryAnchor: 'far' | 'near' | 'mid';
  /** Bars on each side of a swing. 2/2 is the choke swing. 1/1 finds more local sweeps. */
  swingLeft: number;
  swingRight: number;
}

const DEFAULT_PROFILE: SelectProfile = {
  minNeckFrac: MIN_NECK_FRAC,
  minFvgFrac: MIN_FVG_FRAC,
  minStopFrac: MIN_STOP_FRAC,
  maxStopFrac: MAX_STOP_FRAC,
  maxNeckFrac: MAX_NECK_FRAC,
  maxSmashAge: MAX_SMASH_AGE,
  maxSweepBars: MAX_SWEEP_BARS,
  requireBos: true,
  allowTwoCandle: true,
  tighterWick: false,
  entryAnchor: 'near',
  swingLeft: 2,
  swingRight: 2,
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

/** A stop at least maxStopFrac away from entry cannot pay the 1.12% target often enough. */
export function stopIsWithinCap(entry: number, sl: number): boolean {
  if (!(entry > 0)) return false;
  if (!(active.maxStopFrac < 1)) return true;
  return Math.abs(entry - sl) / entry < active.maxStopFrac;
}

export function neckIsNotHuge(neck: NeckPoint | null, sweepPrice: number): boolean {
  if (!neck || !(sweepPrice > 0)) return false;
  if (!(active.maxNeckFrac < 1)) return true;
  return neck.height / sweepPrice <= active.maxNeckFrac;
}

export function impulseIsFresh(sweepIndex: number, smashIndex: number, lastIndex: number): boolean {
  if (smashIndex - sweepIndex > active.maxSweepBars) return false;
  if (lastIndex - smashIndex > active.maxSmashAge) return false;
  return true;
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
  sweep: { price: number; index: number };
  smash: SmashPoint | null;
  neck: NeckPoint | null;
  fvg: FvgBox | null;
}

/** Structure is large enough, and not too stretched, to be the choke we keep. */
export function patternClears(candles: Candle[], side: Side, pattern: ReadyPattern): boolean {
  if (!pattern.smash || !pattern.neck?.ok || !pattern.fvg) return false;
  const ref = pattern.sweep.price;
  if (active.requireBos && !closeBrokeNeck(candles, side, pattern.smash, pattern.neck)) return false;
  if (!neckIsSized(pattern.neck, ref) || !neckIsNotHuge(pattern.neck, ref)) return false;
  if (!fvgIsTradable(pattern.fvg, ref)) return false;
  if (!impulseIsFresh(pattern.sweep.index, pattern.smash.index, candles.length - 1)) return false;
  return zoneCanHostStop(side, ref, pattern.fvg);
}

/**
 * The stop is one tick past the sweep. A long can only get tighter by filling
 * deeper in the gap, so the lower edge is the tightest stop the zone can host.
 * A short is the mirror. If even that edge is past the cap, the pattern cannot arm.
 */
function zoneCanHostStop(side: Side, sweepPrice: number, fvg: FvgBox): boolean {
  const entry = side === 'long' ? fvg.lower : fvg.upper;
  return stopIsWithinCap(entry, sweepPrice);
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
  const fresh =
    structure.sweep != null && structure.smash != null
      ? impulseIsFresh(structure.sweep.index, structure.smash.index, candles.length - 1)
      : false;
  const anchorOk =
    structure.fvg == null || structure.side == null
      ? structure.fvg == null
      : zoneCanHostStop(structure.side, sweepPrice, structure.fvg);
  const completed =
    structure.smash != null &&
    neckReal &&
    broke &&
    fresh &&
    anchorOk &&
    neckIsSized(structure.neck, sweepPrice) &&
    neckIsNotHuge(structure.neck, sweepPrice);
  return {
    hasSmash: completed,
    hasFvg: fvgIsTradable(structure.fvg, sweepPrice),
    neckEvaluated: structure.fakeNeck || completed,
    neckOk: neckReal,
  };
}
