const tilesEl = document.querySelector('#tiles');
const liveChart = mountChart(document.querySelector('#live-canvas'));
const tradeChart = mountChart(document.querySelector('#bt-chart'));
let snapshot = null;
let livePair = 'BTCUSDT';
let liveTf = 1;
let liveChartTicket = 0;
let backtest = null;
let selectedTrade = null;
let viewRev = 0;
let quiet = false;
let pollTimer = 0;
let loginPoll = 0;
let loginPopup = null;
let tabHold = null;

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (typeof url === 'string' && url.startsWith('/api/')) {
    const headers = new Headers(init.headers || {});
    try {
      const session = sessionStorage.getItem('chokeSession');
      if (session && !headers.has('x-choke-session')) headers.set('x-choke-session', session);
    } catch {
      /* private mode */
    }
    init = { ...init, headers, credentials: init.credentials || 'same-origin' };
  }
  return nativeFetch(input, init);
};

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

function stopPoll() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = 0;
}

function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void refresh();
  }, 2000);
}

async function refresh() {
  const res = await fetch('/api/state');
  if (res.status === 401) {
    showGate();
    return;
  }
  if (!res.ok) return;
  snapshot = await res.json();
  applyRemoteView(snapshot.view);
  render();
  await loadLiveChart();
}

async function load() {
  await refresh();
  await loadBacktest();
  await loadKeys();
  if (selectedTrade) showTrade(selectedTrade, false);
}

async function loadBacktest() {
  const res = await fetch('/api/backtest');
  if (res.status === 401) {
    showGate();
    return;
  }
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
  const balance = document.querySelector('#balance');
  if (balance) {
    if (snapshot.balanceUsdt != null && snapshot.tradeStakeUsdt != null) {
      const open = snapshot.openTrades ?? 0;
      const slots = snapshot.balanceSlots ?? 2;
      balance.textContent = `Balance ${Number(snapshot.balanceUsdt).toFixed(2)} USDT. Next trade about ${Number(snapshot.tradeStakeUsdt).toFixed(2)} USDT margin. ${open} of ${slots} open.`;
    }
  }
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
    btn.setAttribute('aria-pressed', String(livePair === pair.pair));
    btn.innerHTML = `
      <h3>${pair.pair}</h3>
      <dl>
        <dt>State</dt><dd class="state">${pair.state}${pair.reason ? ` · ${pair.reason}` : ''}</dd>
        <dt>Zone</dt><dd>${zoneText(pair.zone)}</dd>
        <dt>SL</dt><dd>${money(pair.sl)}${pair.locked ? ' locked' : ''}</dd>
        <dt>Lock</dt><dd>${money(pair.lock)}</dd>
        <dt>TP</dt><dd>${money(pair.tp)}</dd>
        <dt>BTC aligned</dt><dd>${pair.btcAligned ? 'YES' : 'NO'}</dd>
        <dt>Last ping</dt><dd>${pair.lastPing ? escapeHtml(pair.lastPing.split('\n')[0]) : '—'}</dd>
      </dl>`;
    btn.addEventListener('click', () => selectLive(pair.pair));
    tilesEl.appendChild(btn);
  }
  renderReview();
  const pairBox = document.querySelector('#live-pairs');
  pairBox.innerHTML = '';
  for (const pair of snapshot.pairs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = pair.pair.replace(/USDT$/, '');
    btn.setAttribute('aria-pressed', String(livePair === pair.pair));
    btn.addEventListener('click', () => selectLive(pair.pair));
    pairBox.appendChild(btn);
  }
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
}

function selectLive(pair) {
  livePair = pair;
  render();
  document.querySelector('#live-chart').scrollIntoView({ behavior: 'smooth', block: 'start' });
  publishView();
  void loadLiveChart();
}

