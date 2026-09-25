import { EPS, gte, lte } from './math.ts';
import { patternClears, selectProfile } from './select.ts';
import type { Candle, FvgBox, NeckPoint, Side, SmashPoint, Structure, SwingPoint, SweepPoint, Zone } from './types.ts';

export function candle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  closed = true,
): Candle {
  if (high < open || high < close || high < low || low > open || low > close) {
    throw new Error(`invalid candle @ ${time} o=${open} h=${high} l=${low} c=${close}`);
  }
  return { time, open, high, low, close, closed };
}

export function bodyHigh(c: Candle): number {
  return Math.max(c.open, c.close);
}

export function bodyLow(c: Candle): number {
  return Math.min(c.open, c.close);
}

export function swingLows(candles: Candle[], left = 2, right = 2): SwingPoint[] {
  return swings(candles, left, right, 'low');
}

export function swingHighs(candles: Candle[], left = 2, right = 2): SwingPoint[] {
  return swings(candles, left, right, 'high');
}

function swings(candles: Candle[], left: number, right: number, field: 'low' | 'high'): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = left; i < candles.length - right; i++) {
    if (!candles[i].closed) continue;
    let ok = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (!candles[j].closed) {
        ok = false;
        break;
      }
      if (field === 'low' && candles[j].low <= candles[i].low) ok = false;
      if (field === 'high' && candles[j].high >= candles[i].high) ok = false;
      if (!ok) break;
    }
    if (ok) out.push({ index: i, price: candles[i][field], time: candles[i].time });
  }
  return out;
}

export function hasTimeGap(candles: Candle[], tfMs: number): boolean {
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].time - candles[i - 1].time > tfMs + 1) return true;
  }
  return false;
}

/** 3m is used only when a 5m candle is missing. Otherwise structure stays on 5m. */
export function selectStructureCandles(
  candles5m: Candle[],
  candles3m: Candle[] | undefined,
): { candles: Candle[]; timeframe: '5m' | '3m' } {
  const five = 5 * 60_000;
  if (hasTimeGap(candles5m, five) && candles3m && candles3m.length > 0) {
    return { candles: candles3m, timeframe: '3m' };
  }
  return { candles: candles5m, timeframe: '5m' };
}

export function smaClose(candles: Candle[] | undefined, n: number): number | null {
  if (!candles) return null;
  const closed = candles.filter((c) => c.closed);
  if (closed.length < n) return null;
  const slice = closed.slice(-n);
  return slice.reduce((s, c) => s + c.close, 0) / n;
}

function findSmashLong(candles: Candle[], sweepIndex: number): SmashPoint | null {
  const sweep = candles[sweepIndex];
  const level = bodyHigh(sweep);
  for (let j = sweepIndex + 1; j < candles.length; j++) {
    const c = candles[j];
    if (!c.closed) continue;
    if (c.open <= level && c.close > level && c.close > c.open) {
      return { index: j, extreme: c.high, timeMs: c.time, kind: 'single' };
    }
    if (j >= sweepIndex + 2) {
      const a = candles[j - 1];
      const run =
        a.closed &&
        a.close > a.open &&
        c.close > c.open &&
        a.close <= level &&
        c.close > level;
      if (run) {
        return {
          index: j,
          extreme: Math.max(a.high, c.high),
          timeMs: c.time,
          kind: 'two-candle',
        };
      }
    }
  }
  return null;
}

function findSmashShort(candles: Candle[], sweepIndex: number): SmashPoint | null {
  const sweep = candles[sweepIndex];
  const level = bodyLow(sweep);
  for (let j = sweepIndex + 1; j < candles.length; j++) {
    const c = candles[j];
    if (!c.closed) continue;
    if (c.open >= level && c.close < level && c.close < c.open) {
      return { index: j, extreme: c.low, timeMs: c.time, kind: 'single' };
    }
    if (j >= sweepIndex + 2) {
      const a = candles[j - 1];
      const run =
        a.closed &&
        a.close < a.open &&
        c.close < c.open &&
        a.close >= level &&
        c.close < level;
      if (run) {
        return {
          index: j,
          extreme: Math.min(a.low, c.low),
          timeMs: c.time,
          kind: 'two-candle',
        };
      }
    }
  }
  return null;
}

