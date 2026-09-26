import {
  clipZone,
  detectStructure,
  entryCapLong,
  entryCapShort,
  isChase,
  laterExtremeWick,
  priceTaggedZone,
  selectStructureCandles,
  smaClose,
  tfMs,
  zoneFromEdges,
} from './candles.ts';
import { appendOrderLog } from './dryRun.ts';
import { holidayAt } from './holidays.ts';
import { formatPrice, roundToTick } from './math.ts';
import { acceptableEntry, isFatStop, marginRiskPct, positionQty, slotStake, stopLoss, takeProfit } from './risk.ts';
import { priceReached } from './runner.ts';
import { selectProfile, selectiveFacts, stopIsWideEnough, stopIsWithinCap, stopProtects } from './select.ts';
import { initialRuntime, muteRuntime, stepPair, type PairRuntime, type SetupFacts } from './stateMachine.ts';
import { buildChartMarks } from './marks.ts';
import { ukClock, ukDateIso, ukDateKey, ukMidnightMs, ukStamp } from './time.ts';
import type { AppConfig, Candle, MarketUpdate, OrderDraft, OrderLogEntry, PairId, Side, VenueId, Zone } from './types.ts';
import { buildLevels, inZone, reviewOf, stampLine, type PairOverlay } from './overlay.ts';

export interface LimitRequest {
  clientOrderId: string;
  pair: string;
  side: 'buy' | 'sell';
  type: 'LIMIT';
  price: number;
  qty: number;
  sl: number;
  tp: number;
  reduceOnlySlTp: true;
}

export interface VenuePort {
  readonly id: VenueId;
  health(): { ok: boolean; reason?: string };
  placeLimitWithProtection(req: LimitRequest):
    | {
        ok: boolean;
        orderId?: string;
        cancelledBecauseSlFailed?: boolean;
        error?: string;
      }
    | Promise<{
        ok: boolean;
        orderId?: string;
        cancelledBecauseSlFailed?: boolean;
        error?: string;
      }>;
  orderFilled?(orderId: string): boolean | Promise<boolean>;
  moveProtection?(req: { pair: string; orderId: string; sl: number; tp: number }):
    | { ok: boolean; error?: string }
    | Promise<{ ok: boolean; error?: string }>;
  /** Live USDT equity. Absent on the paper venue and on the published-book engine. */
  accountEquity?(): Promise<{ equity: number; available: number } | null>;
}

interface RunnerTrack {
  orderId: string | null;
  clientOrderId: string;
  side: Side;
  entry: number;
  sl: number;
  lock: number;
  tp: number;
  filled: boolean;
  locked: boolean;
  armedMs: number;
  armCandleTime: number;
}

export interface NotifyEvent {
  pair: string;
  state: string;
  level: 'info' | 'warn';
  body: string;
  tsMs: number;
  tsUk: string;
}

export interface NotifierPort {
  ping(event: NotifyEvent): void;
}

export interface EngineOptions {
  config: AppConfig;
  venue: VenuePort;
  notifier: NotifierPort;
  dryRunPath: string;
  fillsToday?: number;
  dailyPnlGbp?: number;
  /** Backtest and tests that must not touch logs/orders.json. */
  skipOrderLog?: boolean;
  /**
   * Desk sizing. Each new order uses one slot of the USDT balance.
   * Omit this for the published book, which keeps stake_gbp.
   */
  balanceScale?: { slots: number; reserveFrac: number; startUsdt: number };
}

interface BtcMemo {
  side: Side;
  sessionDate: string;
}

interface PairRecord {
  runtime: PairRuntime;
  view: PairOverlay;
  lastSetup: SetupFacts | null;
  lastPrice: number;
  nowMs: number;
  runner: RunnerTrack | null;
}

export interface BookSnapshot {
  liveArmed: boolean;
  activeVenue: VenueId;
  timezone: 'Europe/London';
  window: 'disabled';
  clockUk: string;
  holiday: { active: boolean; name: string | null; date: string };
  dailyPnlGbp: number;
  fillsToday: number;
  pairs: PairOverlay[];
  /** USDT equity the next order is sized from. Null on the published-book engine. */
  balanceUsdt: number | null;
  /** Margin of the next order. Null on the published-book engine. */
  tradeStakeUsdt: number | null;
  openTrades: number;
  balanceSlots: number | null;
}

const PING_STATES = new Set(['FORMING', 'ARM', 'NEED_DEEPER', 'DONE', 'EXPIRED', 'SPIT']);

