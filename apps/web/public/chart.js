const CHART_COLORS = {
  orange: '#f59e0b',
  white: '#f8fafc',
  purple: '#c084fc',
  green: '#4ade80',
  red: '#f87171',
  blue: '#60a5fa',
  grey: '#94a3b8',
  amber: '#fbbf24',
  sky: '#38bdf8',
};

function mountChart(canvas) {
  const view = {
    source: [],
    marks: [],
    barMs: 300_000,
    mult: 1,
    agg: [],
    drawn: [],
    start: 0,
    count: 80,
    stick: true,
    cross: null,
    drag: null,
    pinch: null,
  };
  const pointers = new Map();

  function aggregate(candles, mult) {
    if (mult <= 1) return candles.map((c) => ({ ...c }));
    const step = view.barMs * mult;
    const out = [];
    for (const candle of candles) {
      const bucket = Math.floor(candle.time / step) * step;
      const last = out[out.length - 1];
      if (!last || last.time !== bucket) {
        out.push({ time: bucket, open: candle.open, high: candle.high, low: candle.low, close: candle.close });
      } else {
        last.high = Math.max(last.high, candle.high);
        last.low = Math.min(last.low, candle.low);
        last.close = candle.close;
      }
    }
    return out;
  }

  function mapMarks(agg) {
    const step = view.barMs * view.mult;
    const mapped = [];
    for (const mark of view.marks) {
      const left = view.source[Math.max(0, Math.min(view.source.length - 1, mark.fromIndex))];
      const right = view.source[Math.max(0, Math.min(view.source.length - 1, mark.toIndex))];
      if (!left || !right || !agg.length) continue;
      const t0 = left.time;
      const t1 = right.time + view.barMs;
      let from = 0;
      let to = agg.length - 1;
      for (let i = 0; i < agg.length; i++) {
        if (agg[i].time + step > t0) {
          from = i;
          break;
        }
      }
      for (let i = agg.length - 1; i >= 0; i--) {
        if (agg[i].time < t1) {
          to = i;
          break;
        }
      }
      mapped.push({ ...mark, fromIndex: from, toIndex: Math.max(from, to) });
    }
    return mapped;
  }

  function pinLive() {
    view.count = Math.max(4, Math.min(view.count || 80, view.agg.length));
    view.start = Math.max(0, view.agg.length - view.count);
  }

  function rebuild(keepTime) {
    const prev = keepTime && !view.stick ? span() : null;
    view.agg = aggregate(view.source, view.mult);
    view.drawn = mapMarks(view.agg);
    if (!view.agg.length) return;
    if (!prev) pinLive();
    else applySpan(prev);
  }

  function barStep() {
    return (view.barMs || 300_000) * (view.mult || 1);
  }

  function span() {
    if (!view.agg.length) return null;
    const step = barStep();
    const n = view.agg.length;
    const i0 = Math.max(0, Math.min(n - 1, Math.floor(view.start)));
    const i1 = Math.max(i0, Math.min(n - 1, Math.ceil(view.start + view.count) - 1));
    return {
      from: view.agg[i0].time,
      to: view.agg[i1].time + step,
      aheadMs: Math.max(0, view.start + view.count - n) * step,
    };
  }

  function applySpan(range) {
    const step = barStep();
    let from = 0;
    let to = view.agg.length - 1;
    for (let i = 0; i < view.agg.length; i++) {
      if (view.agg[i].time >= range.from - step / 2) {
        from = i;
        break;
      }
    }
    for (let i = view.agg.length - 1; i >= 0; i--) {
      if (view.agg[i].time < range.to) {
        to = i;
        break;
      }
    }
    view.start = from;
    view.count = Math.max(4, to - from + 1);
    if (range.aheadMs > step / 2) view.start += range.aheadMs / step;
    clamp();
  }

  function clamp() {
    const n = view.agg.length;
    if (!n) return;
    view.count = Math.max(4, Math.min(n, view.count));
    const ahead = Math.min(96, Math.max(12, view.count * 0.75));
    if (view.start < 0) view.start = 0;
    const maxStart = Math.max(0, n + ahead - view.count);
    if (view.start > maxStart) view.start = maxStart;
    const pin = Math.max(0, n - view.count);
    view.stick = Math.abs(view.start - pin) < 0.8;
  }

  function plotBox() {
    const width = canvas.clientWidth || 960;
    const height = canvas.clientHeight || 480;
    return { width, height, left: 8, right: width - 72, top: 12, bottom: height - 28 };
  }

  function slice() {
    const from = Math.max(0, Math.floor(view.start));
    const to = Math.min(view.agg.length, Math.ceil(view.start + view.count));
    return view.agg.slice(from, to);
  }

  function draw() {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const box = plotBox();
    canvas.width = Math.floor(box.width * dpr);
    canvas.height = Math.floor(box.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    ctx.fillStyle = '#0c100c';
    ctx.fillRect(0, 0, box.width, box.height);
    const rows = slice();
    if (!rows.length) {
      ctx.fillStyle = '#9aab90';
      ctx.font = '13px ui-monospace, monospace';
      ctx.fillText('Waiting for candles', 16, 28);
      return;
    }
    const prices = [];
    for (const candle of rows) prices.push(candle.high, candle.low);
    const from = Math.floor(view.start);
    for (const mark of view.drawn) {
      if (mark.toIndex < from || mark.fromIndex > from + rows.length) continue;
      prices.push(mark.price);
      if (mark.price2 != null) prices.push(mark.price2);
    }
    let min = Math.min(...prices);
    let max = Math.max(...prices);
    const pad = (max - min) * 0.08 || Math.abs(max) * 0.002 || 1;
    min -= pad;
    max += pad;
    const yOf = (price) => box.top + ((max - price) / (max - min)) * (box.bottom - box.top);
    const slot = (box.right - box.left) / view.count;
    const xOf = (index) => box.left + (index - view.start) * slot;

    ctx.font = '11px ui-monospace, monospace';
    ctx.strokeStyle = '#243024';
    ctx.fillStyle = '#9aab90';
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const price = max - ((max - min) * i) / 4;
      const y = yOf(price);
      ctx.beginPath();
      ctx.moveTo(box.left, y);
      ctx.lineTo(box.right, y);
      ctx.stroke();
      ctx.fillText(fmtPrice(price), box.right + 6, y + 4);
    }

    for (const mark of view.drawn) {
      if (mark.price2 == null) continue;
      const x1 = xOf(mark.fromIndex);
      const x2 = xOf(mark.toIndex + 1);
      ctx.fillStyle = hexAlpha(CHART_COLORS[mark.color] ?? '#c084fc', 0.18);
      const top = yOf(Math.max(mark.price, mark.price2));
      const bot = yOf(Math.min(mark.price, mark.price2));
      ctx.fillRect(x1, top, Math.max(2, x2 - x1), Math.max(2, bot - top));
    }

    rows.forEach((candle, i) => {
      const index = from + i;
      const x = xOf(index) + slot / 2;
      const up = candle.close >= candle.open;
      ctx.strokeStyle = up ? '#4ade80' : '#f87171';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(x, yOf(candle.high));
      ctx.lineTo(x, yOf(candle.low));
      ctx.stroke();
      const top = yOf(Math.max(candle.open, candle.close));
      const bot = yOf(Math.min(candle.open, candle.close));
      const body = Math.max(3, slot * 0.62);
      ctx.fillRect(x - body / 2, top, body, Math.max(1, bot - top));
    });

    for (const mark of view.drawn) {
      if (mark.price2 != null) {
        ctx.fillStyle = CHART_COLORS[mark.color] ?? '#fff';
        ctx.fillText(mark.label, Math.max(box.left, xOf(mark.fromIndex) + 4), yOf(Math.max(mark.price, mark.price2)) - 4);
        continue;
      }
      if (mark.kind === 'MSS' || mark.kind === 'BOS') {
        const x = xOf(mark.fromIndex) + slot / 2;
        const y = yOf(mark.price);
        ctx.fillStyle = CHART_COLORS[mark.color] ?? '#fff';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(mark.label, x + 6, y - 6);
        continue;
      }
      const x1 = xOf(mark.fromIndex);
      const endIndex = mark.toIndex >= view.agg.length - 1 ? view.start + view.count : mark.toIndex + 1;
      const x2 = xOf(endIndex);
      const y = yOf(mark.price);
      ctx.strokeStyle = CHART_COLORS[mark.color] ?? '#fff';
      ctx.setLineDash(mark.kind === 'NECK' ? [3, 3] : []);
      ctx.beginPath();
      ctx.moveTo(Math.max(box.left, x1), y);
      ctx.lineTo(Math.min(box.right, x2), y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(mark.label, Math.max(box.left + 4, Math.min(box.right - 36, x2 - 36)), y - 4);
    }

    const step = Math.max(1, Math.round(view.count / 6));
    const last = view.agg[view.agg.length - 1];
    const future = barStep();
    for (let index = Math.floor(view.start / step) * step; index < view.start + view.count; index += step) {
      if (index < 0) continue;
      const x = xOf(index);
      if (x < box.left - 8 || x > box.right - 8) continue;
      const time = index < view.agg.length ? view.agg[index].time : last.time + (index - (view.agg.length - 1)) * future;
      ctx.fillStyle = '#9aab90';
      ctx.fillText(fmtTime(time), x, box.bottom + 16);
    }

    if (view.cross) {
      const { x, y } = view.cross;
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
        ctx.strokeStyle = '#9aab90';
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(x, box.top);
        ctx.lineTo(x, box.bottom);
        ctx.moveTo(box.left, y);
        ctx.lineTo(box.right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        const price = max - ((y - box.top) / (box.bottom - box.top)) * (max - min);
        const index = Math.floor(view.start + (x - box.left) / slot);
        const candle = index >= 0 && index < view.agg.length ? view.agg[index] : null;
        ctx.fillStyle = '#1a2118';
        ctx.fillRect(box.right, y - 8, 68, 16);
        ctx.fillStyle = '#e7f0df';
        ctx.fillText(fmtPrice(price), box.right + 4, y + 4);
        const when = candle
          ? candle.time
          : view.agg.length
            ? view.agg[view.agg.length - 1].time + (index - (view.agg.length - 1)) * barStep()
            : 0;
        const label = candle
          ? `${fmtTime(candle.time)}  O ${fmtPrice(candle.open)}  H ${fmtPrice(candle.high)}  L ${fmtPrice(candle.low)}  C ${fmtPrice(candle.close)}`
          : `${fmtTime(when)}  ahead`;
        ctx.fillStyle = '#1a2118';
        ctx.fillRect(box.left, 0, ctx.measureText(label).width + 10, 16);
        ctx.fillStyle = '#e7f0df';
        ctx.fillText(label, box.left + 4, 12);
      }
    }
  }

  function localPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (!view.agg.length) return;
    const box = plotBox();
    const point = localPoint(event);
    const slot = (box.right - box.left) / view.count;
    const anchor = view.start + (point.x - box.left) / slot;
    const factor = event.deltaY > 0 ? 1.15 : 1 / 1.15;
    view.count *= factor;
    view.start = anchor - (point.x - box.left) / ((box.right - box.left) / view.count);
    view.stick = false;
    clamp();
    draw();
  }, { passive: false });

  function pinchSpan() {
    const pts = [...pointers.values()];
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.hypot(dx, dy);
  }

  function beginPinch() {
    if (!view.agg.length || pointers.size < 2) return;
    view.drag = null;
    const pts = [...pointers.values()];
    const rect = canvas.getBoundingClientRect();
    const localX = (pts[0].x + pts[1].x) / 2 - rect.left;
    const box = plotBox();
    const slot = (box.right - box.left) / view.count;
    view.pinch = {
      dist: pinchSpan(),
      count: view.count,
      anchor: view.start + (localX - box.left) / slot,
      localX,
    };
  }

  canvas.addEventListener('pointerdown', (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.setPointerCapture(event.pointerId);
    if (pointers.size >= 2) beginPinch();
    else view.drag = { x: event.clientX, start: view.start };
  });
  canvas.addEventListener('pointermove', (event) => {
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (view.pinch && pointers.size >= 2) {
      const dist = pinchSpan();
      if (view.pinch.dist > 8 && dist > 8) {
        const box = plotBox();
        view.count = view.pinch.count * (view.pinch.dist / dist);
        const slot = (box.right - box.left) / view.count;
        view.start = view.pinch.anchor - (view.pinch.localX - box.left) / slot;
        view.stick = false;
        clamp();
      }
      view.cross = null;
      draw();
      return;
    }
    if (view.drag && pointers.size === 1) {
      const box = plotBox();
      const slot = (box.right - box.left) / view.count;
      view.start = view.drag.start - (event.clientX - view.drag.x) / slot;
      view.stick = false;
      clamp();
    }
    view.cross = localPoint(event);
    draw();
  });
  function endPointer(event) {
    pointers.delete(event.pointerId);
    view.pinch = null;
    view.drag = null;
    if (pointers.size === 1) {
      const left = [...pointers.values()][0];
      view.drag = { x: left.x, start: view.start };
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', (event) => {
    if (pointers.has(event.pointerId)) endPointer(event);
    view.cross = null;
    draw();
  });
  canvas.addEventListener('dblclick', () => fit());

  const observer = new ResizeObserver(() => draw());
  observer.observe(canvas);

  function fit() {
    view.stick = true;
    view.count = Math.min(120, view.agg.length || 120);
    view.start = Math.max(0, view.agg.length - view.count);
    clamp();
    draw();
  }

  function frameSetup() {
    view.stick = false;
    const n = view.agg.length;
    if (!n) return;
    view.count = Math.min(72, n);
    const entry = view.drawn.find((mark) => mark.kind === 'ENTRY');
    const idx = entry ? entry.fromIndex : Math.round(n * 0.4);
    view.start = idx - view.count * 0.32;
    clamp();
    draw();
  }

  return {
    setSeries(candles, marks, barMs) {
      const follow = view.stick;
      view.source = candles ?? [];
      view.marks = marks ?? [];
      view.barMs = barMs || 300_000;
      view.stick = follow;
      rebuild(true);
      draw();
    },
    setTimeframe(mult) {
      const prev = view.stick ? null : span();
      view.mult = mult;
      view.agg = aggregate(view.source, view.mult);
      view.drawn = mapMarks(view.agg);
      if (view.agg.length) {
        if (!prev) pinLive();
        else applySpan(prev);
      }
      draw();
    },
    fit,
    frameSetup,
    label() {
      return view.mult === 1 ? '5m' : view.mult === 3 ? '15m' : view.mult === 12 ? '1h' : '4h';
    },
  };
}

function fmtPrice(price) {
  const abs = Math.abs(price);
  const digits = abs >= 1000 ? 2 : abs >= 10 ? 3 : 4;
  return Number(price).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtTime(ms) {
  return new Date(ms).toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function hexAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