function findFvgLong(candles: Candle[], sweepIndex: number, smashIndex: number): FvgBox | null {
  for (let i = smashIndex; i >= sweepIndex + 2; i--) {
    const c0 = candles[i - 2];
    const c2 = candles[i];
    if (c2.close > c2.open && c0.high < c2.low - EPS) {
      return { lower: c0.high, upper: c2.low, kind: '3candle', index: i };
    }
  }
  for (let i = smashIndex; i >= sweepIndex + 1; i--) {
    const prev = candles[i - 1];
    const cur = candles[i];
    if (cur.close > cur.open && prev.high < cur.low - EPS) {
      return { lower: prev.high, upper: cur.low, kind: '2candle', index: i };
    }
  }
  return null;
}

function findFvgShort(candles: Candle[], sweepIndex: number, smashIndex: number): FvgBox | null {
  for (let i = smashIndex; i >= sweepIndex + 2; i--) {
    const c0 = candles[i - 2];
    const c2 = candles[i];
    if (c2.close < c2.open && c0.low > c2.high + EPS) {
      return { lower: c2.high, upper: c0.low, kind: '3candle', index: i };
    }
  }
  for (let i = smashIndex; i >= sweepIndex + 1; i--) {
    const prev = candles[i - 1];
    const cur = candles[i];
    if (cur.close < cur.open && prev.low > cur.high + EPS) {
      return { lower: cur.high, upper: prev.low, kind: '2candle', index: i };
    }
  }
  return null;
}

function neckLong(candles: Candle[], sweepIndex: number, smashIndex: number, sweepPrice: number): NeckPoint {
  let fake = false;
  for (let i = sweepIndex + 1; i < smashIndex; i++) {
    if (candles[i].low < sweepPrice - EPS) fake = true;
  }
  let line = candles[sweepIndex].high;
  for (let i = sweepIndex; i < smashIndex; i++) line = Math.max(line, candles[i].high);
  return { ok: !fake, line, height: line - sweepPrice };
}

function neckShort(candles: Candle[], sweepIndex: number, smashIndex: number, sweepPrice: number): NeckPoint {
  let fake = false;
  for (let i = sweepIndex + 1; i < smashIndex; i++) {
    if (candles[i].high > sweepPrice + EPS) fake = true;
  }
  let line = candles[sweepIndex].low;
  for (let i = sweepIndex; i < smashIndex; i++) line = Math.min(line, candles[i].low);
  return { ok: !fake, line, height: sweepPrice - line };
}

function invalidatedAfter(
  candles: Candle[],
  side: Side,
  smashIndex: number,
  sweepPrice: number,
): boolean {
  for (let i = smashIndex + 1; i < candles.length; i++) {
    if (!candles[i].closed) continue;
    if (side === 'long' && candles[i].close < sweepPrice - EPS) return true;
    if (side === 'short' && candles[i].close > sweepPrice + EPS) return true;
  }
  return false;
}

interface SidePattern {
  sweep: SweepPoint;
  smash: SmashPoint | null;
  neck: NeckPoint | null;
  fvg: FvgBox | null;
  fakeNeck: boolean;
  invalidated: boolean;
}

function patternLong(
  candles: Candle[],
  tick: number,
  sessionStartMs: number,
  skipSweepMs: ReadonlySet<number>,
): SidePattern | null {
  const profile = selectProfile();
  const swings = swingLows(candles, profile.swingLeft, profile.swingRight);
  const found: SidePattern[] = [];
  const seen = new Set<number>();
  for (const swing of swings) {
    let sweepIndex = -1;
    for (let i = swing.index + 1; i < candles.length; i++) {
      const c = candles[i];
      if (!c.closed) continue;
      if (lte(c.low, swing.price - tick)) {
        sweepIndex = i;
        break;
      }
    }
    if (sweepIndex < 0 || seen.has(sweepIndex)) continue;
    if (candles[sweepIndex].time < sessionStartMs) continue;
    if (skipSweepMs.has(candles[sweepIndex].time)) continue;
    seen.add(sweepIndex);
    found.push(finishLong(candles, sweepIndex, swing, tick));
  }
  return preferReady(candles, 'long', found);
}

