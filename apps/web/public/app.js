const COLORS = {
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

const tilesEl = document.querySelector('#tiles');
const detailEl = document.querySelector('#detail');
const chart = document.querySelector('#chart');
const btChart = document.querySelector('#bt-chart');
let snapshot = null;
let selected = null;
let backtest = null;
let selectedTrade = null;

function money(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('en-GB', { maximumFractionDigits: 4 });
}

function gbp(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${Number(n).toFixed(2)}`;
}

function zoneText(zone) {
  if (!zone) return '—';
  return `${money(zone.low)} – ${money(zone.high)}`;
}

function ukTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/London', hour12: false });
}

async function refresh() {
  const res = await fetch('/api/state');
  snapshot = await res.json();
  render();
}

async function load() {
  await refresh();
  await loadBacktest();
}

async function loadBacktest() {
  const res = await fetch('/api/backtest');
  backtest = await res.json();
  renderBacktest();
}

function render() {
  document.querySelector('#clock').textContent = snapshot.clockUk;
  const feed = snapshot.feed === 'market' ? 'MEXC feed' : 'synthetic';
  document.querySelector('#venue').textContent = `${snapshot.activeVenue} · ${feed} · window ${snapshot.window}`;
  const badge = document.querySelector('#armed');
  badge.textContent = snapshot.liveArmed ? 'LIVE_ARMED' : 'LIVE_ARMED off';
  badge.className = snapshot.liveArmed ? 'badge on' : 'badge off';
  const toggle = document.querySelector('#live-toggle');
  toggle.textContent = snapshot.liveArmed ? 'Stop live fires' : 'Start live fires';
  toggle.className = snapshot.liveArmed ? 'armed' : '';
  if (snapshot.message) document.querySelector('#live-note').textContent = snapshot.message;
  const holiday = document.querySelector('#holiday');
  if (snapshot.holiday?.active) {
    holiday.hidden = false;
    holiday.textContent = `Holiday warning: ${snapshot.holiday.name}. Detection continues. Exchange fire still requires the live button.`;
  } else {
    holiday.hidden = true;
  }
  tilesEl.innerHTML = '';
  for (const pair of snapshot.pairs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tile';
    btn.dataset.pair = pair.pair;
    btn.dataset.state = pair.state;
    btn.setAttribute('aria-pressed', String(selected === pair.pair));
    btn.innerHTML = `
      <h3>${pair.pair}</h3>
      <dl>
        <dt>State</dt><dd class="state">${pair.state}${pair.reason ? ` · ${pair.reason}` : ''}</dd>
        <dt>Zone</dt><dd>${zoneText(pair.zone)}</dd>
        <dt>SL</dt><dd>${money(pair.sl)}</dd>
        <dt>TP</dt><dd>${money(pair.tp)}</dd>
        <dt>BTC aligned</dt><dd>${pair.btcAligned ? 'YES' : 'NO'}</dd>
        <dt>Last ping</dt><dd>${pair.lastPing ? escapeHtml(pair.lastPing.split('\n')[0]) : '—'}</dd>
      </dl>`;
    btn.addEventListener('click', () => openPair(pair.pair));
    tilesEl.appendChild(btn);
  }
  renderReview();
  if (selected) paint(snapshot.pairs.find((p) => p.pair === selected));
}

function renderReview() {
  const rows = snapshot.pairs
    .map(
      (p) =>
        `<tr><td>${p.pair}</td><td>${p.review}</td><td>${p.state}</td><td>${p.btcAligned ? 'yes' : 'no'}</td></tr>`,
    )
    .join('');
  document.querySelector('#review').innerHTML = `<table><thead><tr><th>Pair</th><th>Review</th><th>State</th><th>btc_aligned</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderBacktest() {
  const range = document.querySelector('#bt-range');
  const summary = document.querySelector('#bt-summary');
  const pairs = document.querySelector('#bt-pairs');
  const table = document.querySelector('#bt-table');
  if (!backtest?.ready) {
    range.textContent = '';
    summary.innerHTML = '';
    pairs.innerHTML = '';
    table.innerHTML = `<p class="muted">${escapeHtml(backtest?.message || 'No backtest yet.')}</p>`;
    return;
  }
  range.textContent = `${backtest.from} → ${backtest.to}`;
  const rate = backtest.winRate == null ? '—' : `${(backtest.winRate * 100).toFixed(1)}%`;
  summary.innerHTML = [
    ['Wins', String(backtest.wins), 'win'],
    ['Losses', String(backtest.losses), 'loss'],
    ['Win rate', rate, ''],
    ['Net paper GBP', gbp(backtest.netPnlGbp), backtest.netPnlGbp >= 0 ? 'win' : 'loss'],
    ['Misses', String(backtest.misses), ''],
  ]
    .map(([label, value, cls]) => `<div class="stat"><span>${label}</span><b class="${cls}">${value}</b></div>`)
    .join('');
  const pairRows = Object.entries(backtest.byPair || {})
    .map(([pair, row]) => `<tr><td>${pair}</td><td class="win">${row.wins}</td><td class="loss">${row.losses}</td><td>${row.misses}</td><td>${gbp(row.netPnlGbp)}</td></tr>`)
    .join('');
  pairs.innerHTML = `<table><thead><tr><th>Pair</th><th>Wins</th><th>Losses</th><th>Misses</th><th>Net</th></tr></thead><tbody>${pairRows}</tbody></table>`;
  const trades = [...(backtest.trades || [])].reverse();
  const body = trades
    .map((trade) => {
      const cls = trade.outcome === 'WIN' ? 'win' : trade.outcome === 'LOSS' ? 'loss' : '';
      return `<tr class="click" data-id="${escapeHtml(trade.id)}" aria-pressed="${selectedTrade === trade.id}"><td>${trade.pair}</td><td>${trade.side}</td><td class="${cls}">${trade.outcome}</td><td>${money(trade.entry)}</td><td>${money(trade.sl)}</td><td>${money(trade.tp)}</td><td>${gbp(trade.pnlGbp)}</td><td>${ukTime(trade.entryTime)}</td></tr>`;
    })
    .join('');
  table.innerHTML = `<table><thead><tr><th>Pair</th><th>Side</th><th>Result</th><th>Entry</th><th>SL</th><th>TP</th><th>PnL</th><th>Signal (UK)</th></tr></thead><tbody>${body}</tbody></table>`;
  table.querySelectorAll('tr.click').forEach((row) => {
    row.addEventListener('click', () => openTrade(row.dataset.id));
  });
  if (selectedTrade) paintTrade(backtest.trades.find((t) => t.id === selectedTrade));
}

function openPair(pair) {
  selected = pair;
  detailEl.hidden = false;
  render();
  requestAnimationFrame(() => {
    const current = snapshot.pairs.find((p) => p.pair === pair);
    paint(current);
    detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function openTrade(id) {
  selectedTrade = id;
  const trade = backtest.trades.find((t) => t.id === id);
  document.querySelector('#bt-detail').hidden = false;
  renderBacktest();
  requestAnimationFrame(() => paintTrade(trade));
}

function paint(pair) {
  if (!pair) return;
  document.querySelector('#detail-title').textContent = `${pair.pair} · ${pair.timeframe} · ${pair.state}`;
  document.querySelector('#stamp').textContent = pair.stamp;
  document.querySelector('#ping').textContent = pair.lastPing ?? '';
  drawChart(chart, { candles: pair.candles, levels: pair.levels, marks: pair.marks });
}

function paintTrade(trade) {
  if (!trade) return;
  document.querySelector('#bt-title').textContent = `${trade.pair} ${trade.side} ${trade.outcome} · entry ${money(trade.entry)} · ${gbp(trade.pnlGbp)}`;
  drawChart(btChart, { candles: trade.candles, levels: [], marks: trade.marks });
}

function drawChart(canvas, view) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 960;
  const height = 420;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const candles = view.candles ?? [];
  const marks = view.marks ?? [];
  const levels = view.levels ?? [];
  if (!candles.length) return;
  const prices = [];
  for (const c of candles) prices.push(c.high, c.low);
  for (const level of levels) {
    if (level.price != null) prices.push(level.price);
    if (level.low != null) prices.push(level.low, level.high);
  }
  for (const mark of marks) {
    prices.push(mark.price);
    if (mark.price2 != null) prices.push(mark.price2);
  }
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  const pad = (max - min) * 0.12 || 1;
  min -= pad;
  max += pad;
  const yOf = (price) => 20 + ((max - price) / (max - min)) * (height - 40);
  const slot = width / candles.length;
  const marked = new Set(marks.map((m) => m.label));

  for (const level of levels) {
    if (level.low == null || level.high == null) continue;
    if (marked.has(level.label)) continue;
    ctx.fillStyle = hexAlpha(COLORS[level.color] ?? '#fff', 0.16);
    const top = yOf(level.high);
    const bot = yOf(level.low);
    ctx.fillRect(0, top, width, Math.max(2, bot - top));
  }

  for (const mark of marks) {
    if (mark.price2 == null) continue;
    const x1 = mark.fromIndex * slot;
    const x2 = (Math.min(mark.toIndex, candles.length - 1) + 1) * slot;
    ctx.fillStyle = hexAlpha(COLORS[mark.color] ?? '#c084fc', 0.22);
    const top = yOf(Math.max(mark.price, mark.price2));
    const bot = yOf(Math.min(mark.price, mark.price2));
    ctx.fillRect(x1, top, Math.max(2, x2 - x1), Math.max(2, bot - top));
  }

  candles.forEach((c, i) => {
    const x = i * slot + slot / 2;
    const up = c.close >= c.open;
    ctx.strokeStyle = up ? '#4ade80' : '#f87171';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yOf(c.high));
    ctx.lineTo(x, yOf(c.low));
    ctx.stroke();
    const top = yOf(Math.max(c.open, c.close));
    const bot = yOf(Math.min(c.open, c.close));
    ctx.fillRect(x - Math.max(2, slot * 0.28), top, Math.max(4, slot * 0.56), Math.max(1, bot - top));
  });

  ctx.font = '12px ui-monospace, monospace';
  ctx.lineWidth = 1.5;
  for (const level of levels) {
    if (level.price == null) continue;
    if (!level.dashed && marked.has(level.label)) continue;
    strokeLevel(ctx, 0, width - 8, yOf(level.price), level.color, level.dashed);
    ctx.fillStyle = COLORS[level.color] ?? '#fff';
    ctx.fillText(level.label, 8, yOf(level.price) - 3);
  }
  for (const mark of marks) {
    if (mark.price2 != null) {
      const x2 = (Math.min(mark.toIndex, candles.length - 1) + 1) * slot;
      ctx.fillStyle = COLORS[mark.color] ?? '#fff';
      ctx.fillText(mark.label, Math.max(4, mark.fromIndex * slot), yOf(Math.max(mark.price, mark.price2)) - 3);
      continue;
    }
    const x1 = Math.max(0, mark.fromIndex) * slot;
    const x2 = (Math.min(mark.toIndex, candles.length - 1) + 1) * slot;
    if (mark.kind === 'MSS' || mark.kind === 'BOS') {
      const x = mark.fromIndex * slot + slot / 2;
      const y = yOf(mark.price);
      ctx.fillStyle = COLORS[mark.color] ?? '#fff';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(mark.label, x + 6, y - 6);
      continue;
    }
    strokeLevel(ctx, x1, x2, yOf(mark.price), mark.color, false);
    ctx.fillStyle = COLORS[mark.color] ?? '#fff';
    ctx.fillText(mark.label, Math.min(width - 48, Math.max(4, x2 - 44)), yOf(mark.price) - 3);
  }
}

function strokeLevel(ctx, x1, x2, y, color, dashed) {
  ctx.strokeStyle = COLORS[color] ?? '#fff';
  ctx.setLineDash(dashed ? [4, 4] : []);
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function hexAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function applyPayload(data) {
  if (data?.state?.pairs) snapshot = data.state;
  else if (data?.pairs) snapshot = data;
  if (data?.message) document.querySelector('#live-note').textContent = data.message;
  if (data?.error) document.querySelector('#live-note').textContent = data.error;
  render();
}

document.querySelector('#close-detail').addEventListener('click', () => {
  selected = null;
  detailEl.hidden = true;
  render();
});

document.querySelector('#export').addEventListener('click', async () => {
  const res = await fetch('/api/review');
  const data = await res.json();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'choke-night-review.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

document.querySelector('#replay').addEventListener('click', async () => {
  const res = await fetch('/api/replay', { method: 'POST' });
  const data = await res.json();
  applyPayload(data);
});

document.querySelector('#tape').addEventListener('click', async () => {
  const res = await fetch('/api/tape', { method: 'POST' });
  applyPayload(await res.json());
});

document.querySelector('#kill').addEventListener('click', async () => {
  const ok = window.confirm('Cancel working limits, record a reduce-only flatten intent, and mute all three pairs for today?');
  if (!ok) return;
  const res = await fetch('/api/kill', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'FLATTEN' }),
  });
  applyPayload(await res.json());
});

document.querySelector('#live-toggle').addEventListener('click', async () => {
  const armed = Boolean(snapshot?.liveArmed);
  if (!armed) {
    const ok = window.confirm('Send LIMIT orders with stop and target to your MEXC account when a fresh 5m setup arms? Nothing is sent until you confirm.');
    if (!ok) return;
    const res = await fetch('/api/live/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'START_LIVE' }),
    });
    applyPayload(await res.json());
    return;
  }
  const ok = window.confirm('Stop live fires and cancel working MEXC limits?');
  if (!ok) return;
  const res = await fetch('/api/live/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'STOP_LIVE' }),
  });
  applyPayload(await res.json());
});

load();
setInterval(() => {
  void refresh();
}, 2000);