export class ChokeEngine {
  private readonly config: AppConfig;
  private venue: VenuePort;
  private readonly notifier: NotifierPort;
  private readonly dryRunPath: string;
  private readonly skipOrderLog: boolean;
  private records = new Map<PairId, PairRecord>();
  private btc: BtcMemo | null = null;
  private fillsToday: number;
  private dailyPnlGbp: number;
  private bookDay: string | null = null;
  private liveArmed: boolean;
  private venueCalls = 0;
  private readonly balanceScale: { slots: number; reserveFrac: number; startUsdt: number } | null;
  private paperEquity: number;
  private equityCache: { at: number; equity: number; available: number } | null = null;

  constructor(opts: EngineOptions) {
    this.config = opts.config;
    this.venue = opts.venue;
    this.notifier = opts.notifier;
    this.dryRunPath = opts.dryRunPath;
    this.skipOrderLog = opts.skipOrderLog === true;
    this.liveArmed = opts.config.live_armed;
    this.fillsToday = opts.fillsToday ?? 0;
    this.dailyPnlGbp = opts.dailyPnlGbp ?? 0;
    const scale = opts.balanceScale;
    this.balanceScale =
      scale && scale.slots >= 1 && scale.startUsdt > 0
        ? { slots: scale.slots, reserveFrac: scale.reserveFrac, startUsdt: scale.startUsdt }
        : null;
    this.paperEquity = this.balanceScale?.startUsdt ?? opts.config.stake_gbp;
    for (const pair of opts.config.pairs) {
      const rt = initialRuntime(pair);
      this.records.set(pair, {
        runtime: rt,
        view: emptyView(pair, opts.config),
        lastSetup: null,
        lastPrice: 0,
        nowMs: 0,
        runner: null,
      });
    }
  }

  get venuePlaceCalls(): number {
    return this.venueCalls;
  }

  isLiveArmed(): boolean {
    return this.liveArmed;
  }

  setLiveArmed(on: boolean): void {
    this.liveArmed = on;
    for (const [pair, rec] of this.records) {
      this.records.set(pair, { ...rec, view: { ...rec.view, liveArmed: on } });
    }
  }

  /** Read USDT equity as soon as live fires turn on, so the desk shows the account before the next candle. */
  async pullEquity(nowMs: number): Promise<boolean> {
    if (!this.balanceScale) return false;
    this.equityCache = null;
    const row = await this.readEquity(nowMs, this.workingBook().locked);
    return row != null && row.equity > 0;
  }

  setVenue(venue: VenuePort): void {
    this.venue = venue;
  }

  workingOrders(): { pair: PairId; clientOrderId: string }[] {
    const out: { pair: PairId; clientOrderId: string }[] = [];
    for (const rec of this.records.values()) {
      if (rec.runtime.state === 'WORKING' && rec.runtime.order) {
        out.push({ pair: rec.runtime.pair, clientOrderId: rec.runtime.order.clientOrderId });
      }
    }
    return out;
  }

  /** Paper pnl for the UK day of `nowMs`. A new day clears the book kill counters. */
  realizePnl(pnl: number, nowMs: number): void {
    this.rollBook(nowMs);
    this.dailyPnlGbp += pnl;
  }

  /**
   * Drop a resting limit that never filled. The arm still counts for the day.
   * Used when a backtest session ends, and when live fires are stopped.
   */
  releaseUnfilled(pair: PairId, nowMs: number, reason: string): void {
    const rec = this.must(pair);
    if (rec.runtime.state !== 'WORKING') return;
    const runtime = { ...rec.runtime, state: 'FLAT' as const, reason, order: null };
    this.records.set(pair, {
      ...rec,
      runtime,
      runner: null,
      view: { ...rec.view, state: 'FLAT', reason, review: reviewOf('FLAT') },
      nowMs,
    });
  }

  runtime(pair: PairId): PairRuntime {
    return this.must(pair).runtime;
  }

  snapshot(nowMs?: number): BookSnapshot {
    const now = nowMs ?? this.latestNow();
    const holiday = holidayAt(now);
    return {
      liveArmed: this.liveArmed,
      activeVenue: this.config.active_venue,
      timezone: 'Europe/London',
      window: 'disabled',
      clockUk: ukClock(now),
      holiday,
      dailyPnlGbp: this.dailyPnlGbp,
      fillsToday: this.fillsToday,
      pairs: this.config.pairs.map((p) => this.must(p).view),
      balanceUsdt: this.balanceScale ? this.shownEquity() : null,
      tradeStakeUsdt: this.balanceScale ? this.shownStake() : null,
      openTrades: this.workingBook().count,
      balanceSlots: this.balanceScale ? this.balanceScale.slots : null,
    };
  }

