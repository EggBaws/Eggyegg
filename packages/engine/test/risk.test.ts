import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { acceptableEntry, isFatStop, marginRiskPct, positionQty, slotStake, stopLoss, takeProfit } from '../src/risk.ts';

describe('stop, target, size', () => {
  it('uses a later tighter wick, otherwise the sweep wick', () => {
    assert.equal(stopLoss('long', 2639.21, 2642, 0.01), 2641.99);
    assert.equal(stopLoss('long', 99, null, 0.1), 98.9);
    assert.equal(stopLoss('long', 99, 98.5, 0.1), 98.9);
    assert.equal(stopLoss('short', 112, 110, 0.01), 110.01);
    assert.equal(stopLoss('short', 112, 113, 0.01), 112.01);
  });

  it('freezes take profit at 1.12% of entry', () => {
    assert.equal(takeProfit('long', 2650, 0.0112, 0.01), 2679.68);
    assert.equal(takeProfit('short', 100, 0.0112, 0.01), 98.88);
    assert.equal(takeProfit('long', 2654.8, 0.0112, 0.01), 2684.53);
    assert.notEqual(takeProfit('long', 100, 0.0112, 0.01), 118);
  });

  it('computes margin risk as leverage times price distance', () => {
    const risk = marginRiskPct(2650, 2641.99, 10);
    assert.ok(Math.abs(risk - (10 * 8.01) / 2650) < 1e-12);
    assert.equal(isFatStop('long', 100, 99.5, 10, 0.06), false);
    assert.equal(isFatStop('long', 100, 99.3, 10, 0.06), true);
  });

  it('flags NEED_DEEPER when even the entry cap is fatter than 6% margin', () => {
    const sl = 90;
    const cap = 100;
    assert.equal(isFatStop('long', cap, sl, 10, 0.06), true);
    const deepestOk = acceptableEntry('long', sl, 10, 0.06);
    assert.ok(deepestOk < cap);
    assert.ok(Math.abs(marginRiskPct(deepestOk, sl, 10) - 0.06) < 1e-9);
    assert.equal(isFatStop('long', deepestOk, sl, 10, 0.06), false);
  });

  it('sizes to the tighter of notional and stop-risk caps', () => {
    const qty = positionQty(1000, 10, 2650, 2641.99, 0.06);
    const byNotional = 10_000 / 2650;
    const byRisk = 60 / 8.01;
    assert.ok(qty <= byNotional + 1e-8);
    assert.ok(qty <= byRisk + 1e-8);
    assert.ok(Math.abs(qty - Math.floor(Math.min(byNotional, byRisk) * 1e8) / 1e8) < 1e-12);
    const tight = positionQty(1000, 10, 100, 99.6, 0.06);
    assert.equal(tight, 100);
  });

  it('gives each open trade half the balance and leaves a fee reserve', () => {
    assert.equal(slotStake(100, 100, 2, 0.02), 49);
    assert.equal(slotStake(100, 51, 2, 0.02), 49);
    assert.equal(slotStake(100, 40, 2, 0.02), 39.2);
    assert.equal(slotStake(100, 0, 2, 0.02), 0);
    assert.equal(slotStake(0, 0, 2, 0.02), 0);
  });
});