async function loadLiveChart() {
  const pair = livePair;
  const ticket = ++liveChartTicket;
  const res = await fetch(`/api/chart?pair=${encodeURIComponent(pair)}`);
  if (ticket !== liveChartTicket || pair !== livePair) return;
  if (res.status === 401) {
    showGate();
    return;
  }
  if (!res.ok) return;
  const data = await res.json();
  if (ticket !== liveChartTicket || pair !== livePair || (data.pair && data.pair !== pair)) return;
  const candles = Array.isArray(data.candles) ? data.candles : [];
  if (!candles.length) return;
  liveChart.setSeries(candles, Array.isArray(data.marks) ? data.marks : [], data.barMs);
  document.querySelector('#live-title').textContent = `${data.pair} · ${liveChart.label()} · ${data.state}`;
  const order = document.querySelector('#live-order');
  if (data.entry != null) {
    const side = data.side === 'short' ? 'sell' : 'buy';
    const sent = data.liveArmed ? 'armed LIMIT for MEXC' : 'LIVE off — this LIMIT is not sent';
    const lock = data.lock != null ? ` · lock ${money(data.lock)}` : '';
    order.textContent = `${side} ${money(data.entry)} · SL ${money(data.sl)}${data.locked ? ' locked' : ''}${lock} · TP ${money(data.tp)} · ${sent}`;
  } else {
    order.textContent = 'No entry yet. Sweep, FVG, MSS, and BOS paint as they form. Nothing is sent until live fires are on.';
  }
  document.querySelector('#stamp').textContent = data.stamp || '';
}

function showTrade(id, scroll) {
  selectedTrade = id;
  const panel = document.querySelector('#bt-detail');
  if (!id) {
    panel.hidden = true;
    if (backtest) renderBacktest();
    return;
  }
  const trade = backtest?.trades?.find((t) => t.id === id);
  if (!trade) return;
  panel.hidden = false;
  renderBacktest();
  document.querySelector('#bt-title').textContent = `${trade.pair} ${trade.side} ${trade.outcome} · ${ukTime(trade.entryTime)} · entry ${money(trade.entry)} · ${gbp(trade.pnlGbp)}`;
  const candles = Array.isArray(trade.candles) ? trade.candles : [];
  if (!candles.length) return;
  tradeChart.setSeries(candles, Array.isArray(trade.marks) ? trade.marks : [], 300_000);
  tradeChart.setTimeframe(liveTf);
  tradeChart.frameSetup();
  if (scroll) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openTrade(id) {
  showTrade(id, true);
  publishView();
}

function pressTf(root, mult) {
  for (const item of root.querySelectorAll('button')) {
    item.setAttribute('aria-pressed', String(Number(item.dataset.tf) === mult));
  }
}

function setTimeframe(mult, publish) {
  liveTf = mult;
  liveChart.setTimeframe(mult);
  tradeChart.setTimeframe(mult);
  pressTf(document.querySelector('#live-tfs'), mult);
  pressTf(document.querySelector('#bt-tfs'), mult);
  const title = document.querySelector('#live-title');
  if (title.textContent.includes('·')) title.textContent = title.textContent.replace(/· \S+ ·/, `· ${liveChart.label()} ·`);
  if (publish) publishView();
}

function applyRemoteView(view) {
  if (!view || view.rev === viewRev) return;
  viewRev = view.rev;
  quiet = true;
  const pairChanged = view.pair && view.pair !== livePair;
  if (view.pair) livePair = view.pair;
  if (view.timeframe && view.timeframe !== liveTf) setTimeframe(view.timeframe, false);
  const nextTrade = view.tradeId ?? null;
  const tradeChanged = nextTrade !== selectedTrade;
  if (tradeChanged) showTrade(nextTrade, false);
  quiet = false;
  if (pairChanged && snapshot) render();
}

function publishView() {
  if (quiet) return;
  void fetch('/api/session/view', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pair: livePair, timeframe: liveTf, tradeId: selectedTrade }),
  }).then(async (res) => {
    if (res.status === 401) {
      showGate();
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    if (data.view && data.view.rev >= viewRev) viewRev = data.view.rev;
  });
}

function bindTimeframes(root) {
  root.addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn?.dataset.tf) return;
    setTimeframe(Number(btn.dataset.tf), true);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function applyPayload(data) {
  if (data?.state?.pairs) snapshot = data.state;
  else if (data?.pairs) snapshot = data;
  if (snapshot?.view) applyRemoteView(snapshot.view);
  if (data?.message) document.querySelector('#live-note').textContent = data.message;
  if (data?.error) document.querySelector('#live-note').textContent = data.error;
  render();
  void loadLiveChart();
}