function finishLong(
  candles: Candle[],
  sweepIndex: number,
  swing: SwingPoint,
  _tick: number,
): SidePattern {
  const sweepC = candles[sweepIndex];
  const sweep: SweepPoint = {
    index: sweepIndex,
    price: sweepC.low,
    timeMs: sweepC.time,
    priorSwingPrice: swing.price,
    priorSwingIndex: swing.index,
  };
  const smash = findSmashLong(candles, sweepIndex);
  if (!smash) {
    return { sweep, smash: null, neck: null, fvg: null, fakeNeck: false, invalidated: false };
  }
  const neck = neckLong(candles, sweepIndex, smash.index, sweep.price);
  if (!neck.ok) {
    return { sweep, smash, neck, fvg: null, fakeNeck: true, invalidated: false };
  }
  const fvg = findFvgLong(candles, sweepIndex, smash.index);
  const invalidated = fvg ? invalidatedAfter(candles, 'long', smash.index, sweep.price) : false;
  return { sweep, smash, neck, fvg, fakeNeck: false, invalidated };
}

function patternShort(
  candles: Candle[],
  tick: number,
  sessionStartMs: number,
  skipSweepMs: ReadonlySet<number>,
): SidePattern | null {
  const profile = selectProfile();
  const swings = swingHighs(candles, profile.swingLeft, profile.swingRight);
  const found: SidePattern[] = [];
  const seen = new Set<number>();
  for (const swing of swings) {
    let sweepIndex = -1;
    for (let i = swing.index + 1; i < candles.length; i++) {
      const c = candles[i];
      if (!c.closed) continue;
      if (gte(c.high, swing.price + tick)) {
        sweepIndex = i;
        break;
      }
    }
    if (sweepIndex < 0 || seen.has(sweepIndex)) continue;
    if (candles[sweepIndex].time < sessionStartMs) continue;
    if (skipSweepMs.has(candles[sweepIndex].time)) continue;
    seen.add(sweepIndex);
    const sweepC = candles[sweepIndex];
    const sweep: SweepPoint = {
      index: sweepIndex,
      price: sweepC.high,
      timeMs: sweepC.time,
      priorSwingPrice: swing.price,
      priorSwingIndex: swing.index,
    };
    const smash = findSmashShort(candles, sweepIndex);
    if (!smash) {
      found.push({ sweep, smash: null, neck: null, fvg: null, fakeNeck: false, invalidated: false });
      continue;
    }
    const neck = neckShort(candles, sweepIndex, smash.index, sweep.price);
    if (!neck.ok) {
      found.push({ sweep, smash, neck, fvg: null, fakeNeck: true, invalidated: false });
      continue;
    }
    const fvg = findFvgShort(candles, sweepIndex, smash.index);
    const invalidated = fvg ? invalidatedAfter(candles, 'short', smash.index, sweep.price) : false;
    found.push({ sweep, smash, neck, fvg, fakeNeck: false, invalidated });
  }
  return preferReady(candles, 'short', found);
}

/**
 * Keep the latest choke that clears the size floors.
 * A later 1-tick sweep no longer hides that choke. If none clear, the latest sweep still paints.
 */
function preferReady(candles: Candle[], side: Side, found: SidePattern[]): SidePattern | null {
  if (!found.length) return null;
  const ready = found.filter((pattern) => !pattern.invalidated && patternClears(candles, side, pattern));
  const pool = ready.length ? ready : found;
  let best = pool[0];
  for (const pattern of pool) {
    if (pattern.sweep.index >= best.sweep.index) best = pattern;
  }
  return best;
}

/**
 * Deterministic sweep / smash / FVG / neck. No model calls.
 * Session start is the UK day boundary so setups are eligible 24h.
 * The old 13:30 fire window is not applied.
 */