  async runBook(updates: MarketUpdate[]): Promise<BookSnapshot> {
    const ordered = [...updates].sort((a, b) => (a.pair === 'BTCUSDT' ? -1 : b.pair === 'BTCUSDT' ? 1 : 0));
    let now = 0;
    for (const u of ordered) {
      await this.ingest(u);
      now = u.nowMs;
    }
    return this.snapshot(now);
  }

  async ingest(update: MarketUpdate): Promise<PairOverlay> {
    const tick = this.config.ticks[update.pair];
    const selected = selectStructureCandles(update.candles5m, update.candles3m);
    const sessionStart = ukMidnightMs(update.nowMs);
    const prior = this.must(update.pair).runtime;
    const skipSweepMs = new Set(prior.usedSweepMs);
    if (prior.state === 'WORKING' && prior.boxId) {
      const working = Number(prior.boxId.slice(prior.boxId.indexOf(':') + 1));
      if (Number.isFinite(working)) skipSweepMs.delete(working);
    }
    const structure = detectStructure(selected.candles, tick, sessionStart, selected.timeframe, skipSweepMs);
    if (update.pair === 'BTCUSDT' && structure.sweep && structure.side) {
      this.btc = { side: structure.side, sessionDate: ukDateIso(structure.sweep.timeMs) };
    }

    const h1Ma5 = smaClose(update.candles1h, 5);
    const side = structure.side;
    const btcAligned = this.align(update.pair, side, update.nowMs);
    const holiday = holidayAt(update.nowMs);
    const health = this.venue.health();
    const dailyKill = this.dailyPnlGbp <= -this.config.stake_gbp * this.config.max_margin_risk;
    this.rollBook(update.nowMs);
    const lastClosed = [...selected.candles].reverse().find((c) => c.closed);
    const stale =
      update.forceStale === true ||
      (lastClosed
        ? update.nowMs - (lastClosed.time + tfMs(selected.timeframe)) > this.config.stale_close_ms
        : true);

    const sized = await this.sizeFor(update.nowMs);
    const priced = priceSetup({
      candles: selected.candles,
      structure,
      h1Ma5,
      lastPrice: update.lastPrice,
      tick,
      config: this.config,
    });

    const selective = selectiveFacts(selected.candles, structure);
    const setup: SetupFacts = {
      hasSweep: structure.sweep != null,
      hasSmash: selective.hasSmash,
      hasFvg: selective.hasFvg,
      neckEvaluated: selective.neckEvaluated,
      neckOk: selective.neckOk,
      invalidated: structure.invalidated,
      tagged: priced.tagged,
      chase: priced.chase,
      fatStop: priced.fatStop,
      deeperReached: priced.deeperReached,
      displacementWithoutSweep: structure.displacementWithoutSweep,
      venueHealthy: health.ok,
      liveArmed: this.liveArmed,
      dailyKill,
      stale,
      holiday: holiday.active,
      btcAligned,
      fillsAtCap: this.fillsToday >= this.config.max_fills_across_book,
      slotsFull: sized.slotsFull,
      noSize: sized.noSize,
      boxId: structure.sweep && side ? `${side}:${structure.sweep.timeMs}` : null,
      side,
    };

    const draft = priced.entry != null && priced.sl != null && priced.lock != null && priced.tp != null && side
      ? this.draftOrder(update, side, priced.entry, priced.sl, priced.lock, priced.tp, btcAligned, sized.stake)
      : null;

    const rec = this.must(update.pair);
    const stepped = stepPair(rec.runtime, {
      nowMs: update.nowMs,
      lastPrice: update.lastPrice,
      maxArmsPerPairPerDay: this.config.max_arms_per_pair_per_day,
      holidayName: holiday.active ? holiday.name : null,
      setup,
      draft,
      positionClosed: false,
      armPingBody: draft ? formatArmPing(draft, tick) : null,
    });

    let runtime = stepped.runtime;
    let runner = rec.runner;
    if (stepped.order && !this.liveArmed) {
      this.logOrder(stepped.order);
      runner = trackFrom(stepped.order, null, update);
    } else if (stepped.order && this.liveArmed) {
      this.venueCalls += 1;
      let placed: { ok: boolean; orderId?: string; cancelledBecauseSlFailed?: boolean; error?: string };
      try {
        placed = await Promise.resolve(this.venue.placeLimitWithProtection(stepped.order));
      } catch {
        placed = { ok: false, error: 'VENUE_UNHEALTHY' };
      }
      if (!placed.ok) {
        runtime = {
          ...runtime,
          state: 'BLOCKED',
          reason: placed.cancelledBecauseSlFailed ? 'SL_ATTACH_FAILED' : 'VENUE_UNHEALTHY',
          transitions: [
            ...runtime.transitions,
            {
              pair: update.pair,
              from: 'WORKING',
              to: 'BLOCKED',
              tsUk: ukStamp(update.nowMs),
              tsMs: update.nowMs,
              price: update.lastPrice,
              reason: placed.cancelledBecauseSlFailed ? 'SL_ATTACH_FAILED' : 'VENUE_UNHEALTHY',
            },
          ],
        };
        this.logOrder({
          action: 'cancel',
          clientOrderId: stepped.order.clientOrderId,
          pair: update.pair,
          type: 'LIMIT',
          reason: runtime.reason ?? 'BLOCKED',
          mode: 'live',
          venue: this.config.active_venue,
          tsUk: ukStamp(update.nowMs),
          tsMs: update.nowMs,
        });
      } else {
        this.logOrder({ ...stepped.order, mode: 'live', reason: 'LIVE', liveArmed: true });
        runner = trackFrom(stepped.order, placed.orderId ?? null, update);
      }
    }
    if (stepped.cancel && rec.runtime.order) {
      this.logOrder({
        action: 'cancel',
        clientOrderId: rec.runtime.order.clientOrderId,
        pair: update.pair,
        type: 'LIMIT',
        reason: 'INVALIDATED',
        mode: this.liveArmed ? 'live' : 'dry-run',
        venue: this.config.active_venue,
        tsUk: ukStamp(update.nowMs),
        tsMs: update.nowMs,
      });
      runner = null;
    }
    if (runtime.state === 'WORKING' && runtime.order && runner && runner.clientOrderId === runtime.order.clientOrderId) {
      runner = await this.advanceRunner(update.pair, runner, update);
    } else if (runtime.state !== 'WORKING') {
      runner = null;
    }

    this.emitPings(update.pair, update.nowMs, stepped.entered, runtime.lastPing, stepped.holidayPing);
    const shown = this.shownPrices(priced, runtime, runner);
    const view = this.makeView(update, selected.candles, selected.timeframe, structure, btcAligned, shown, runtime, h1Ma5);
    this.records.set(update.pair, {
      runtime,
      view,
      lastSetup: setup,
      lastPrice: update.lastPrice,
      nowMs: update.nowMs,
      runner,
    });
    return view;
  }

