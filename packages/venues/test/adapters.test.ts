import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMexc, createKucoin, createVenue } from '../src/index.ts';

const req = {
  clientOrderId: 'choke-v1-SOLUSDT-20260924',
  pair: 'SOLUSDT',
  side: 'sell' as const,
  type: 'LIMIT' as const,
  price: 150,
  qty: 10,
  sl: 151,
  tp: 148.32,
  reduceOnlySlTp: true as const,
};

describe('venue adapters', () => {
  it('switches between MEXC and KuCoin stubs and only accepts LIMIT protection', () => {
    for (const id of ['mexc', 'kucoin'] as const) {
      const venue = createVenue(id);
      assert.equal(venue.id, id);
      assert.equal(venue.health().ok, true);
      const placed = venue.placeLimitWithProtection(req);
      assert.equal(placed.ok, true);
      assert.match(placed.orderId ?? '', new RegExp(`^sim-${id}-`));
    }
    assert.equal(createMexc().id, 'mexc');
    assert.equal(createKucoin().id, 'kucoin');
  });

  it('cancels the limit when the stop cannot attach', () => {
    const venue = createKucoin({ failSl: true });
    const placed = venue.placeLimitWithProtection(req);
    assert.equal(placed.ok, false);
    assert.equal(placed.cancelledBecauseSlFailed, true);
  });

  it('rejects an unhealthy venue and a market order', () => {
    const down = createMexc({ healthy: false });
    assert.equal(down.health().ok, false);
    const bad = createMexc().placeLimitWithProtection({ ...req, type: 'MARKET' as 'LIMIT' });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'MARKET_FORBIDDEN');
  });
});
