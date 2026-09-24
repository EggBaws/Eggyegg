const COLORS = {
  orange: '#f59e0b',
  white: '#f8fafc',
  purple: '#c084fc',
  green: '#4ade80',
  red: '#f87171',
  blue: '#60a5fa',
  grey: '#94a3b8',
};

const tilesEl = document.querySelector('#tiles');
const detailEl = document.querySelector('#detail');
const chart = document.querySelector('#chart');
let snapshot = null;
let selected = null;

function money(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('en-GB', { maximumFractionDigits: 4 });
}

function zoneText(zone) {
  if (!zone) return '—';
  return `${money(zone.low)} – ${money(zone.high)}`;
}

async function load() {
  const res = await fetch('/api/state');
  snapshot = await res.json();
  render();
}

function render() {
  document.querySelector('#clock').textContent = snapshot.clockUk;
  document.querySelector('#venue').textContent = `${snapshot.activeVenue} · window ${snapshot.window}`;
  const badge = document.querySelector('#armed');
  badge.textContent = snapshot.liveArmed ? 'LIVE_ARMED' : 'LIVE_ARMED off';
  badge.className = snapshot.liveArmed ? 'badge on' : 'badge off';
  const holiday = document.querySelector('#holiday');
  if (snapshot.holiday?.active) {
    holiday.hidden = false;
    holiday.textContent = `Holiday warning: ${snapshot.holiday.name}. Detection continues. Exchange fire still requires LIVE_ARMED.`;
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

function paint(pair) {
  if (!pair) return;
  document.querySelector('#detail-title').textContent = `${pair.pair} · ${pair.timeframe} · ${pair.state}`;
  document.querySelector('#stamp').textContent = pair.stamp;
  document.querySelector('#ping').textContent = pair.lastPing ?? '';
  const ctx = chart.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const width = chart.clientWidth || 960;
  const height = 420;
  chart.width = Math.floor(width * dpr);
  chart.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const candles = pair.candles ?? [];
  if (!candles.length) return;
  const prices = [];
  for (const c of candles) prices.push(c.high, c.low);
  for (const level of pair.levels ?? []) {
    if (level.price != null) prices.push(level.price);
    if (level.low != null) prices.push(level.low, level.high);
  }
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  const pad = (max - min) * 0.1 || 1;
  min -= pad;
  max += pad;
  const yOf = (price) => 16 + ((max - price) / (max - min)) * (height - 32);
  const slot = width / candles.length;

  for (const level of pair.levels ?? []) {
    if (level.low == null || level.high == null) continue;
    ctx.fillStyle = hexAlpha(COLORS[level.color] ?? '#fff', 0.18);
    const top = yOf(level.high);
    const bot = yOf(level.low);
    ctx.fillRect(0, top, width, Math.max(2, bot - top));
  }

  candles.forEach((c, i) => {
    const x = i * slot + slot / 2;
    const up = c.close >= c.open;
    ctx.strokeStyle = up ? '#4ade80' : '#f87171';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(x, yOf(c.high));
    ctx.lineTo(x, yOf(c.low));
    ctx.stroke();
    const top = yOf(Math.max(c.open, c.close));
    const bot = yOf(Math.min(c.open, c.close));
    ctx.fillRect(x - 3, top, 6, Math.max(1, bot - top));
  });

  ctx.font = '12px ui-monospace, monospace';
  for (const level of pair.levels ?? []) {
    if (level.price == null) continue;
    ctx.strokeStyle = COLORS[level.color] ?? '#fff';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.setLineDash(level.dashed ? [4, 4] : []);
    ctx.beginPath();
    const y = yOf(level.price);
    ctx.moveTo(0, y);
    ctx.lineTo(width - 72, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText(level.label, width - 68, y - 2);
  }
}

function hexAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
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
  snapshot = await res.json();
  render();
});

document.querySelector('#kill').addEventListener('click', async () => {
  const ok = window.confirm('Cancel working limits, record a reduce-only flatten intent, and mute all three pairs for today?');
  if (!ok) return;
  const res = await fetch('/api/kill', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'FLATTEN' }),
  });
  snapshot = await res.json();
  render();
});

load();