  markClosed(pair: PairId, nowMs: number): void {
    this.rollBook(nowMs);
    const rec = this.must(pair);
    if (rec.runtime.state !== 'WORKING' || !rec.lastSetup) return;
    const stepped = stepPair(rec.runtime, {
      nowMs,
      lastPrice: rec.lastPrice,
      maxArmsPerPairPerDay: this.config.max_arms_per_pair_per_day,
      holidayName: null,
      setup: rec.lastSetup,
      draft: null,
      positionClosed: true,
      armPingBody: null,
    });
    this.fillsToday += 1;
    this.emitPings(pair, nowMs, stepped.entered, stepped.runtime.lastPing, null);
    this.records.set(pair, {
      ...rec,
      runtime: stepped.runtime,
      runner: null,
      view: { ...rec.view, state: stepped.runtime.state, reason: stepped.runtime.reason, review: reviewOf(stepped.runtime.state), lastPing: stepped.runtime.lastPing },
      nowMs,
    });
  }

  killToday(nowMs: number): BookSnapshot {
    for (const pair of this.config.pairs) {
      const rec = this.must(pair);
      const stepped = muteRuntime(rec.runtime, nowMs, rec.lastPrice);
      if (stepped.cancel && rec.runtime.order) {
        this.logOrder({
          action: 'cancel',
          clientOrderId: rec.runtime.order.clientOrderId,
          pair,
          type: 'LIMIT',
          reason: 'KILL',
          mode: this.liveArmed ? 'live' : 'dry-run',
          venue: this.config.active_venue,
          tsUk: ukStamp(nowMs),
          tsMs: nowMs,
        });
        this.logOrder({
          action: 'flatten-intent',
          clientOrderId: rec.runtime.order.clientOrderId,
          pair,
          type: 'LIMIT',
          price: rec.lastPrice,
          reason: 'KILL',
          mode: this.liveArmed ? 'live' : 'dry-run',
          venue: this.config.active_venue,
          tsUk: ukStamp(nowMs),
          tsMs: nowMs,
        });
      }
      this.emitPings(pair, nowMs, stepped.entered, stepped.runtime.lastPing, null);
      this.records.set(pair, {
        ...rec,
        runtime: stepped.runtime,
        runner: null,
        view: {
          ...rec.view,
          state: 'BLOCKED',
          reason: 'KILL',
          review: reviewOf('BLOCKED'),
          lastPing: stepped.runtime.lastPing,
        },
        nowMs,
      });
    }
    return this.snapshot(nowMs);
  }