function showDesk(email) {
  clearLoginMark();
  releaseTab();
  document.body.classList.remove('locked');
  document.querySelector('#desk').hidden = false;
  const account = document.querySelector('#account');
  account.textContent = `${email} · this Google account stays in sync across screens`;
  startPoll();
  void load();
}

function loginTicket() {
  try {
    return sessionStorage.getItem('chokeLoginTicket') || '';
  } catch {
    return '';
  }
}

function loginStarted() {
  return Boolean(loginTicket());
}

function markLogin(ticket) {
  try {
    sessionStorage.setItem('chokeLoginTicket', ticket);
  } catch {
    /* private mode still polls while this page stays open */
  }
}

function clearLoginMark() {
  try {
    sessionStorage.removeItem('chokeLoginTicket');
  } catch {
    /* ignore */
  }
}

function holdTabOpen() {
  releaseTab();
  const hold = {};
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.00001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    hold.ctx = ctx;
    hold.osc = osc;
  } catch {
    /* a quiet tab can still poll on this machine */
  }
  try {
    const pending = navigator.wakeLock?.request('screen');
    if (pending) pending.then((lock) => {
      hold.lock = lock;
    }).catch(() => {});
  } catch {
    /* ignore */
  }
  tabHold = hold;
}

function releaseTab() {
  const hold = tabHold;
  tabHold = null;
  try {
    hold?.osc?.stop();
  } catch {
    /* already stopped */
  }
  try {
    void hold?.ctx?.close();
  } catch {
    /* ignore */
  }
  try {
    void hold?.lock?.release();
  } catch {
    /* ignore */
  }
}

function closeLoginPopup() {
  const popup = loginPopup;
  loginPopup = null;
  try {
    if (popup && popup !== window && !popup.closed) popup.close();
  } catch {
    /* the sign-in window already went away */
  }
}

function stopLoginPoll() {
  if (!loginPoll) return;
  clearInterval(loginPoll);
  loginPoll = 0;
}

async function pollOnce() {
  const res = await fetch('/api/auth/poll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: loginTicket() }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.email && data.session) {
    try {
      sessionStorage.setItem('chokeSession', data.session);
    } catch {
      /* the desk request still carries the cookie when the host keeps it */
    }
    stopLoginPoll();
    closeLoginPopup();
    showDesk(data.email);
    return 'desk';
  }
  if (data.pending) return 'pending';
  if (res.status === 401 && data.error) {
    stopLoginPoll();
    clearLoginMark();
    releaseTab();
    document.querySelector('#gate-note').textContent = data.error;
    return 'error';
  }
  return 'idle';
}

function startLoginPoll(intervalSec, immediate) {
  stopLoginPoll();
  const wait = Math.max(2, Number(intervalSec) || 5) * 1000;
  const tick = async () => {
    const state = await pollOnce();
    if (state === 'pending') {
      document.querySelector('#gate-note').textContent = 'Stay on the Google page. This desk opens on its own when that account is authorised.';
    }
  };
  if (immediate !== false) void tick();
  loginPoll = window.setInterval(() => {
    void tick();
  }, wait);
}

async function openIfSignedIn() {
  const note = document.querySelector('#gate-note');
  const button = document.querySelector('#google-signin');
  try {
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (me.ok) {
      const data = await me.json();
      if (data.email) {
        showDesk(data.email);
        return;
      }
    }
  } catch {
    button.hidden = false;
    note.textContent = 'Sign-in is unavailable. The desk stays closed.';
    return;
  }
  button.hidden = false;
  let pending = false;
  let intervalSec = 5;
  try {
    const res = await fetch('/api/auth/pending', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      pending = Boolean(data.pending);
      if (data.intervalSec) intervalSec = data.intervalSec;
    }
  } catch {
    pending = loginStarted();
  }
  if (!pending && !loginStarted()) return;
  note.textContent = 'Stay on the Google page. This desk opens on its own when that account is authorised.';
  const state = await pollOnce();
  if (state === 'desk' || state === 'error') return;
  startLoginPoll(intervalSec, false);
}

