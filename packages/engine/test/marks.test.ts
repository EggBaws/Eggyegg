import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectStructure } from '../src/candles.ts';
import { buildChartMarks } from '../src/marks.ts';
import { ethLongCandles, ethNowMs, ETH_T0 } from '../src/synthetic.ts';
import { ukMidnightMs } from '../src/time.ts';

describe('chart marks', () => {
  it('places FVG, BOS, MSS, entry, TP, and SL on the ETH fixture', () => {
    const candles = ethLongCandles();
    const structure = detectStructure(candles, 0.01, ukMidnightMs(ethNowMs(ETH_T0)), '5m');
    assert.equal(structure.side, 'long');
    assert.ok(structure.smash);
    assert.ok(structure.neck && structure.neck.line < candles[structure.smash.index].close);
    const marks = buildChartMarks({
      candles,
      structure,
      entry: 2650,
      sl: 2641.99,
      tp: 2679.68,
      neck: structure.neck?.line ?? null,
    });
    const fvg = marks.find((m) => m.kind === 'FVG');
    const mss = marks.find((m) => m.kind === 'MSS');
    const bos = marks.find((m) => m.kind === 'BOS');
    assert.equal(fvg?.price, 2650);
    assert.equal(fvg?.price2, 2654);
    assert.equal(fvg?.fromIndex, (structure.fvg?.index ?? 2) - 2);
    assert.equal(mss?.fromIndex, structure.smash?.index);
    assert.equal(bos?.fromIndex, structure.smash?.index);
    assert.equal(bos?.price, 2668);
    assert.equal(marks.find((m) => m.kind === 'ENTRY')?.price, 2650);
    assert.equal(marks.find((m) => m.kind === 'SL')?.price, 2641.99);
    assert.equal(marks.find((m) => m.kind === 'TP')?.price, 2679.68);
    const entry = marks.find((m) => m.kind === 'ENTRY');
    assert.equal(entry?.fromIndex, (structure.smash?.index ?? 0) + 1);
  });
});
