import { SPIT } from './spit.ts';
import type { State } from './types.ts';

export interface DecideInput {
  hasSweep: boolean;
  hasSmash: boolean;
  hasFvg: boolean;
  neckEvaluated: boolean;
  neckOk: boolean;
  invalidated: boolean;
  tagged: boolean;
  chase: boolean;
  fatStop: boolean;
  deeperReached: boolean;
  alreadyUsed: boolean;
  secondOnSameBox: boolean;
  venueHealthy: boolean;
  liveArmed: boolean;
  dailyKill: boolean;
  stale: boolean;
  /** Warn-only. Must not change the returned state. */
  holiday: boolean;
  /** Display-only. Must not change the returned state. */
  btcAligned: boolean;
  displacementWithoutSweep: boolean;
  fillsAtCap: boolean;
  /** Two trades are already open. The setup can arm when one closes. */
  slotsFull: boolean;
  /** Balance scaling is on and there is no usable margin. */
  noSize: boolean;
}

export interface Decision {
  state: State;
  reason: string | null;
  fire: boolean;
}

/**
 * Pure next-state for one pair. No clock gate: window_start / window_end are ignored.
 * btcAligned and holiday are accepted so callers cannot "forget" them — they are unused on purpose.
 */
export function decide(input: DecideInput): Decision {
  void input.holiday;
  void input.btcAligned;

  if (!input.hasSweep) {
    if (input.displacementWithoutSweep) return { state: 'SPIT', reason: SPIT.NO_SWEEP, fire: false };
    return { state: 'FLAT', reason: null, fire: false };
  }
  if (input.neckEvaluated && !input.neckOk) {
    return { state: 'SPIT', reason: SPIT.FAKE_NECK, fire: false };
  }
  if (!input.hasSmash || !input.neckEvaluated) {
    return { state: 'FORMING', reason: null, fire: false };
  }
  if (!input.hasFvg) return { state: 'SPIT', reason: SPIT.NO_FVG, fire: false };
  if (input.invalidated) return { state: 'EXPIRED', reason: 'INVALIDATED', fire: false };
  if (input.secondOnSameBox) return { state: 'SPIT', reason: SPIT.SECOND_ON_SAME_BOX, fire: false };
  if (input.alreadyUsed) return { state: 'SPIT', reason: SPIT.ALREADY_USED, fire: false };
  if (input.chase) return { state: 'SPIT', reason: SPIT.CHASE, fire: false };
  if (input.fatStop && !input.deeperReached) {
    return { state: 'NEED_DEEPER', reason: SPIT.FAT_STOP, fire: false };
  }
  const tagged = input.tagged || (input.fatStop && input.deeperReached);
  if (!tagged) return { state: 'WAIT_RETRACE', reason: null, fire: false };
  if (input.dailyKill) return { state: 'BLOCKED', reason: SPIT.DAILY_KILL, fire: false };
  if (input.fillsAtCap) return { state: 'BLOCKED', reason: 'MAX_FILLS', fire: false };
  if (!input.venueHealthy) return { state: 'BLOCKED', reason: SPIT.VENUE_UNHEALTHY, fire: false };
  if (input.stale) return { state: 'WAIT_RETRACE', reason: 'STALE_DATA', fire: false };
  if (input.slotsFull) return { state: 'WAIT_RETRACE', reason: 'SLOTS_FULL', fire: false };
  if (input.noSize) return { state: 'WAIT_RETRACE', reason: 'NO_BALANCE', fire: false };
  return {
    state: 'ARM',
    reason: input.liveArmed ? null : SPIT.LIVE_OFF,
    fire: true,
  };
}