async function continueWithGoogle() {
  const note = document.querySelector('#gate-note');
  holdTabOpen();
  const popup = window.open('about:blank', '_blank');
  loginPopup = popup;
  note.textContent = 'Opening Google…';
  const res = await fetch('/api/auth/google', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.verificationUrl || !data.login) {
    closeLoginPopup();
    releaseTab();
    note.textContent = data.error || 'Sign-in did not start.';
    return;
  }
  markLogin(data.login);
  const link = document.querySelector('#gate-open');
  if (popup && popup !== window) {
    popup.location = data.verificationUrl;
    link.hidden = true;
  } else {
    link.href = data.verificationUrl;
    link.hidden = false;
  }
  note.textContent = 'Stay on the Google page. This desk opens on its own when that account is authorised.';
  startLoginPoll(data.intervalSec);
}

function showGate() {
  document.body.classList.add('locked');
  document.querySelector('#desk').hidden = true;
  stopPoll();
  void openIfSignedIn();
}

let resumeFlight = null;
function resumeLogin() {
  if (!document.body.classList.contains('locked')) return;
  if (resumeFlight) return;
  resumeFlight = openIfSignedIn().finally(() => {
    resumeFlight = null;
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  resumeLogin();
});
window.addEventListener('pageshow', resumeLogin);
window.addEventListener('focus', resumeLogin);

async function loadKeys() {
  const res = await fetch('/api/keys');
  if (!res.ok) return;
  const data = await res.json();
  const status = document.querySelector('#keys-status');
  if (data.error) {
    status.textContent = data.error;
    return;
  }
  if (data.source === 'saved') status.textContent = 'Saved keys for this account are on this machine. The values are not shown.';
  else status.textContent = 'No keys stored for this account. Live fires stay off until you save them.';
}

function clearKeyInputs() {
  document.querySelector('#key-id').value = '';
  document.querySelector('#key-secret').value = '';
}

bindTimeframes(document.querySelector('#live-tfs'));
bindTimeframes(document.querySelector('#bt-tfs'));
document.querySelector('#live-fit').addEventListener('click', () => liveChart.fit());
document.querySelector('#bt-fit').addEventListener('click', () => tradeChart.frameSetup());

document.querySelector('#export').addEventListener('click', async () => {
  const res = await fetch('/api/review');
  if (res.status === 401) {
    showGate();
    return;
  }
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
  if (res.status === 401) {
    showGate();
    return;
  }
  const data = await res.json();
  applyPayload(data);
});

document.querySelector('#tape').addEventListener('click', async () => {
  const res = await fetch('/api/tape', { method: 'POST' });
  if (res.status === 401) {
    showGate();
    return;
  }
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
  if (res.status === 401) {
    showGate();
    return;
  }
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
    if (res.status === 401) {
      showGate();
      return;
    }
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
  if (res.status === 401) {
    showGate();
    return;
  }
  applyPayload(await res.json());
});

document.querySelector('#google-signin').addEventListener('click', () => {
  void continueWithGoogle();
});

document.querySelector('#sign-out').addEventListener('click', async () => {
  stopLoginPoll();
  closeLoginPopup();
  releaseTab();
  await fetch('/api/auth/logout', { method: 'POST' });
  try {
    sessionStorage.removeItem('chokeSession');
    sessionStorage.removeItem('chokeLoginTicket');
  } catch {
    /* ignore */
  }
  snapshot = null;
  showGate();
});

document.querySelector('#keys-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const apiKey = document.querySelector('#key-id').value.trim();
  const apiSecret = document.querySelector('#key-secret').value.trim();
  const res = await fetch('/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey, apiSecret }),
  });
  clearKeyInputs();
  if (res.status === 401) {
    showGate();
    return;
  }
  const data = await res.json();
  if (!res.ok) {
    document.querySelector('#keys-status').textContent = data.error || 'Keys were not stored.';
    return;
  }
  await loadKeys();
});

document.querySelector('#keys-remove').addEventListener('click', async () => {
  const res = await fetch('/api/keys', { method: 'DELETE' });
  clearKeyInputs();
  if (res.status === 401) {
    showGate();
    return;
  }
  await loadKeys();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

showGate();
