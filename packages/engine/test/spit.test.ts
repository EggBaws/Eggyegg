import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide, type DecideInput } from '../src/decide.ts';
import { SPIT, SPIT_CODES, isBlockingSpit } from '../src/spit.ts';

const here = dirname(fileURLToPath(import.meta.url));

function ready(over: Partial<DecideInput> = {}): DecideInput {
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
    alreadyUsed: false,
    secondOnSameBox: false,
    venueHealthy: true,
    liveArmed: false,
    dailyKill: false,
    stale: false,
    holiday: false,
    btcAligned: false,
    displacementWithoutSweep: false,
    fillsAtCap: false,
    ...over,
  };
}

describe('SPIT codes', () => {
  it('lists every spec code and does not include OUT_OF_WINDOW', () => {
    assert.deepEqual(SPIT_CODES, [
      'HOLIDAY',
      'FAKE_NECK',
      'NO_FVG',
      'NO_SWEEP',
      'CHASE',
      'FAT_STOP',
      'NEED_DEEPER',
      'ALREADY_USED',
      'SECOND_ON_SAME_BOX',
      'VENUE_UNHEALTHY',
      'LIVE_OFF',
      'DAILY_KILL',
    ]);
    assert.equal(isBlockingSpit(SPIT.HOLIDAY), false);
    assert.equal(isBlockingSpit(SPIT.LIVE_OFF), false);
    assert.equal(isBlockingSpit(SPIT.FAKE_NECK), true);
    assert.equal(isBlockingSpit(SPIT.CHASE), true);
  });

  it('maps each blocking code to a state and leaves holiday and btc alignment out of the decision', () => {
    assert.equal(decide(ready()).reason, SPIT.LIVE_OFF);
    assert.equal(decide(ready()).fire, true);
    assert.equal(decide(ready({ liveArmed: true })).reason, null);
    assert.deepEqual(decide(ready({ holiday: true, btcAligned: false })), decide(ready({ holiday: false, btcAligned: true })));
    assert.equal(decide(ready({ neckOk: false })).reason, SPIT.FAKE_NECK);
    assert.equal(decide(ready({ hasFvg: false })).reason, SPIT.NO_FVG);
    assert.equal(decide(ready({ hasSweep: false, hasSmash: false, hasFvg: false, neckEvaluated: false, displacementWithoutSweep: true })).reason, SPIT.NO_SWEEP);
    assert.equal(decide(ready({ chase: true })).reason, SPIT.CHASE);
    assert.equal(decide(ready({ fatStop: true, deeperReached: false })).reason, SPIT.FAT_STOP);
    assert.equal(decide(ready({ fatStop: true, deeperReached: false })).state, 'NEED_DEEPER');
    assert.equal(decide(ready({ alreadyUsed: true })).reason, SPIT.ALREADY_USED);
    assert.equal(decide(ready({ secondOnSameBox: true, alreadyUsed: true })).reason, SPIT.SECOND_ON_SAME_BOX);
    assert.equal(decide(ready({ venueHealthy: false })).reason, SPIT.VENUE_UNHEALTHY);
    assert.equal(decide(ready({ dailyKill: true })).reason, SPIT.DAILY_KILL);
    assert.equal(decide(ready()).state, 'ARM');
  });

  it('does not mention a clock kill in the structure or decision sources', () => {
    const srcDir = join(here, '../src');
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
    const blob = files.map((f) => readFileSync(join(srcDir, f), 'utf8')).join('\n');
    assert.equal(blob.includes('OUT_OF_WINDOW'), false);
    assert.equal(blob.includes('openai'), false);
    assert.equal(blob.includes('fetch('), false);
  });
});