export function detectStructure(
  candles: Candle[],
  tick: number,
  sessionStartMs: number,
  timeframe: '5m' | '3m' = '5m',
  skipSweepMs: ReadonlySet<number> = new Set(),
): Structure {
  const longP = patternLong(candles, tick, sessionStartMs, skipSweepMs);
  const shortP = patternShort(candles, tick, sessionStartMs, skipSweepMs);
  const chosen = chooseSide(longP, shortP);
  if (!chosen) {
    return {
      side: null,
      sweep: null,
      smash: null,
      neck: null,
      fvg: null,
      fakeNeck: false,
      invalidated: false,
      displacementWithoutSweep: false,
      timeframe,
    };
  }
  return {
    side: chosen.side,
    sweep: chosen.pattern.sweep,
    smash: chosen.pattern.smash,
    neck: chosen.pattern.neck,
    fvg: chosen.pattern.fvg,
    fakeNeck: chosen.pattern.fakeNeck,
    invalidated: chosen.pattern.invalidated,
    displacementWithoutSweep: false,
    timeframe,
  };
}

function patternRank(pattern: SidePattern): number {
  if (pattern.fvg && pattern.neck?.ok) return 3;
  if (pattern.smash && pattern.neck?.ok) return 2;
  if (pattern.fakeNeck) return 1;
  return 0;
}

function chooseSide(
  longP: SidePattern | null,
  shortP: SidePattern | null,
): { side: Side; pattern: SidePattern } | null {
  if (longP && shortP) {
    const rankGap = patternRank(longP) - patternRank(shortP);
    if (rankGap !== 0) return rankGap > 0 ? { side: 'long', pattern: longP } : { side: 'short', pattern: shortP };
    return longP.sweep.index >= shortP.sweep.index
      ? { side: 'long', pattern: longP }
      : { side: 'short', pattern: shortP };
  }
  if (longP) return { side: 'long', pattern: longP };
  if (shortP) return { side: 'short', pattern: shortP };
  return null;
}

export function entryCapLong(
  h1Ma5: number | null,
  sweepPrice: number,
  smashExtreme: number,
  fvgLower: number,
): number {
  const mid = (sweepPrice + smashExtreme) / 2;
  const parts = [mid, fvgLower];
  if (h1Ma5 != null && Number.isFinite(h1Ma5)) parts.push(h1Ma5);
  return Math.min(...parts);
}

export function entryCapShort(
  h1Ma5: number | null,
  sweepPrice: number,
  smashExtreme: number,
  fvgUpper: number,
): number {
  const mid = (sweepPrice + smashExtreme) / 2;
  const parts = [mid, fvgUpper];
  if (h1Ma5 != null && Number.isFinite(h1Ma5)) parts.push(h1Ma5);
  return Math.max(...parts);
}

export function zoneFromEdges(edge: number, entryCap: number): Zone {
  return { low: Math.min(edge, entryCap), high: Math.max(edge, entryCap) };
}

/** Keep a long zone from quoting above the live price while price is inside it. */
export function clipZone(side: Side, zone: Zone, lastPrice: number): Zone {
  if (side === 'long' && lastPrice < zone.high && lastPrice >= zone.low) {
    return { low: zone.low, high: lastPrice };
  }
  if (side === 'short' && lastPrice > zone.low && lastPrice <= zone.high) {
    return { low: lastPrice, high: zone.high };
  }
  return zone;
}

export function laterExtremeWick(side: Side, candles: Candle[], sweepIndex: number): number | null {
  let extreme: number | null = null;
  for (let i = sweepIndex + 1; i < candles.length; i++) {
    const v = side === 'long' ? candles[i].low : candles[i].high;
    if (extreme == null) extreme = v;
    else extreme = side === 'long' ? Math.min(extreme, v) : Math.max(extreme, v);
  }
  return extreme;
}

export function priceTaggedZone(side: Side, candles: Candle[], fromIndex: number, zone: Zone, lastPrice: number): boolean {
  for (let i = fromIndex; i < candles.length; i++) {
    const c = candles[i];
    if (c.low <= zone.high + EPS && c.high >= zone.low - EPS) return true;
    if (side === 'short' && c.high >= zone.low - EPS && c.low <= zone.high + EPS) return true;
  }
  return lastPrice <= zone.high + EPS && lastPrice >= zone.low - EPS;
}

export function isChase(side: Side, lastPrice: number, zone: Zone, neckHeight: number, frac: number): boolean {
  if (!(neckHeight > 0)) return false;
  const room = frac * neckHeight;
  if (side === 'long') return lastPrice > zone.high + room;
  return lastPrice < zone.low - room;
}

export function tfMs(timeframe: '5m' | '3m'): number {
  return timeframe === '3m' ? 180_000 : 300_000;
}
