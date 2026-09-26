export const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const;
export type PairId = (typeof PAIRS)[number];

export type Side = 'long' | 'short';
export type VenueId = 'mexc' | 'kucoin';

export type State =
  | 'FLAT'
  | 'FORMING'
  | 'WAIT_RETRACE'
  | 'ARM'
  | 'WORKING'
  | 'DONE'
  | 'SPIT'
  | 'NEED_DEEPER'
  | 'EXPIRED'
  | 'BLOCKED';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  closed: boolean;
}

export interface AppConfig {
  live_armed: boolean;
  active_venue: VenueId;
  pairs: PairId[];
  stake_gbp: number;
  /** Desk only. How many trades may be open at once. The published book ignores this. */
  balance_slots: number;
  /** Desk paper balance in USDT until MEXC reports equity. */
  balance_start_usdt: number;
  /** Fraction of a slot left unused so the fee does not reject the order. */
  balance_reserve_frac: number;
  leverage: number;
  max_margin_risk: number;
  tp_price_pct: number;
  /** Added to tp_price_pct for the resting target. The stop moves to tp_price_pct when that price trades. */
  runner_extra_pct: number;
  window_start: number | null;
  window_end: number | null;
  timezone: 'Europe/London';
  first_tag: boolean;
  btc_align_required: false;
  max_arms_per_pair_per_day: number;
  max_fills_across_book: number;
  dry_run_log: string;
  notify_log: string;
  notify_debounce_ms: number;
  stale_close_ms: number;
  chase_neck_frac: number;
  swing_left: number;
  swing_right: number;
  ticks: Record<PairId, number>;
}

export interface OrderDraft {
  clientOrderId: string;
  pair: PairId;
  side: 'buy' | 'sell';
  type: 'LIMIT';
  price: number;
  qty: number;
  sl: number;
  /** Price where the stop moves once the trade has traded this far. The 1.33% lock. */
  lockPrice: number;
  /** Resting target beyond the lock. A return to lockPrice closes at the lock. */
  tp: number;
  reduceOnlySlTp: true;
  liveArmed: boolean;
  reason: 'LIVE_OFF' | 'LIVE';
  mode: 'dry-run' | 'live';
  venue: VenueId;
  tsUk: string;
  tsMs: number;
  btcAligned: boolean;
  marginRiskPct: number;
  leverage: number;
  tpPricePct: number;
  /** Margin used for this order, in USDT. The published book stake when balance scaling is off. */
  stakeUsdt: number;
}

export interface CancelRecord {
  action: 'cancel' | 'flatten-intent';
  clientOrderId: string;
  pair: PairId;
  type: 'LIMIT';
  price?: number;
  reason: string;
  mode: 'dry-run' | 'live';
  venue: VenueId;
  tsUk: string;
  tsMs: number;
}

export type OrderLogEntry = OrderDraft | CancelRecord;

export interface TransitionLog {
  pair: PairId;
  from: State;
  to: State;
  tsUk: string;
  tsMs: number;
  price: number;
  reason: string | null;
}

export interface SwingPoint {
  index: number;
  price: number;
  time: number;
}

export interface SweepPoint {
  index: number;
  price: number;
  timeMs: number;
  priorSwingPrice: number;
  priorSwingIndex: number;
}

export interface SmashPoint {
  index: number;
  extreme: number;
  timeMs: number;
  kind: 'single' | 'two-candle';
}

export interface NeckPoint {
  ok: boolean;
  line: number;
  height: number;
}

export interface FvgBox {
  lower: number;
  upper: number;
  kind: '3candle' | '2candle';
  index: number;
}

export interface Structure {
  side: Side | null;
  sweep: SweepPoint | null;
  smash: SmashPoint | null;
  neck: NeckPoint | null;
  fvg: FvgBox | null;
  fakeNeck: boolean;
  invalidated: boolean;
  displacementWithoutSweep: boolean;
  timeframe: '5m' | '3m';
}

export interface Zone {
  low: number;
  high: number;
}

export interface MarketUpdate {
  pair: PairId;
  candles5m: Candle[];
  candles3m?: Candle[];
  candles1h?: Candle[];
  candles30m?: Candle[];
  lastPrice: number;
  nowMs: number;
  /** Chart refresh between 5m closes. Structure can paint; the close is not a fresh fire. */
  forceStale?: boolean;
}
