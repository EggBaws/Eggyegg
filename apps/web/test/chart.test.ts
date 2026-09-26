import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const chartSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public/chart.js'), 'utf8');

function harness() {
  const texts: string[] = [];
  const bodies: string[] = [];
  const queue: Array<() => void> = [];
  const listeners: Record<string, Array<(event: Record<string, unknown>) => void>> = {};
  const canvas = {
    clientWidth: 900,
    clientHeight: 520,
    width: 0,
    height: 0,
    addEventListener(type: string, fn: (event: Record<string, unknown>) => void) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener() {},
    setPointerCapture() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: canvas.clientWidth, height: canvas.clientHeight };
    },
    getContext() {
      const ctx = {
        fillStyle: '',
        strokeStyle: '',
        font: '',
        lineWidth: 1,
        setTransform() {},
        clearRect() {},
        fillRect() {
          if (ctx.fillStyle === '#4ade80' || ctx.fillStyle === '#f87171') bodies.push(ctx.fillStyle);
        },
        fillText(text: string) {
          texts.push(String(text));
        },
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
        arc() {},
        fill() {},
        setLineDash() {},
        measureText(text: string) {
          return { width: String(text).length * 6 };
        },
      };
      return ctx;
    },
  };
  const sandbox = {
    window: { devicePixelRatio: 1 },
    requestAnimationFrame(fn: () => void) {
      queue.push(fn);
    },
    ResizeObserver: class {
      observe() {}
    },
    canvas,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${chartSrc}\nthis.chart = mountChart(canvas);`, sandbox);
  const chart = (sandbox as { chart: {
    setSeries(candles: unknown[], marks: unknown[], barMs: number): void;
    setTimeframe(mult: number): void;
    frameSetup(): void;
    fit(): void;
  } }).chart;
  return {
    chart,
    canvas,
    texts,
    bodies,
    flush() {
      const pending = queue.splice(0);
      for (const fn of pending) fn();
    },
    wheel(deltaY: number, x = 450) {
      listeners.wheel[0]({ preventDefault() {}, deltaY, clientX: x, clientY: 260 });
    },
    pan(fromX: number, toX: number) {
      listeners.pointerdown[0]({ pointerId: 1, clientX: fromX, clientY: 260 });
      listeners.pointermove[0]({ pointerId: 1, clientX: toX, clientY: 260 });
      listeners.pointerup[0]({ pointerId: 1, clientX: toX, clientY: 260 });
    },
    clear() {
      texts.length = 0;
      bodies.length = 0;
    },
  };
}

function candles(n: number) {
  const start = Date.parse('2026-09-01T00:00:00Z');
  const rows = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price + (i % 2 === 0 ? 1.2 : -0.8);
    rows.push({
      time: start + i * 300_000,
      open,
      high: Math.max(open, close) + 0.4,
      low: Math.min(open, close) - 0.4,
      close,
    });
    price = close;
  }
  return rows;
}

describe('chart viewport', () => {
  it('draws candles and keeps some of them in view when looking ahead', () => {
    const ui = harness();
    ui.chart.setSeries(candles(160), [], 300_000);
    assert.equal(ui.texts.includes('Waiting for candles'), false);
    assert.ok(ui.bodies.length > 10);

    for (let i = 0; i < 40; i++) ui.wheel(-100);
    for (let i = 0; i < 40; i++) ui.pan(860, 20);
    ui.clear();
    ui.pan(860, 20);
    assert.equal(ui.texts.includes('Waiting for candles'), false);
    assert.ok(ui.bodies.length >= 1);

    ui.clear();
    ui.chart.setSeries(candles(160), [], 300_000);
    assert.equal(ui.texts.includes('Waiting for candles'), false);
    assert.ok(ui.bodies.length >= 1);

    for (const mult of [3, 12, 48]) {
      ui.clear();
      ui.chart.setTimeframe(mult);
      assert.equal(ui.texts.includes('Waiting for candles'), false);
      assert.ok(ui.bodies.length >= 1);
    }
  });

  it('frames a trade that has candles', () => {
    const ui = harness();
    const rows = candles(90);
    ui.chart.setSeries(rows, [{ kind: 'ENTRY', label: 'ENTRY', price: rows[40].close, fromIndex: 40, toIndex: 40, color: 'green' }], 300_000);
    ui.chart.frameSetup();
    assert.equal(ui.texts.includes('Waiting for candles'), false);
    assert.ok(ui.bodies.length >= 1);
    assert.ok(ui.texts.includes('ENTRY'));
  });

  it('says waiting only when the series itself is empty', () => {
    const ui = harness();
    ui.chart.setSeries([], [], 300_000);
    assert.ok(ui.texts.includes('Waiting for candles'));
    ui.clear();
    ui.chart.setSeries(candles(30), [], 300_000);
    assert.equal(ui.texts.includes('Waiting for candles'), false);
    assert.ok(ui.bodies.length >= 1);
  });

  it('paints once the canvas has a size', () => {
    const ui = harness();
    ui.canvas.clientWidth = 0;
    ui.canvas.clientHeight = 0;
    ui.chart.setSeries(candles(40), [], 300_000);
    assert.equal(ui.texts.includes('Waiting for candles'), false);
    assert.equal(ui.bodies.length, 0);
    ui.canvas.clientWidth = 900;
    ui.canvas.clientHeight = 520;
    ui.flush();
    assert.equal(ui.texts.includes('Waiting for candles'), false);
    assert.ok(ui.bodies.length >= 1);
  });
});
