import { readFileSync } from 'node:fs';
import { PAIRS, type AppConfig, type PairId, type VenueId } from './types.ts';

export function loadConfig(path: string): AppConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AppConfig>;
  const venue = raw.active_venue;
  if (venue !== 'mexc' && venue !== 'kucoin') {
    throw new Error(`active_venue must be mexc or kucoin, got ${String(venue)}`);
  }
  if (typeof raw.live_armed !== 'boolean') throw new Error('live_armed must be a boolean');
  if (raw.timezone !== 'Europe/London') throw new Error('timezone must be Europe/London');
  if (raw.btc_align_required !== false) throw new Error('btc_align_required is locked false');
  const pairs = raw.pairs ?? [];
  if (pairs.length !== PAIRS.length || PAIRS.some((p, i) => pairs[i] !== p)) {
    throw new Error('pairs must be BTCUSDT, ETHUSDT, SOLUSDT');
  }
  const ticks = raw.ticks;
  if (!ticks) throw new Error('ticks required');
  for (const p of PAIRS) {
    if (!(ticks[p] > 0)) throw new Error(`tick missing for ${p}`);
  }
  return {
    live_armed: raw.live_armed,
    active_venue: venue,
    pairs: pairs as PairId[],
    stake_gbp: num(raw.stake_gbp, 'stake_gbp'),
    balance_slots: raw.balance_slots == null ? 2 : num(raw.balance_slots, 'balance_slots'),
    balance_start_usdt: raw.balance_start_usdt == null ? 100 : num(raw.balance_start_usdt, 'balance_start_usdt'),
    balance_reserve_frac: raw.balance_reserve_frac == null ? 0.02 : num(raw.balance_reserve_frac, 'balance_reserve_frac'),
    leverage: num(raw.leverage, 'leverage'),
    max_margin_risk: num(raw.max_margin_risk, 'max_margin_risk'),
    tp_price_pct: num(raw.tp_price_pct, 'tp_price_pct'),
    runner_extra_pct: raw.runner_extra_pct == null ? 0.005 : num(raw.runner_extra_pct, 'runner_extra_pct'),
    window_start: raw.window_start ?? null,
    window_end: raw.window_end ?? null,
    timezone: 'Europe/London',
    first_tag: raw.first_tag !== false,
    btc_align_required: false,
    max_arms_per_pair_per_day: raw.max_arms_per_pair_per_day ?? 1,
    max_fills_across_book: raw.max_fills_across_book ?? 3,
    dry_run_log: raw.dry_run_log ?? './logs/orders.json',
    notify_log: raw.notify_log ?? './logs/notify.log',
    notify_debounce_ms: raw.notify_debounce_ms ?? 300_000,
    stale_close_ms: raw.stale_close_ms ?? 2000,
    chase_neck_frac: raw.chase_neck_frac ?? 0.4,
    swing_left: raw.swing_left ?? 2,
    swing_right: raw.swing_right ?? 2,
    ticks,
  };
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return v;
}

export function assertWindowDisabled(config: AppConfig): void {
  if (config.window_start !== null || config.window_end !== null) {
    throw new Error('window_start and window_end must be null — track all trades');
  }
}

export type { VenueId };
