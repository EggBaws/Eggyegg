import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initialRuntime, stepPair, type SetupFacts, type StepInput } from '../src/stateMachine.ts';
import type { OrderDraft } from '../src/types.ts';

function setup(over: Partial<SetupFacts> = {}): SetupFacts {
  return {
    hasSweep: true,
    hasSmash: true,
    hasFvg: true,
    neckEvaluated: true,
    neckOk: true,
    invalidated: false,
    tagged: true,
    chase: false,
    fatStop: false,
    deeperReached: false,
    displacementWithoutSweep: false,
    venueHealthy: true,
    liveArmed: false,
    dailyKill: false,
    stale: false,
    holiday: false,
    btcAligned: false,
    fillsAtCap: false,
    boxId: 'long:1',
    side: 'long',
    ...over,
  };
}

function draft(): OrderDraft {
  return {
    clientOrderId: 'choke-v1-ETHUSDT-20260924',
    pair: 'ETHUSDT',
    side: 'buy',
    type: 'LIMIT',
    price: 2650,
    qty: 1,
    sl: 2641.99,
    tp: 2679.68,
    reduceOnlySlTp: true,
    liveArmed: false,
    reason: 'LIVE_OFF',
    mode: 'dry-run',
    venue: 'kucoin',
    tsUk: '2026-09-24T08:00:00.500+01:00',
    tsMs: 1,
    btcAligned: false,
    marginRiskPct: 0.03,
    leverage: 10,
    tpPricePct: 0.0112,
  };
}

function input(over: Partial<StepInput> = {}, facts: Partial<SetupFacts> = {}): StepInput {
  return {
    nowMs: Date.parse('2026-09-24T07:00:00.500Z'),
    lastPrice: 2650.2,
    maxArmsPerPairPerDay: 1,
    holidayName: null,
    setup: setup(facts),
    draft: draft(),
    positionClosed: false,
    armPingBody: 'ETH ARM first-tag',
    ...over,
  };
}

describe('state machine', () => {
  it('walks FLAT → FORMING → WAIT_RETRACE → ARM → WORKING → DONE and logs UK timestamps', () => {
    let rt = initialRuntime('ETHUSDT');
    rt = stepPair(rt, input({}, { hasSmash: false, hasFvg: false, neckEvaluated: false, tagged: false })).runtime;
    assert.equal(rt.state, 'FORMING');
    rt = stepPair(rt, input({}, { tagged: false })).runtime;
    assert.equal(rt.state, 'WAIT_RETRACE');
    const armed = stepPair(rt, input());
    assert.equal(armed.runtime.state, 'WORKING');
    assert.equal(armed.order?.type, 'LIMIT');
    assert.equal(armed.order?.reason, 'LIVE_OFF');
    assert.equal(armed.runtime.order?.btcAligned, false);
    const done = stepPair(armed.runtime, input({ positionClosed: true }));
    assert.equal(done.runtime.state, 'DONE');
    const path = done.runtime.transitions.map((t) => t.to);
    assert.deepEqual(path, ['FORMING', 'WAIT_RETRACE', 'ARM', 'WORKING', 'DONE']);
    for (const t of done.runtime.transitions) {
      assert.match(t.tsUk, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+01:00$/);
      assert.equal(t.price, 2650.2);
      assert.equal(typeof t.reason === 'string' || t.reason === null, true);
    }
    const arm = done.runtime.transitions.find((t) => t.to === 'ARM');
    assert.equal(arm?.reason, 'LIVE_OFF');
    assert.equal(arm?.from, 'WAIT_RETRACE');
  });

  it('arms with btc alignment off and does not block on a holiday warning', () => {
    const off = stepPair(initialRuntime('ETHUSDT'), input({}, { btcAligned: false }));
    const on = stepPair(initialRuntime('SOLUSDT'), input({}, { btcAligned: true }));
    assert.equal(off.runtime.state, 'WORKING');
    assert.equal(on.runtime.state, 'WORKING');
    const holiday = stepPair(
      initialRuntime('ETHUSDT'),
      input({ holidayName: 'Christmas Day' }, { holiday: true }),
    );
    assert.equal(holiday.runtime.state, 'WORKING');
    assert.equal(holiday.holidayPing, 'HOLIDAY Christmas Day — detection continues');
    assert.ok(holiday.runtime.warnings.includes('HOLIDAY'));
  });

  it('enters SPIT, NEED_DEEPER, EXPIRED, and BLOCKED for the hard rejects', () => {
    const fake = stepPair(initialRuntime('ETHUSDT'), input({}, { neckOk: false }));
    assert.equal(fake.runtime.state, 'SPIT');
    assert.equal(fake.runtime.reason, 'FAKE_NECK');

    const noFvg = stepPair(initialRuntime('ETHUSDT'), input({}, { hasFvg: false }));
    assert.equal(noFvg.runtime.reason, 'NO_FVG');

    const chase = stepPair(initialRuntime('ETHUSDT'), input({}, { chase: true }));
    assert.equal(chase.runtime.reason, 'CHASE');

    const fat = stepPair(initialRuntime('ETHUSDT'), input({}, { fatStop: true, tagged: false }));
    assert.equal(fat.runtime.state, 'NEED_DEEPER');
    assert.equal(fat.runtime.reason, 'FAT_STOP');

    const deep = stepPair(fat.runtime, input({}, { fatStop: true, deeperReached: true, tagged: false }));
    assert.equal(deep.runtime.state, 'WORKING');

    const expired = stepPair(initialRuntime('ETHUSDT'), input({}, { invalidated: true }));
    assert.equal(expired.runtime.state, 'EXPIRED');

    const kill = stepPair(initialRuntime('ETHUSDT'), input({}, { dailyKill: true }));
    assert.equal(kill.runtime.state, 'BLOCKED');
    assert.equal(kill.runtime.reason, 'DAILY_KILL');

    const venue = stepPair(initialRuntime('ETHUSDT'), input({}, { venueHealthy: false }));
    assert.equal(venue.runtime.reason, 'VENUE_UNHEALTHY');

    const stale = stepPair(initialRuntime('ETHUSDT'), input({}, { stale: true }));
    assert.equal(stale.runtime.state, 'WAIT_RETRACE');
    assert.equal(stale.runtime.reason, 'STALE_DATA');
    assert.equal(stale.order, null);
  });

  it('allows one arm per pair per day and rejects a second tag on the same box', () => {
    const first = stepPair(initialRuntime('SOLUSDT'), input());
    assert.equal(first.runtime.armsToday, 1);
    const closed = stepPair(first.runtime, input({ positionClosed: true }));
    const again = stepPair(closed.runtime, input());
    assert.equal(again.runtime.state, 'SPIT');
    assert.equal(again.runtime.reason, 'SECOND_ON_SAME_BOX');

    const other = stepPair(closed.runtime, input({}, { boxId: 'long:2', side: 'short' }));
    assert.equal(other.runtime.reason, 'ALREADY_USED');

    const nextDay = stepPair(
      other.runtime,
      input({ nowMs: Date.parse('2026-09-25T07:00:00.500Z') }, { boxId: 'long:3' }),
    );
    assert.equal(nextDay.runtime.state, 'WORKING');
    assert.equal(nextDay.runtime.armsToday, 1);
  });
});
