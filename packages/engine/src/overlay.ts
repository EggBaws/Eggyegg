import { formatPrice } from './math.ts';
import { ukClock } from './time.ts';
import type { Candle, PairId, Side, State, Zone } from './types.ts';

export interface OverlayLevel {
  price?: number;
  low?: number;
  high?: number;
  color: string;
  label: string;
  dashed?: boolean;
}

export interface PairOverlay {
  pair: PairId;
  state: State;
  reason: string | null;
  side: Side | null;
  btcAligned: boolean;
  liveArmed: boolean;
  zone: Zone | null;
  sl: number | null;
  tp: number | null;
  entry: number | null;
  marginRiskPct: number | null;
  lastPing: string | null;
  sweep: number | null;
  neck: number | null;
  fvg: { low: number; high: number } | null;
  lastPrice: number;
  inZone: boolean;
  clockUk: string;
  stamp: string;
  review: 'TAKE' | 'SPIT' | 'MISS' | 'PENDING';
  warnings: string[];
  timeframe: '5m' | '3m';
  candles: Candle[];
  context30m: 'display-only';
  h1Ma5: number | null;
  levels: OverlayLevel[];
}

export function reviewOf(state: State): PairOverlay['review'] {
  if (state === 'ARM' || state === 'WORKING' || state === 'DONE') return 'TAKE';
  if (state === 'SPIT') return 'SPIT';
  if (state === 'EXPIRED') return 'MISS';
  return 'PENDING';
}

export function buildLevels(input: {
  sweep: number | null;
  neck: number | null;
  fvg: { low: number; high: number } | null;
  zone: Zone | null;
  sl: number | null;
  tp: number | null;
  lastPrice: number;
  inZone: boolean;
}): OverlayLevel[] {
  const levels: OverlayLevel[] = [];
  if (input.sweep != null) levels.push({ price: input.sweep, color: 'orange', label: 'sweep' });
  if (input.neck != null) levels.push({ price: input.neck, color: 'white', label: 'neck' });
  if (input.fvg) levels.push({ low: input.fvg.low, high: input.fvg.high, color: 'purple', label: 'FVG' });
  if (input.zone) levels.push({ low: input.zone.low, high: input.zone.high, color: 'green', label: 'zone' });
  if (input.sl != null) levels.push({ price: input.sl, color: 'red', label: 'SL' });
  if (input.tp != null) levels.push({ price: input.tp, color: 'blue', label: 'TP' });
  if (!input.inZone) {
    levels.push({ price: input.lastPrice, color: 'grey', label: 'NOW', dashed: true });
  }
  return levels;
}

export function inZone(price: number, zone: Zone | null): boolean {
  if (!zone) return false;
  return price >= zone.low && price <= zone.high;
}

export function stampLine(input: {
  pair: PairId;
  state: State;
  sweep: number | null;
  zone: Zone | null;
  sl: number | null;
  marginRiskPct: number | null;
  leverage: number;
  tp: number | null;
  tpPricePct: number;
  btcAligned: boolean;
  nowMs: number;
  tick: number;
}): string {
  const px = (n: number | null) => (n == null ? '—' : formatPrice(n, input.tick));
  const zone =
    input.zone == null ? '—' : `${formatPrice(input.zone.low, input.tick)}–${formatPrice(input.zone.high, input.tick)}`;
  const risk =
    input.marginRiskPct == null ? '—' : `${(input.marginRiskPct * 100).toFixed(1)}% margin @${input.leverage}x`;
  const tpPct = `${(input.tpPricePct * 100).toFixed(2)}%`;
  return [
    `${input.pair} ${input.state}`,
    `sweep ${px(input.sweep)}`,
    `zone ${zone}`,
    `sl ${px(input.sl)} (${risk})`,
    `tp ${px(input.tp)} (${tpPct})`,
    `btc_aligned ${input.btcAligned ? 'yes' : 'no'}`,
    `clock ${ukClock(input.nowMs)}`,
  ].join(' | ');
}
