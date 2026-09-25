import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { readOrderLog } from '../src/dryRun.ts';
import { ChokeEngine, type NotifierPort, type VenuePort } from '../src/engine.ts';
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
    assert.equal(eth?.marks.find((m) => m.kind === 'TP')?.price, 2663.45);
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
    assert.equal(order.tp, 2663.45);
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
});