  private draftOrder(
    update: MarketUpdate,
    side: Side,
    entry: number,
    sl: number,
    lock: number,
    tp: number,
    btcAligned: boolean,
    stake: number,
  ): OrderDraft {
    const live = this.liveArmed;
    return {
      clientOrderId: `choke-v1-${update.pair}-${ukDateKey(update.nowMs)}`,
      pair: update.pair,
      side: side === 'long' ? 'buy' : 'sell',
      type: 'LIMIT',
      price: entry,
      qty: positionQty(stake, this.config.leverage, entry, sl, this.config.max_margin_risk),
      sl,
      lockPrice: lock,
      tp,
      reduceOnlySlTp: true,
      liveArmed: live,
      reason: live ? 'LIVE' : 'LIVE_OFF',
      mode: live ? 'live' : 'dry-run',
      venue: this.config.active_venue,
      tsUk: ukStamp(update.nowMs),
      tsMs: update.nowMs,
      btcAligned,
      marginRiskPct: marginRiskPct(entry, sl, this.config.leverage),
      leverage: this.config.leverage,
      tpPricePct: this.config.tp_price_pct,
      stakeUsdt: stake,
    };
  }

  private align(pair: PairId, side: Side | null, nowMs: number): boolean {
    if (!side) return false;
    if (pair === 'BTCUSDT') return this.btc?.side === side && this.btc.sessionDate === ukDateIso(nowMs);
    if (!this.btc) return false;
    return this.btc.side === side && this.btc.sessionDate === ukDateIso(nowMs);
  }

  private emitPings(pair: PairId, nowMs: number, entered: string[], lastPing: string | null, holidayPing: string | null): void {
    if (holidayPing) {
      this.notifier.ping({
        pair,
        state: 'HOLIDAY',
        level: 'warn',
        body: holidayPing,
        tsMs: nowMs,
        tsUk: ukStamp(nowMs),
      });
    }
    for (const state of entered) {
      if (!PING_STATES.has(state)) continue;
      const body = state === 'ARM' ? (lastPing ?? `${pair} ARM`) : (lastPing ?? `${pair} ${state}`);
      this.notifier.ping({
        pair,
        state,
        level: 'info',
        body,
        tsMs: nowMs,
        tsUk: ukStamp(nowMs),
      });
    }
  }

  private logOrder(entry: OrderLogEntry): void {
    if (this.skipOrderLog) return;
    appendOrderLog(this.dryRunPath, entry);
  }

  private rollBook(nowMs: number): void {
    const day = ukDateKey(nowMs);
    if (this.bookDay === null) {
      this.bookDay = day;
      return;
    }
    if (this.bookDay === day) return;
    this.bookDay = day;
    this.fillsToday = 0;
    this.dailyPnlGbp = 0;
  }

