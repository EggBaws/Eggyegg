import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { candle, detectStructure } from '../src/candles.ts';
import { loadConfig } from '../src/config.ts';
import { readOrderLog } from '../src/dryRun.ts';
import { ChokeEngine, type NotifierPort, type VenuePort } from '../src/engine.ts';
import {
  fvgIsTradable,
  neckIsSized,
  selectiveFacts,
  smashBrokeNeck,
  stopIsWideEnough,
  stopIsWithinCap,
  stopProtects,
} from '../src/select.ts';
import { demoBook, ethLongCandles, ethNowMs, ETH_T0 } from '../src/synthetic.ts';
import { ukMidnightMs } from '../src/time.ts';
import { findRepoRoot } from './root.ts';

function quiet(): NotifierPort {
  return { ping() {} };
}

function venue(): VenuePort {
  return {
    id: 'kucoin',
    health: () => ({ ok: true }),
    placeLimitWithProtection() {
      return { ok: true, orderId: 'sim' };
    },
  };
}

describe('selective gates', () => {
  const config = loadConfig(join(findRepoRoot(), 'config/default.json'));

  it('accepts the locked ETH morning book', () => {
    const candles = ethLongCandles();
    const structure = detectStructure(candles, 0.01, ukMidnightMs(ethNowMs()), '5m');
    const facts = selectiveFacts(candles, structure);
    assert.equal(smashBrokeNeck(candles, structure), true);
    assert.equal(neckIsSized(structure.neck, structure.sweep?.price ?? 0), true);
    assert.equal(fvgIsTradable(structure.fvg, structure.sweep?.price ?? 0), true);
    assert.equal(facts.hasSmash, true);
    assert.equal(facts.hasFvg, true);
    assert.equal(stopIsWideEnough(2650, 2641.99), true);
    assert.equal(stopProtects('long', 2650, 2641.99), true);
    assert.equal(stopProtects('short', 2118.53, 2110.01), false);
  });

  it('does not arm when the smash fails to close through the neck', async () => {
    const candles = ethLongCandles();
    const smash = candles[10];
    candles[10] = candle(smash.time, 2655, 2670, 2650.2, 2650.8);
    const structure = detectStructure(candles, 0.01, ukMidnightMs(ethNowMs()), '5m');
    assert.equal(selectiveFacts(candles, structure).hasSmash, false);

    const book = demoBook();
    const eth = book.updates.find((u) => u.pair === 'ETHUSDT');
    if (!eth) throw new Error('missing eth');
    eth.candles5m = candles;
    const dir = mkdtempSync(join(tmpdir(), 'choke-'));
    const engine = new ChokeEngine({
      config,
      venue: venue(),
      notifier: quiet(),
      dryRunPath: join(dir, 'orders.json'),
    });
    const snap = await engine.runBook(book.updates);
    const view = snap.pairs.find((p) => p.pair === 'ETHUSDT');
    assert.notEqual(view?.state, 'WORKING');
    assert.equal(readOrderLog(join(dir, 'orders.json')).length, 0);
  });

  it('keeps the stop on the sweep wick when a later candle trades inside it', async () => {
    const candles = ethLongCandles();
    const mid = candles[9];
    candles[9] = candle(mid.time, 2648, 2651, 2647, 2649);
    const dir = mkdtempSync(join(tmpdir(), 'choke-'));
    const log = join(dir, 'orders.json');
    const engine = new ChokeEngine({
      config,
      venue: venue(),
      notifier: quiet(),
      dryRunPath: log,
    });
    const book = demoBook();
    const eth = book.updates.find((u) => u.pair === 'ETHUSDT');
    if (!eth) throw new Error('missing eth');
    eth.candles5m = candles;
    const snap = await engine.runBook(book.updates);
    const view = snap.pairs.find((p) => p.pair === 'ETHUSDT');
    assert.equal(view?.state, 'WORKING');
    const orders = readOrderLog(log);
    assert.equal(orders.length, 1);
    const order = orders[0];
    if (!order || !('sl' in order)) throw new Error('expected order');
    assert.equal(order.sl, 2639.2);
  });

  it('counts a 2-candle gap once it has height, and keeps the stop inside 0.20% to 0.50%', () => {
    const candles = ethLongCandles();
    const structure = detectStructure(candles, 0.01, ukMidnightMs(ethNowMs()), '5m');
    assert.equal(structure.fvg?.kind, '3candle');
    const two = structure.fvg
      ? { ...structure.fvg, kind: '2candle' as const, lower: structure.fvg.lower, upper: structure.fvg.lower + 4 }
      : null;
    assert.equal(fvgIsTradable(two, structure.sweep?.price ?? 0), true);
    assert.equal(fvgIsTradable(null, structure.sweep?.price ?? 0), false);
    assert.equal(stopIsWideEnough(100, 99.81), false);
    assert.equal(stopIsWideEnough(100, 99.8), true);
    assert.equal(stopIsWithinCap(100, 99.5), false);
    assert.equal(stopIsWithinCap(100, 99.51), true);
  });

  it('still arms the untouched ETH book', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'choke-'));
    const engine = new ChokeEngine({
      config,
      venue: venue(),
      notifier: quiet(),
      dryRunPath: join(dir, 'orders.json'),
    });
    const snap = await engine.runBook(demoBook(ETH_T0).updates);
    assert.equal(snap.pairs.find((p) => p.pair === 'ETHUSDT')?.state, 'WORKING');
  });
});
