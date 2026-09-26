import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { readOrderLog } from '../src/dryRun.ts';
import { ChokeEngine, type NotifierPort, type VenuePort } from '../src/engine.ts';
import { positionQty, slotStake } from '../src/risk.ts';
import { demoBook, ETH_T0 } from '../src/synthetic.ts';
import { findRepoRoot } from './root.ts';

function memoryNotifier(): NotifierPort & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    ping(event) {
      events.push(`${event.state}:${event.pair}`);
    },
  };
}

function venue(id: 'mexc' | 'kucoin', failSl = false): VenuePort & { calls: number } {
  return {
    id,
    calls: 0,
    health: () => ({ ok: true }),
    placeLimitWithProtection(req) {
      this.calls += 1;
      assert.equal(req.type, 'LIMIT');
      if (failSl) return { ok: false, cancelledBecauseSlFailed: true, error: 'SL_ATTACH_FAILED' };
      return { ok: true, orderId: 'sim' };
    },
  };
}

describe('engine dry-run', () => {
  const root = findRepoRoot();
  const config = loadConfig(join(root, 'config/default.json'));

  it('writes a LIMIT dry-run for the morning ETH setup and does not call the venue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'choke-'));
    const log = join(dir, 'orders.json');
    const note = memoryNotifier();
    const vx = venue('kucoin');
    const engine = new ChokeEngine({ config, venue: vx, notifier: note, dryRunPath: log });
    const book = demoBook();
    const snap = await engine.runBook(book.updates);
    assert.equal(config.live_armed, false);
    assert.equal(snap.window, 'disabled');
    assert.equal(snap.liveArmed, false);
    assert.equal(engine.venuePlaceCalls, 0);

    const eth = snap.pairs.find((p) => p.pair === 'ETHUSDT');
    const btc = snap.pairs.find((p) => p.pair === 'BTCUSDT');
    const sol = snap.pairs.find((p) => p.pair === 'SOLUSDT');
    assert.equal(eth?.state, 'WORKING');
    assert.equal(eth?.btcAligned, false);
    assert.equal(eth?.review, 'TAKE');
    assert.equal(sol?.state, 'FORMING');
    assert.equal(btc?.state, 'FLAT');
    assert.equal(eth?.context30m, 'display-only');
    assert.ok(eth?.levels.some((l) => l.label === 'sweep' && l.color === 'orange'));
    assert.ok(eth?.levels.some((l) => l.label === 'neck' && l.color === 'white'));
    assert.ok(eth?.levels.some((l) => l.label === 'FVG' && l.color === 'purple'));
    assert.ok(eth?.levels.some((l) => l.label === 'zone' && l.color === 'green'));
    assert.ok(eth?.levels.some((l) => l.label === 'SL' && l.color === 'red'));
    assert.ok(eth?.levels.some((l) => l.label === 'TP' && l.color === 'blue'));
    assert.equal(eth?.levels.some((l) => l.label === 'NOW'), false);
    const kinds = new Set((eth?.marks ?? []).map((m) => m.kind));
    for (const kind of ['FVG', 'MSS', 'BOS', 'ENTRY', 'TP', 'SL']) {
      assert.ok(kinds.has(kind as 'FVG'), `missing ${kind}`);
    }
    assert.equal(eth?.marks.find((m) => m.kind === 'ENTRY')?.price, 2650.2);
    assert.equal(eth?.marks.find((m) => m.kind === 'SL')?.price, 2639.2);
    assert.equal(eth?.marks.find((m) => m.kind === 'LOCK')?.price, 2685.45);
    assert.equal(eth?.marks.find((m) => m.kind === 'TP')?.price, 2698.7);
    assert.equal(eth?.locked, false);
    assert.equal(eth?.marks.find((m) => m.kind === 'FVG')?.price, 2650);

    const orders = readOrderLog(log);
    assert.equal(orders.length, 1);
    const order = orders[0];
    assert.equal(order.type, 'LIMIT');
    if (!('price' in order) || !('clientOrderId' in order)) throw new Error('expected order');
    assert.equal(order.clientOrderId, 'choke-v1-ETHUSDT-20260924');
    assert.equal(order.side, 'buy');
    assert.equal(order.price, 2650.2);
    assert.equal(order.sl, 2639.2);
    assert.equal(order.lockPrice, 2685.45);
    assert.equal(order.tp, 2698.7);
    assert.equal(order.reduceOnlySlTp, true);
    assert.equal(order.liveArmed, false);
    assert.equal(order.reason, 'LIVE_OFF');
    assert.equal(order.mode, 'dry-run');
    assert.equal(order.venue, 'kucoin');
    assert.equal(order.btcAligned, false);
    assert.ok(order.marginRiskPct < 0.06);
    assert.ok(note.events.includes('ARM:ETHUSDT'));
    assert.ok(note.events.includes('FORMING:SOLUSDT'));

    await engine.runBook(book.updates);
    assert.equal(readOrderLog(log).length, 1);
    assert.equal(engine.runtime('ETHUSDT').state, 'WORKING');
  });

  it('still arms on Christmas and only warns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'choke-'));
    const engine = new ChokeEngine({
      config,
      venue: venue('kucoin'),
      notifier: memoryNotifier(),
      dryRunPath: join(dir, 'orders.json'),
    });
    const xmas = Date.parse('2026-12-25T06:00:00.000Z');
    const snap = await engine.runBook(demoBook(xmas).updates);
    const eth = snap.pairs.find((p) => p.pair === 'ETHUSDT');
    assert.equal(snap.holiday.active, true);
    assert.equal(eth?.state, 'WORKING');
    assert.ok(eth?.warnings.includes('HOLIDAY'));
    const order = readOrderLog(join(dir, 'orders.json'))[0];
    if (!order || !('clientOrderId' in order)) throw new Error('missing order');
    assert.equal(order.clientOrderId, 'choke-v1-ETHUSDT-20261225');
  });

  it('calls the armed venue and blocks when the stop cannot attach', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'choke-'));
    const log = join(dir, 'orders.json');
    const live = { ...config, live_armed: true as const };
    const vx = venue('kucoin', true);
    const engine = new ChokeEngine({ config: live, venue: vx, notifier: memoryNotifier(), dryRunPath: log });
    await engine.runBook(demoBook(ETH_T0).updates);
    assert.equal(engine.venuePlaceCalls, 1);
    assert.equal(vx.calls, 1);
    assert.equal(engine.runtime('ETHUSDT').state, 'BLOCKED');
    assert.equal(engine.runtime('ETHUSDT').reason, 'SL_ATTACH_FAILED');
    const entries = readOrderLog(log);
    assert.equal(entries.length, 1);
    assert.equal('action' in entries[0] && entries[0].action, 'cancel');
  });

  it('moves the paper stop to the 1.33% lock and leaves the runner target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'choke-'));
    const engine = new ChokeEngine({
      config,
      venue: venue('kucoin'),
      notifier: memoryNotifier(),
      dryRunPath: join(dir, 'orders.json'),
    });
    const book = demoBook();
    await engine.runBook(book.updates);
    const ethUpdate = book.updates.filter((u) => u.pair === 'ETHUSDT').at(-1);
    if (!ethUpdate) throw new Error('missing eth');
    const atEntry = await engine.ingest({ ...ethUpdate, lastPrice: 2650.2, nowMs: ethUpdate.nowMs + 60_000 });
    assert.equal(atEntry.locked, false);
    assert.equal(atEntry.sl, 2639.2);
    const locked = await engine.ingest({ ...ethUpdate, lastPrice: 2690, nowMs: ethUpdate.nowMs + 120_000 });
    assert.equal(locked.locked, true);
    assert.equal(locked.sl, 2685.45);
    assert.equal(locked.lock, 2685.45);
    assert.equal(locked.tp, 2698.7);
    assert.equal(locked.marks.find((m) => m.kind === 'SL')?.price, 2685.45);
    assert.equal(locked.marks.find((m) => m.kind === 'TP')?.price, 2698.7);
  });

  it('amends the MEXC stop only after the limit has filled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'choke-'));
    let filled = false;
    const moves: { orderId: string; sl: number; tp: number }[] = [];
    const engine = new ChokeEngine({
      config,
      venue: {
        id: 'mexc',
        health: () => ({ ok: true }),
        placeLimitWithProtection() {
          return { ok: true, orderId: '99' };
        },
        orderFilled() {
          return filled;
        },
        moveProtection(req) {
          moves.push(req);
          return { ok: true };
        },
      },
      notifier: memoryNotifier(),
      dryRunPath: join(dir, 'orders.json'),
    });
    engine.setLiveArmed(true);
    const book = demoBook();
    await engine.runBook(book.updates);
    const ethUpdate = book.updates.filter((u) => u.pair === 'ETHUSDT').at(-1);
    if (!ethUpdate) throw new Error('missing eth');
    await engine.ingest({ ...ethUpdate, lastPrice: 2690, nowMs: ethUpdate.nowMs + 60_000 });
    assert.equal(moves.length, 0);
    filled = true;
    await engine.ingest({ ...ethUpdate, lastPrice: 2650.2, nowMs: ethUpdate.nowMs + 120_000 });
    assert.equal(moves.length, 0);
    const view = await engine.ingest({ ...ethUpdate, lastPrice: 2690, nowMs: ethUpdate.nowMs + 180_000 });
    assert.equal(moves.length, 1);
    assert.equal(moves[0].orderId, '99');
    assert.equal(moves[0].sl, 2685.45);
    assert.equal(moves[0].tp, 2698.7);
    assert.equal(view.locked, true);
    assert.equal(view.sl, 2685.45);
  });

  it('paints a stale refresh without writing an order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'choke-'));
    const log = join(dir, 'orders.json');
    const engine = new ChokeEngine({
      config,
      venue: venue('kucoin'),
      notifier: memoryNotifier(),
      dryRunPath: log,
    });
    const updates = demoBook().updates.map((u) => ({ ...u, forceStale: true }));
    const snap = await engine.runBook(updates);
    const eth = snap.pairs.find((p) => p.pair === 'ETHUSDT');
    assert.notEqual(eth?.state, 'WORKING');
    assert.equal(engine.venuePlaceCalls, 0);
    assert.equal(readOrderLog(log).length, 0);
    assert.ok((eth?.marks ?? []).some((m) => m.kind === 'FVG'));
  });

  it('sizes two desk trades from half of 100 USDT and waits on the third', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'choke-'));
    const engine = new ChokeEngine({
      config: { ...config, ticks: { BTCUSDT: 0.01, ETHUSDT: 0.01, SOLUSDT: 0.01 } },
      venue: venue('kucoin'),
      notifier: memoryNotifier(),
      dryRunPath: join(dir, 'orders.json'),
      balanceScale: { slots: 2, reserveFrac: 0.02, startUsdt: 100 },
    });
    const book = demoBook();
    const ethUpdate = book.updates.find((u) => u.pair === 'ETHUSDT');
    if (!ethUpdate) throw new Error('missing eth');
    const updates = book.updates.map((u) => ({
      ...u,
      candles5m: ethUpdate.candles5m,
      candles1h: ethUpdate.candles1h,
      lastPrice: ethUpdate.lastPrice,
    }));
    const snap = await engine.runBook(updates);
    assert.equal(snap.balanceUsdt, 100);
    assert.equal(snap.balanceSlots, 2);
    assert.equal(snap.tradeStakeUsdt, 49);
    assert.equal(snap.openTrades, 2);
    assert.equal(engine.runtime('BTCUSDT').state, 'WORKING');
    assert.equal(engine.runtime('ETHUSDT').state, 'WORKING');
    assert.equal(engine.runtime('SOLUSDT').state, 'WAIT_RETRACE');
    assert.equal(engine.runtime('SOLUSDT').reason, 'SLOTS_FULL');
    const order = engine.runtime('ETHUSDT').order;
    if (!order) throw new Error('missing order');
    assert.equal(order.stakeUsdt, 49);
    assert.equal(order.qty, positionQty(49, 10, order.price, order.sl, config.max_margin_risk));
    assert.ok(order.qty < 0.3);
    assert.equal(order.price, 2650.2);
    assert.equal(order.sl, 2639.2);
    assert.equal(order.lockPrice, 2685.45);
    assert.equal(order.tp, 2698.7);
  });

  it('sizes a live order from the MEXC USDT balance and sends nothing when the balance is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'choke-'));
    let equity: { equity: number; available: number } | null = { equity: 250, available: 200 };
    const engine = new ChokeEngine({
      config,
      venue: {
        id: 'mexc',
        health: () => ({ ok: true }),
        placeLimitWithProtection() {
          return { ok: true, orderId: '1' };
        },
        accountEquity() {
          return Promise.resolve(equity);
        },
      },
      notifier: memoryNotifier(),
      dryRunPath: join(dir, 'orders.json'),
      balanceScale: { slots: 2, reserveFrac: 0.02, startUsdt: 100 },
    });
    engine.setLiveArmed(true);
    await engine.runBook(demoBook().updates);
    const order = engine.runtime('ETHUSDT').order;
    if (!order) throw new Error('missing order');
    assert.equal(order.stakeUsdt, slotStake(250, 200, 2, 0.02));
    assert.equal(order.qty, positionQty(order.stakeUsdt, 10, order.price, order.sl, config.max_margin_risk));
    assert.equal(engine.snapshot().balanceUsdt, 250);
    assert.equal(engine.venuePlaceCalls, 1);

    const blocked = new ChokeEngine({
      config,
      venue: {
        id: 'mexc',
        health: () => ({ ok: true }),
        placeLimitWithProtection() {
          return { ok: true, orderId: '1' };
        },
        accountEquity() {
          return Promise.resolve(null);
        },
      },
      notifier: memoryNotifier(),
      dryRunPath: join(dir, 'none.json'),
      balanceScale: { slots: 2, reserveFrac: 0.02, startUsdt: 100 },
    });
    blocked.setLiveArmed(true);
    await blocked.runBook(demoBook().updates);
    assert.equal(blocked.runtime('ETHUSDT').state, 'WAIT_RETRACE');
    assert.equal(blocked.runtime('ETHUSDT').reason, 'NO_BALANCE');
    assert.equal(blocked.venuePlaceCalls, 0);
  });
});
