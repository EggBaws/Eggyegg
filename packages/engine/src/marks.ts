import type { Candle, Side, Structure } from './types.ts';

export interface ChartMark {
  kind: 'FVG' | 'BOS' | 'MSS' | 'ENTRY' | 'TP' | 'SL' | 'SWEEP' | 'NECK' | 'LOCK';
  label: string;
  color: string;
  fromIndex: number;
  toIndex: number;
  price: number;
  price2?: number;
}

export interface MarkInput {
  candles: Candle[];
  structure: Structure;
  entry: number | null;
  sl: number | null;
  /** 1.33% price. The stop moves here once it trades. */
  lock: number | null;
  tp: number | null;
  neck: number | null;
}

/**
 * Chart labels for the same events the engine already computed.
 * MSS is the smash candle (close back through the sweep body).
 * BOS is that same displacement when it also closes through the neck.
 * The engine only treats the smash as complete when that BOS close prints.
 */
export function buildChartMarks(input: MarkInput): ChartMark[] {
  const { candles, structure } = input;
  const last = Math.max(0, candles.length - 1);
  const marks: ChartMark[] = [];
  const side: Side | null = structure.side;

  if (structure.sweep) {
    marks.push({
      kind: 'SWEEP',
      label: 'sweep',
      color: 'orange',
      fromIndex: structure.sweep.index,
      toIndex: last,
      price: structure.sweep.price,
    });
  }
  if (input.neck != null && structure.sweep) {
    marks.push({
      kind: 'NECK',
      label: 'neck',
      color: 'white',
      fromIndex: structure.sweep.index,
      toIndex: structure.smash?.index ?? last,
      price: input.neck,
    });
  }
  if (structure.fvg) {
    const from = Math.max(0, structure.fvg.index - 2);
    marks.push({
      kind: 'FVG',
      label: 'FVG',
      color: 'purple',
      fromIndex: from,
      toIndex: last,
      price: structure.fvg.lower,
      price2: structure.fvg.upper,
    });
  }
  if (structure.smash && side) {
    const candle = candles[structure.smash.index];
    if (candle) {
      const mssPrice = side === 'long' ? candle.high : candle.low;
      marks.push({
        kind: 'MSS',
        label: 'MSS',
        color: 'amber',
        fromIndex: structure.smash.index,
        toIndex: structure.smash.index,
        price: mssPrice,
      });
      const brokeNeck =
        input.neck != null &&
        (side === 'long' ? candle.close > input.neck : candle.close < input.neck);
      if (brokeNeck) {
        marks.push({
          kind: 'BOS',
          label: 'BOS',
          color: 'sky',
          fromIndex: structure.smash.index,
          toIndex: structure.smash.index,
          price: candle.close,
        });
      }
    }
  }
  const fromEntry = structure.smash ? structure.smash.index + 1 : 0;
  if (input.entry != null) {
    marks.push({
      kind: 'ENTRY',
      label: 'ENTRY',
      color: 'green',
      fromIndex: Math.min(fromEntry, last),
      toIndex: last,
      price: input.entry,
    });
  }
  if (input.sl != null) {
    marks.push({
      kind: 'SL',
      label: 'SL',
      color: 'red',
      fromIndex: Math.min(fromEntry, last),
      toIndex: last,
      price: input.sl,
    });
  }
  if (input.lock != null) {
    marks.push({
      kind: 'LOCK',
      label: 'lock',
      color: 'gold',
      fromIndex: Math.min(fromEntry, last),
      toIndex: last,
      price: input.lock,
    });
  }
  if (input.tp != null) {
    marks.push({
      kind: 'TP',
      label: 'TP',
      color: 'blue',
      fromIndex: Math.min(fromEntry, last),
      toIndex: last,
      price: input.tp,
    });
  }
  return marks;
}