  private makeView(
    update: MarketUpdate,
    candles: Candle[],
    timeframe: '5m' | '3m',
    structure: ReturnType<typeof detectStructure>,
    btcAligned: boolean,
    priced: Priced,
    runtime: PairRuntime,
    h1Ma5: number | null,
  ): PairOverlay {
    const side = structure.side;
    const zone = priced.zone;
    const inside = inZone(update.lastPrice, zone);
    const tick = this.config.ticks[update.pair];
    const activeSl = priced.locked ? priced.lock : priced.sl;
    const stamp = stampLine({
      pair: update.pair,
      state: runtime.state,
      sweep: priced.sweep,
      zone,
      sl: activeSl,
      lock: priced.lock,
      locked: priced.locked,
      marginRiskPct: priced.entry != null && priced.sl != null ? marginRiskPct(priced.entry, priced.sl, this.config.leverage) : null,
      leverage: this.config.leverage,
      tp: priced.tp,
      tpPricePct: this.config.tp_price_pct,
      runnerPricePct: this.config.tp_price_pct + this.config.runner_extra_pct,
      btcAligned,
      nowMs: update.nowMs,
      tick,
    });
    return {
      pair: update.pair,
      state: runtime.state,
      reason: runtime.reason,
      side,
      btcAligned,
      liveArmed: this.liveArmed,
      zone,
      sl: activeSl,
      lock: priced.lock,
      locked: priced.locked,
      tp: priced.tp,
      entry: priced.entry,
      marginRiskPct: priced.entry != null && priced.sl != null ? marginRiskPct(priced.entry, priced.sl, this.config.leverage) : null,
      lastPing: runtime.lastPing,
      sweep: priced.sweep,
      neck: priced.neck,
      fvg: priced.fvg,
      lastPrice: update.lastPrice,
      inZone: inside,
      clockUk: ukClock(update.nowMs),
      stamp,
      review: reviewOf(runtime.state),
      warnings: runtime.warnings,
      timeframe,
      candles,
      context30m: 'display-only',
      h1Ma5,
      levels: buildLevels({
        sweep: priced.sweep,
        neck: priced.neck,
        fvg: priced.fvg,
        zone,
        sl: activeSl,
        lock: priced.lock,
        tp: priced.tp,
        lastPrice: update.lastPrice,
        inZone: inside,
      }),
      marks: buildChartMarks({
        candles,
        structure,
        entry: priced.entry,
        sl: activeSl,
        lock: priced.lock,
        tp: priced.tp,
        neck: priced.neck,
      }),
    };
  }

  private shownPrices(priced: Priced, runtime: PairRuntime, runner: RunnerTrack | null): Priced {
    if (runtime.state !== 'WORKING' || !runtime.order || !runner) return priced;
    if (runner.clientOrderId !== runtime.order.clientOrderId) return priced;
    return {
      ...priced,
      entry: runner.entry,
      sl: runner.sl,
      lock: runner.lock,
      tp: runner.tp,
      locked: runner.locked,
    };
  }

  private async advanceRunner(pair: PairId, track: RunnerTrack, update: MarketUpdate): Promise<RunnerTrack> {
    const next: RunnerTrack = { ...track };
    const latest = update.candles5m[update.candles5m.length - 1];
    const laterBar = latest != null && latest.time > next.armCandleTime ? latest : null;
    if (!next.filled) {
      if (this.liveArmed) {
        if (next.orderId && this.venue.orderFilled) {
          next.filled = await Promise.resolve(this.venue.orderFilled(next.orderId));
        }
      } else if (update.nowMs > next.armedMs) {
        const byLast = priceReached(next.side, update.lastPrice, next.entry, false);
        const byBar = laterBar != null && (next.side === 'long' ? laterBar.low <= next.entry : laterBar.high >= next.entry);
        next.filled = byLast || byBar;
      }
    }
    if (!next.filled || next.locked) return next;
    const byLast = priceReached(next.side, update.lastPrice, next.lock, true);
    const byBar = laterBar != null && (next.side === 'long' ? laterBar.high >= next.lock : laterBar.low <= next.lock);
    if (!byLast && !byBar) return next;
    if (this.liveArmed) {
      if (!next.orderId || !this.venue.moveProtection) return next;
      let moved: { ok: boolean; error?: string };
      try {
        moved = await Promise.resolve(
          this.venue.moveProtection({ pair, orderId: next.orderId, sl: next.lock, tp: next.tp }),
        );
      } catch {
        return next;
      }
      if (!moved.ok) return next;
    }
    next.locked = true;
    const tick = this.config.ticks[pair];
    this.notifier.ping({
      pair,
      state: 'WORKING',
      level: 'info',
      body: `${pair} stop moved to ${formatPrice(next.lock, tick)}. Target stays ${formatPrice(next.tp, tick)}.`,
      tsMs: update.nowMs,
      tsUk: ukStamp(update.nowMs),
    });
    return next;
  }

  private workingBook(): { count: number; locked: number } {
    let count = 0;
    let locked = 0;
    for (const rec of this.records.values()) {
      const order = rec.runtime.order;
      if (rec.runtime.state !== 'WORKING' || !order) continue;
      count += 1;
      locked += (order.qty * order.price) / this.config.leverage;
    }
    return { count, locked };
  }

  private shownEquity(): number {
    return this.equityCache?.equity ?? this.paperEquity;
  }

  private shownStake(): number {
    const scale = this.balanceScale;
    if (!scale) return this.config.stake_gbp;
    return slotStake(this.shownEquity(), this.shownEquity(), scale.slots, scale.reserveFrac);
  }

