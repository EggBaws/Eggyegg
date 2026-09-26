import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const chartSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public/chart.js'), 'utf8');

function harness() {
  const texts: string[] = [];
  const placed: Array<{ text: string; x: number }> = [];
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
    scale: 1,
    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        width: canvas.clientWidth * canvas.scale,
        height: canvas.clientHeight * canvas.scale,
      };
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
        fillText(text: string, x = 0) {
          texts.push(String(text));
          placed.push({ text: String(text), x });
        },
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
        arc() {},
        fill() {},
        setLineDash() {},
        save() {},
        restore() {},
        rect() {},
        clip() {},
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
    placed,
    bodies,
    flush() {
      const pending = queue.splice(0);
      for (const fn of pending) fn();
    },
    wheel(deltaY: number, x = 450, y = 260, extra: Record<string, unknown> = {}) {
      listeners.wheel[0]({ preventDefault() {}, deltaY, clientX: x, clientY: y, ...extra });
    },
    pan(fromX: number, toX: number, fromY = 260, toY = fromY) {
      listeners.pointerdown[0]({ pointerId: 1, clientX: fromX, clientY: fromY });
      listeners.pointermove[0]({ pointerId: 1, clientX: toX, clientY: toY });
      listeners.pointerup[0]({ pointerId: 1, clientX: toX, clientY: toY });
    },
    dbl(x: number, y = 260) {
      listeners.dblclick[0]({ clientX: x, clientY: y });
    },
    clear() {
      texts.length = 0;
      placed.length = 0;
      bodies.length = 0;
    },
  };
}

function gridPrices(ui: { clear(): void; wheel(deltaY: number, x?: number, y?: number): void; texts: string[] }) {
  ui.clear();
  ui.wheel(0, 120, 200);
  const nums = ui.texts
    .map((text) => Number(String(text).replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
  return nums.slice(0, 5);
}

function gridSpread(ui: { clear(): void; wheel(deltaY: number, x?: number, y?: number): void; texts: string[] }) {
  const grid = gridPrices(ui);
  return Math.max(...grid) - Math.min(...grid);
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
    for (let i = 0; i < 40; i++) ui.pan(700, 20);
    ui.clear();
    ui.pan(700, 20);
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

  it('scales price from the right-hand scale and keeps that scale on refresh', () => {
    const ui = harness();
    ui.chart.setSeries(candles(80), [], 300_000);
    const fitted = gridSpread(ui);
    for (let i = 0; i < 8; i++) ui.wheel(-120, 870, 200);
    const zoomed = gridSpread(ui);
    assert.ok(zoomed < fitted * 0.6);
    assert.equal(ui.texts.includes('Waiting for candles'), false);
    assert.ok(ui.bodies.length >= 1);

    ui.pan(870, 870, 360, 40);
    const dragged = gridSpread(ui);
    assert.ok(dragged < zoomed);

    ui.clear();
    ui.chart.setSeries(candles(80), [], 300_000);
    const kept = gridSpread(ui);
    assert.ok(Math.abs(kept - dragged) / dragged < 0.05);

    ui.dbl(870, 200);
    const reset = gridSpread(ui);
    assert.ok(reset > dragged * 2);
  });

  it('hits the price column when the page is scaled, and does not jump back to the newest bars', () => {
    const ui = harness();
    ui.chart.setSeries(candles(80), [], 300_000);
    const fitted = gridSpread(ui);
    ui.canvas.scale = 0.5;
    for (let i = 0; i < 6; i++) ui.wheel(-120, 430, 120);
    ui.canvas.scale = 1;
    const zoomed = gridSpread(ui);
    assert.ok(zoomed < fitted * 0.75);
    assert.equal(ui.texts.includes('Waiting for candles'), false);

    const older = candles(80);
    ui.chart.setSeries(older, [], 300_000);
    ui.chart.fit();
    for (let i = 0; i < 8; i++) ui.pan(80, 640);
    const parked = gridPrices(ui);
    const parkedMid = (Math.max(...parked) + Math.min(...parked)) / 2;
    const jumped = older.concat(candles(40).map((candle, i) => ({ ...candle, time: candle.time + 80 * 300_000, open: 5000 + i, high: 5010 + i, low: 4990 + i, close: 5005 + i })));
    ui.chart.setSeries(jumped, [], 300_000);
    const stayed = gridPrices(ui);
    const stayedMid = (Math.max(...stayed) + Math.min(...stayed)) / 2;
    assert.ok(Math.abs(stayedMid - parkedMid) < 30);
    assert.ok(stayedMid < 1000);
  });

  it('prints a date once along the bottom and leaves the clocks readable', () => {
    const ui = harness();
    ui.canvas.clientWidth = 390;
    ui.canvas.clientHeight = 640;
    ui.chart.setSeries(candles(80), [], 300_000);
    const axis = ui.placed.filter((mark) => /\d{2}:\d{2}/.test(mark.text));
    const dated = axis.filter((mark) => /[A-Za-z]/.test(mark.text));
    assert.equal(dated.length, 1);
    assert.ok(axis.length >= 2);
    for (let i = 1; i < axis.length; i++) {
      const prev = axis[i - 1];
      assert.ok(axis[i].x >= prev.x + prev.text.length * 6);
    }
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
