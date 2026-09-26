import { decide, type DecideInput } from './decide.ts';
import { ukDateKey, ukStamp } from './time.ts';
import type { OrderDraft, PairId, Side, State, TransitionLog } from './types.ts';

const PING_STATES = new Set<State>(['FORMING', 'ARM', 'NEED_DEEPER', 'DONE', 'EXPIRED', 'SPIT']);

export interface PairRuntime {
  pair: PairId;
  state: State;
  reason: string | null;
  side: Side | null;
  boxId: string | null;
  consumed: boolean;
  armDay: string | null;
  armsToday: number;
  /** Sweep open times already armed today. A later choke can still arm. */
  usedSweepMs: number[];
  transitions: TransitionLog[];
  order: OrderDraft | null;
  warnings: string[];
  holidayWarned: boolean;
  muted: boolean;
  lastPing: string | null;
}

export interface SetupFacts {
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
  displacementWithoutSweep: boolean;
  venueHealthy: boolean;
  liveArmed: boolean;
  dailyKill: boolean;
  stale: boolean;
  holiday: boolean;
  btcAligned: boolean;
  fillsAtCap: boolean;
  slotsFull: boolean;
  noSize: boolean;
  boxId: string | null;
  side: Side | null;
}

export interface StepInput {
  nowMs: number;
  lastPrice: number;
  maxArmsPerPairPerDay: number;
  holidayName: string | null;
  setup: SetupFacts;
  draft: OrderDraft | null;
  positionClosed: boolean;
  armPingBody: string | null;
}

export interface StepResult {
  runtime: PairRuntime;
  order: OrderDraft | null;
  cancel: boolean;
  entered: State[];
  holidayPing: string | null;
}

export function initialRuntime(pair: PairId): PairRuntime {
  return {
    pair,
    state: 'FLAT',
    reason: null,
    side: null,
    boxId: null,
    consumed: false,
    armDay: null,
    armsToday: 0,
    usedSweepMs: [],
    transitions: [],
    order: null,
    warnings: [],
    holidayWarned: false,
    muted: false,
    lastPing: null,
  };
}

export function stepPair(runtime: PairRuntime, input: StepInput): StepResult {
  let rt = rollDay(runtime, input.nowMs);
  const entered: State[] = [];
  let holidayPing: string | null = null;

  if (input.holidayName && !rt.holidayWarned) {
    const body = `HOLIDAY ${input.holidayName} — detection continues`;
    rt = {
      ...rt,
      holidayWarned: true,
      warnings: rt.warnings.includes('HOLIDAY') ? rt.warnings : [...rt.warnings, 'HOLIDAY'],
      lastPing: body,
    };
    holidayPing = body;
  }

  if (rt.state === 'WORKING') {
    if (input.positionClosed) {
      rt = move(rt, 'DONE', 'CLOSED', input, entered, `${rt.pair} DONE`);
      return { runtime: rt, order: null, cancel: false, entered, holidayPing };
    }
    if (input.setup.invalidated && input.setup.boxId === rt.boxId) {
      rt = move(rt, 'EXPIRED', 'INVALIDATED', input, entered, `${rt.pair} EXPIRED INVALIDATED`);
      return { runtime: rt, order: null, cancel: true, entered, holidayPing };
    }
    return { runtime: rt, order: null, cancel: false, entered, holidayPing };
  }

  if (rt.muted) {
    rt = move(rt, 'BLOCKED', 'KILL', input, entered, null);
    return { runtime: rt, order: null, cancel: false, entered, holidayPing };
  }

  if (input.setup.boxId && rt.boxId && input.setup.boxId !== rt.boxId) {
    if (rt.state !== 'FLAT') rt = move(rt, 'FLAT', 'NEW_BOX', input, entered, null);
    rt = { ...rt, consumed: false };
  }

  const alreadyUsed = rt.armsToday >= input.maxArmsPerPairPerDay;
  const secondOnSameBox = rt.consumed && rt.boxId != null && rt.boxId === input.setup.boxId;
  const decisionInput: DecideInput = {
    hasSweep: input.setup.hasSweep,
    hasSmash: input.setup.hasSmash,
    hasFvg: input.setup.hasFvg,
    neckEvaluated: input.setup.neckEvaluated,
    neckOk: input.setup.neckOk,
    invalidated: input.setup.invalidated,
    tagged: input.setup.tagged,
    chase: input.setup.chase,
    fatStop: input.setup.fatStop,
    deeperReached: input.setup.deeperReached,
    alreadyUsed,
    secondOnSameBox,
    venueHealthy: input.setup.venueHealthy,
    liveArmed: input.setup.liveArmed,
    dailyKill: input.setup.dailyKill,
    stale: input.setup.stale,
    holiday: input.setup.holiday,
    btcAligned: input.setup.btcAligned,
    displacementWithoutSweep: input.setup.displacementWithoutSweep,
    fillsAtCap: input.setup.fillsAtCap,
    slotsFull: input.setup.slotsFull,
    noSize: input.setup.noSize,
  };
  const decision = decide(decisionInput);

  if (input.setup.side) rt = { ...rt, side: input.setup.side };
  if (input.setup.boxId) rt = { ...rt, boxId: input.setup.boxId };

  if (decision.fire) {
    if (!input.draft) {
      rt = move(rt, 'WAIT_RETRACE', 'NO_DRAFT', input, entered, null);
      return { runtime: rt, order: null, cancel: false, entered, holidayPing };
    }
    const armBody = input.armPingBody ?? `${rt.pair} ARM`;
    rt = move(rt, 'ARM', decision.reason, input, entered, armBody);
    rt = move(rt, 'WORKING', decision.reason, input, entered, null);
    const sweepMs = sweepMsOf(input.setup.boxId);
    rt = {
      ...rt,
      consumed: true,
      armsToday: rt.armsToday + 1,
      usedSweepMs: sweepMs == null ? rt.usedSweepMs : [...rt.usedSweepMs, sweepMs],
      order: input.draft,
      side: input.setup.side,
      boxId: input.setup.boxId,
    };
    return { runtime: rt, order: input.draft, cancel: false, entered, holidayPing };
  }

  const pingBody = pingFor(rt.pair, decision.state, decision.reason, input.lastPrice);
  rt = move(rt, decision.state, decision.reason, input, entered, pingBody);
  return { runtime: rt, order: null, cancel: false, entered, holidayPing };
}