  /** Stake for the order about to be drafted. Published book uses stake_gbp. */
  private async sizeFor(nowMs: number): Promise<{ stake: number; slotsFull: boolean; noSize: boolean }> {
    const book = this.workingBook();
    if (!this.balanceScale) {
      return { stake: this.config.stake_gbp, slotsFull: false, noSize: false };
    }
    const scale = this.balanceScale;
    const slotsFull = book.count >= scale.slots;
    const row = await this.readEquity(nowMs, book.locked);
    if (!row) return { stake: 0, slotsFull, noSize: !slotsFull };
    const stake = slotStake(row.equity, row.available, scale.slots, scale.reserveFrac);
    return { stake, slotsFull, noSize: !slotsFull && !(stake > 0) };
  }

  private async readEquity(nowMs: number, locked: number): Promise<{ equity: number; available: number } | null> {
    const scale = this.balanceScale;
    if (!scale) return null;
    if (!this.liveArmed || !this.venue.accountEquity) {
      return { equity: this.paperEquity, available: Math.max(0, this.paperEquity - locked) };
    }
    if (this.equityCache && nowMs - this.equityCache.at < 5_000) return this.equityCache;
    try {
      const row = await this.venue.accountEquity();
      if (row && row.equity > 0 && row.available >= 0) {
        this.equityCache = { at: nowMs, equity: row.equity, available: row.available };
        this.paperEquity = row.equity;
        return this.equityCache;
      }
    } catch {
      // Keep the last good read. A missed call must not invent a size.
    }
    return this.equityCache;
  }

  private must(pair: PairId): PairRecord {
    const rec = this.records.get(pair);
    if (!rec) throw new Error(`unknown pair ${pair}`);
    return rec;
  }

  private latestNow(): number {
    let n = Date.now();
    for (const rec of this.records.values()) if (rec.nowMs) n = rec.nowMs;
    return n;
  }
}

interface Priced {
  zone: Zone | null;
  entry: number | null;
  sl: number | null;
  lock: number | null;
  locked: boolean;
  tp: number | null;
  sweep: number | null;
  neck: number | null;
  fvg: { low: number; high: number } | null;
  tagged: boolean;
  chase: boolean;
  fatStop: boolean;
  deeperReached: boolean;
}

function priceSetup(args: {
  candles: Candle[];
  structure: ReturnType<typeof detectStructure>;
  h1Ma5: number | null;
  lastPrice: number;
  tick: number;
  config: AppConfig;
}): Priced {
  const { structure, candles, h1Ma5, lastPrice, tick, config } = args;
  const base: Priced = {
    zone: null,
    entry: null,
    sl: null,
    lock: null,
    locked: false,
    tp: null,
    sweep: structure.sweep?.price ?? null,
    neck: structure.neck?.line ?? null,
    fvg: structure.fvg ? { low: structure.fvg.lower, high: structure.fvg.upper } : null,
    tagged: false,
    chase: false,
    fatStop: false,
    deeperReached: false,
  };
  if (!structure.side || !structure.sweep || !structure.smash || !structure.neck?.ok || !structure.fvg) {
    return base;
  }
  const side = structure.side;
  const mode = selectProfile().entryAnchor;
  const anchor = fvgAnchor(side, structure.fvg.lower, structure.fvg.upper, mode);
  const cap =
    mode === 'far'
      ? side === 'long'
        ? entryCapLong(h1Ma5, structure.sweep.price, structure.smash.extreme, structure.fvg.lower)
        : entryCapShort(h1Ma5, structure.sweep.price, structure.smash.extreme, structure.fvg.upper)
      : anchor;
  const structural =
    mode === 'far'
      ? zoneFromEdges(side === 'long' ? structure.fvg.lower : structure.fvg.upper, cap)
      : zoneFromEdges(structure.fvg.lower, structure.fvg.upper);
  const zone = clipZone(side, structural, lastPrice);
  const later = selectProfile().tighterWick ? laterExtremeWick(side, candles, structure.sweep.index) : null;
  const sl = stopLoss(side, structure.sweep.price, later, tick);
  const acceptable = acceptableEntry(side, sl, config.leverage, config.max_margin_risk);
  const fatStop = isFatStop(side, cap, sl, config.leverage, config.max_margin_risk);
  const deeperReached = reachedDeeper(side, candles, structure.smash.index, acceptable, sl, lastPrice);
  const tagged = priceTaggedZone(side, candles, structure.smash.index + 1, structural, lastPrice);
  const chase = isChase(side, lastPrice, structural, structure.neck.height, config.chase_neck_frac);
  const entry = fatStop
    ? deeperReached
      ? deeperLimit(side, acceptable, lastPrice, tick)
      : roundToTick(cap, tick, side === 'long' ? 'floor' : 'ceil')
    : restingLimit(side, cap, lastPrice, tick);
  const lock = takeProfit(side, entry, config.tp_price_pct, tick);
  const tp = takeProfit(side, entry, config.tp_price_pct + config.runner_extra_pct, tick);
  const tradableStop = stopProtects(side, entry, sl) && stopIsWideEnough(entry, sl) && stopIsWithinCap(entry, sl);
  return {
    ...base,
    zone,
    entry,
    sl,
    lock,
    tp,
    tagged: tagged && tradableStop,
    chase,
    fatStop,
    deeperReached: deeperReached && tradableStop,
  };
}

