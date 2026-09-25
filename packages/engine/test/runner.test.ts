import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stepProtect, type ProtectTrade } from '../src/runner.ts';

function trade(over: Partial<ProtectTrade> = {}): ProtectTrade {
  return {
    side: 'long',
    entry: 100,
    sl: 99,
    lock: 101.33,
    tp: 101.83,
    filled: false,
    locked: false,
    ...over,
  };
}

describe('runner lock', () => {
  it('keeps a 1.33% winner when price comes back, and pays the further target when it holds', () => {
    const missed = stepProtect(trade(), { high: 100.4, low: 100.2 });
    assert.equal(missed.filled, false);
    assert.equal(missed.outcome, null);

    const locked = stepProtect(trade(), { high: 101.4, low: 99.5 });
    assert.equal(locked.filled, true);
    assert.equal(locked.locked, true);
    assert.equal(locked.outcome, null);

    const back = stepProtect({ ...trade(), filled: true, locked: true }, { high: 101.5, low: 101.33 });
    assert.equal(back.outcome, 'WIN');
    assert.equal(back.exit, 101.33);

    const ran = stepProtect({ ...trade(), filled: true, locked: true }, { high: 101.83, low: 101.4 });
    assert.equal(ran.outcome, 'WIN');
    assert.equal(ran.exit, 101.83);

    const both = stepProtect({ ...trade(), filled: true, locked: true }, { high: 102, low: 101.2 });
    assert.equal(both.outcome, 'WIN');
    assert.equal(both.exit, 101.33);
  });

  it('still stops a loser at the structure stop when that bar also trades the lock', () => {
    const stopped = stepProtect(trade(), { high: 101.9, low: 98.5 });
    assert.equal(stopped.outcome, 'LOSS');
    assert.equal(stopped.exit, 99);
    assert.equal(stopped.locked, false);
  });

  it('mirrors the lock for a short', () => {
    const short = trade({ side: 'short', entry: 100, sl: 101, lock: 98.67, tp: 98.17 });
    const locked = stepProtect(short, { high: 100.2, low: 98.5 });
    assert.equal(locked.locked, true);
    assert.equal(locked.outcome, null);
    const ran = stepProtect({ ...short, filled: true, locked: true }, { high: 98.6, low: 98.17 });
    assert.equal(ran.outcome, 'WIN');
    assert.equal(ran.exit, 98.17);
  });
});