export function muteRuntime(runtime: PairRuntime, nowMs: number, lastPrice: number): StepResult {
  const entered: State[] = [];
  const input: StepInput = {
    nowMs,
    lastPrice,
    maxArmsPerPairPerDay: 1,
    holidayName: null,
    setup: emptySetup(),
    draft: null,
    positionClosed: false,
    armPingBody: null,
  };
  let rt = { ...runtime, muted: true };
  const cancel = rt.state === 'WORKING';
  rt = move(rt, 'BLOCKED', 'KILL', input, entered, `${rt.pair} KILL mute today`);
  return { runtime: rt, order: null, cancel, entered, holidayPing: null };
}

function sweepMsOf(boxId: string | null): number | null {
  if (!boxId) return null;
  const n = Number(boxId.slice(boxId.indexOf(':') + 1));
  return Number.isFinite(n) ? n : null;
}

function rollDay(runtime: PairRuntime, nowMs: number): PairRuntime {
  const day = ukDateKey(nowMs);
  if (runtime.armDay === day) return runtime;
  let rt: PairRuntime = {
    ...runtime,
    armDay: day,
    armsToday: 0,
    usedSweepMs: [],
    muted: false,
    holidayWarned: false,
  };
  if (rt.state === 'BLOCKED' && (rt.reason === 'KILL' || rt.reason === 'DAILY_KILL' || rt.reason === 'MAX_FILLS')) {
    rt = { ...rt, state: 'FLAT', reason: null, consumed: false };
  }
  return rt;
}

function move(
  runtime: PairRuntime,
  to: State,
  reason: string | null,
  input: StepInput,
  entered: State[],
  pingBody: string | null,
): PairRuntime {
  if (runtime.state === to && runtime.reason === reason) return runtime;
  const log: TransitionLog = {
    pair: runtime.pair,
    from: runtime.state,
    to,
    tsUk: ukStamp(input.nowMs),
    tsMs: input.nowMs,
    price: input.lastPrice,
    reason,
  };
  entered.push(to);
  const lastPing = pingBody && PING_STATES.has(to) ? pingBody : runtime.lastPing;
  return {
    ...runtime,
    state: to,
    reason,
    transitions: [...runtime.transitions, log],
    lastPing,
  };
}

function pingFor(pair: PairId, state: State, reason: string | null, price: number): string | null {
  if (state === 'FORMING') return `${pair} FORMING`;
  if (state === 'NEED_DEEPER') return `${pair} NEED_DEEPER ${reason ?? ''} @ ${price}`;
  if (state === 'EXPIRED') return `${pair} EXPIRED ${reason ?? ''}`;
  if (state === 'SPIT') return `${pair} SPIT ${reason ?? ''}`;
  if (state === 'DONE') return `${pair} DONE`;
  return null;
}

function emptySetup(): SetupFacts {
  return {
    hasSweep: false,
    hasSmash: false,
    hasFvg: false,
    neckEvaluated: false,
    neckOk: false,
    invalidated: false,
    tagged: false,
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
    slotsFull: false,
    noSize: false,
    boxId: null,
    side: null,
  };
}
