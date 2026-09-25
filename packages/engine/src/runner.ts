import type { Side } from './types.ts';

/** Extra target beyond the 1.33% lock. The stop moves to the lock; this is the resting take-profit. */
export const RUNNER_EXTRA_PCT = 0.005;

export interface ProtectTrade {
  side: Side;
  entry: number;
  sl: number;
  lock: number;
  tp: number;
  filled: boolean;
  locked: boolean;
}

export interface ProtectStep {
  filled: boolean;
  locked: boolean;
  outcome: 'WIN' | 'LOSS' | null;
  exit: number | null;
}

/**
 * The structure stop is checked before the lock. The bar that first trades the
 * lock does not also take the runner target. After the lock, a touch of the
 * lock price exits there, before the runner target on that same bar.
 */
export function stepProtect(trade: ProtectTrade, bar: { high: number; low: number }): ProtectStep {
  const long = trade.side === 'long';
  const through = (price: number, favor: boolean) =>
    long ? (favor ? bar.high >= price : bar.low <= price) : favor ? bar.low <= price : bar.high >= price;

  let filled = trade.filled;
  let locked = trade.locked;
  if (!filled) {
    if (!through(trade.entry, false)) return { filled, locked, outcome: null, exit: null };
    filled = true;
  }
  if (!locked) {
    if (through(trade.sl, false)) return { filled, locked, outcome: 'LOSS', exit: trade.sl };
    if (through(trade.lock, true)) locked = true;
    return { filled, locked, outcome: null, exit: null };
  }
  if (through(trade.lock, false)) return { filled, locked: true, outcome: 'WIN', exit: trade.lock };
  if (through(trade.tp, true)) return { filled, locked: true, outcome: 'WIN', exit: trade.tp };
  return { filled, locked: true, outcome: null, exit: null };
}

/** `favor` is the profitable side of `level` (up for a long, down for a short). */
export function priceReached(side: Side, price: number, level: number, favor: boolean): boolean {
  if (side === 'long') return favor ? price >= level : price <= level;
  return favor ? price <= level : price >= level;
}
