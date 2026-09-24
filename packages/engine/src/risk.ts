import { roundQtyDown, roundToTick } from './math.ts';
import type { Side } from './types.ts';

/** 1 tick beyond the tighter of the sweep wick and a later session wick. */
export function stopLoss(
  side: Side,
  sweepWick: number,
  laterWick: number | null,
  tick: number,
): number {
  let wick = sweepWick;
  if (laterWick != null) {
    if (side === 'long' && laterWick > sweepWick) wick = laterWick;
    if (side === 'short' && laterWick < sweepWick) wick = laterWick;
  }
  if (side === 'long') return roundToTick(wick - tick, tick, 'floor');
  return roundToTick(wick + tick, tick, 'ceil');
}

/** Frozen percent of entry. Long up, short down. Not an R-multiple and not an 18% target. */
export function takeProfit(side: Side, entry: number, tpPricePct: number, tick: number): number {
  const raw = side === 'long' ? entry * (1 + tpPricePct) : entry * (1 - tpPricePct);
  return roundToTick(raw, tick, 'nearest');
}

export function marginRiskPct(entry: number, sl: number, leverage: number): number {
  if (entry === 0) return Number.POSITIVE_INFINITY;
  return (leverage * Math.abs(entry - sl)) / entry;
}

/**
 * Deepest long entry (highest short entry) whose margin risk is still within the cap.
 * Long: entry <= sl / (1 - max/lev). Short: entry >= sl / (1 + max/lev).
 */
export function acceptableEntry(side: Side, sl: number, leverage: number, maxMarginRisk: number): number {
  if (side === 'long') {
    const denom = 1 - maxMarginRisk / leverage;
    if (denom <= 0) return Number.POSITIVE_INFINITY;
    return sl / denom;
  }
  const denom = 1 + maxMarginRisk / leverage;
  return sl / denom;
}

export function isFatStop(side: Side, entry: number, sl: number, leverage: number, maxMarginRisk: number): boolean {
  return marginRiskPct(entry, sl, leverage) > maxMarginRisk + 1e-12;
}

/**
 * notional = stake * leverage, then cut qty so a stop hit is about stake * max_margin_risk.
 * Neither cap is exceeded.
 */
export function positionQty(
  stakeGbp: number,
  leverage: number,
  entry: number,
  sl: number,
  maxMarginRisk: number,
): number {
  if (!(entry > 0)) return 0;
  const qtyNotional = (stakeGbp * leverage) / entry;
  const dist = Math.abs(entry - sl);
  if (!(dist > 0)) return 0;
  const qtyRisk = (stakeGbp * maxMarginRisk) / dist;
  return roundQtyDown(Math.min(qtyNotional, qtyRisk));
}