function trackFrom(order: OrderDraft, orderId: string | null, update: MarketUpdate): RunnerTrack {
  const latest = update.candles5m[update.candles5m.length - 1];
  return {
    orderId,
    clientOrderId: order.clientOrderId,
    side: order.side === 'buy' ? 'long' : 'short',
    entry: order.price,
    sl: order.sl,
    lock: order.lockPrice,
    tp: order.tp,
    filled: false,
    locked: false,
    armedMs: update.nowMs,
    armCandleTime: latest?.time ?? update.nowMs,
  };
}

function fvgAnchor(side: Side, lower: number, upper: number, mode: 'far' | 'near' | 'mid'): number {
  if (mode === 'mid') return (lower + upper) / 2;
  if (mode === 'near') return side === 'long' ? upper : lower;
  return side === 'long' ? lower : upper;
}

function restingLimit(side: Side, entryCap: number, last: number, tick: number): number {
  if (side === 'long') return roundToTick(Math.min(entryCap, last), tick, 'floor');
  return roundToTick(Math.max(entryCap, last), tick, 'ceil');
}

function deeperLimit(side: Side, acceptable: number, last: number, tick: number): number {
  if (side === 'long') {
    const raw = last < acceptable ? Math.min(acceptable, last) : acceptable;
    return roundToTick(raw, tick, 'floor');
  }
  const raw = last > acceptable ? Math.max(acceptable, last) : acceptable;
  return roundToTick(raw, tick, 'ceil');
}

function reachedDeeper(
  side: Side,
  candles: Candle[],
  smashIndex: number,
  acceptable: number,
  sl: number,
  last: number,
): boolean {
  for (let i = smashIndex + 1; i < candles.length; i++) {
    if (side === 'long' && candles[i].low <= acceptable && candles[i].low > sl) return true;
    if (side === 'short' && candles[i].high >= acceptable && candles[i].high < sl) return true;
  }
  if (side === 'long') return last <= acceptable && last > sl;
  return last >= acceptable && last < sl;
}

export function formatArmPing(order: OrderDraft, tick: number): string {
  const name = order.pair.replace(/USDT$/, '');
  const verb = order.side === 'buy' ? 'buy' : 'sell';
  const pct = (order.marginRiskPct * 100).toFixed(1);
  const live = order.liveArmed ? 'sent' : 'dry-run | sent';
  const ofEntry = (level: number) => `${((Math.abs(level - order.price) / order.price) * 100).toFixed(2)}%`;
  return [
    `${name} ARM first-tag`,
    `${verb} ${formatPrice(order.price, tick)}`,
    `size ${order.stakeUsdt.toFixed(2)} USDT`,
    `sl ${formatPrice(order.sl, tick)} (${pct}% margin @${order.leverage}x)`,
    `lock ${formatPrice(order.lockPrice, tick)} (${ofEntry(order.lockPrice)})`,
    `tp ${formatPrice(order.tp, tick)} (${ofEntry(order.tp)})`,
    `btc_aligned: ${order.btcAligned ? 'yes' : 'no'}`,
    `LIVE: ${live}`,
  ].join('\n');
}

function emptyView(pair: PairId, config: AppConfig): PairOverlay {
  return {
    pair,
    state: 'FLAT',
    reason: null,
    side: null,
    btcAligned: false,
    liveArmed: config.live_armed,
    zone: null,
    sl: null,
    lock: null,
    locked: false,
    tp: null,
    entry: null,
    marginRiskPct: null,
    lastPing: null,
    sweep: null,
    neck: null,
    fvg: null,
    lastPrice: 0,
    inZone: false,
    clockUk: '',
    stamp: `${pair} FLAT`,
    review: 'PENDING',
    warnings: [],
    timeframe: '5m',
    candles: [],
    context30m: 'display-only',
    h1Ma5: null,
    levels: [],
    marks: [],
  };
}
