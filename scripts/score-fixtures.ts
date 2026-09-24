import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChokeEngine, loadConfig, ukParts, type Candle, type PairId } from '../packages/engine/src/index.ts';
import { fetchMexcKlines } from '../packages/venues/src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIVE = 300_000;

interface FixtureRow {
  id: string;
  decision: string;
  pair: string;
  side: string;
  tf_entry: string;
  entry_time_uk: string | null;
}

interface VetoRow {
  id: string;
  severity: string;
}

interface ScoreRow {
  id: string;
  severity: string;
  decision: string;
  pair: string;
  tf: string;
  entryUk: string | null;
  state: string | null;
  reason: string | null;
  fired: boolean;
  note: string;
}

function londonToUtc(year: number, month: number, day: number, hour: number, minute: number): number {
  let utc = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 4; i++) {
    const parts = ukParts(utc);
    const got = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    const want = Date.UTC(year, month - 1, day, hour, minute);
    utc += want - got;
  }
  return utc;
}

function dated(id: string): { year: number; month: number; day: number } | null {
  const m = id.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function pairId(pair: string): PairId | null {
  if (pair === 'BTC') return 'BTCUSDT';
  if (pair === 'ETH') return 'ETHUSDT';
  if (pair === 'SOL') return 'SOLUSDT';
  return null;
}

async function scoreOne(
  config: ReturnType<typeof loadConfig>,
  row: FixtureRow,
  severity: string,
): Promise<ScoreRow> {
  const base: ScoreRow = {
    id: row.id,
    severity,
    decision: row.decision,
    pair: row.pair,
    tf: row.tf_entry,
    entryUk: row.entry_time_uk,
    state: null,
    reason: null,
    fired: false,
    note: '',
  };
  const when = dated(row.id);
  const clock = row.entry_time_uk?.match(/^(\d{1,2}):(\d{2})$/);
  const pair = pairId(row.pair);
  if (!when || !clock || !pair) {
    base.note = 'No calendar date or entry time on the label. Drop a dated row in fixtures/fixtures.jsonl to score it. Labels were not changed.';
    return base;
  }
  const entryMs = londonToUtc(when.year, when.month, when.day, Number(clock[1]), Number(clock[2]));
  const barOpen = Math.floor(entryMs / FIVE) * FIVE;
  const nowMs = barOpen + FIVE + 500;
  const symbol = pair.replace('USDT', '_USDT');
  let m5: Candle[] = [];
  let h1: Candle[] = [];
  try {
    [m5, h1] = await Promise.all([
      fetchMexcKlines({ symbol, interval: 'Min5', startMs: entryMs - 36 * 60 * 60_000, endMs: nowMs, pauseMs: 0 }),
      fetchMexcKlines({ symbol, interval: 'Min60', startMs: entryMs - 10 * 24 * 60 * 60_000, endMs: nowMs, pauseMs: 0 }),
    ]);
  } catch (err) {
    base.note = `MEXC candles failed: ${err instanceof Error ? err.message : 'error'}`;
    return base;
  }
  const bars = m5.filter((c) => c.time + FIVE <= nowMs);
  if (bars.length < 20) {
    base.note = 'Fewer than 20 closed 5m bars in the window.';
    return base;
  }
  const engine = new ChokeEngine({
    config,
    venue: { id: 'kucoin', health: () => ({ ok: true }), placeLimitWithProtection: () => ({ ok: true }) },
    notifier: { ping() {} },
    dryRunPath: join(root, 'logs/fixture-score-unused.json'),
    skipOrderLog: true,
  });
  const empty: Candle[] = [];
  const updates = (['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as PairId[]).map((id) => ({
    pair: id,
    candles5m: id === pair ? bars.slice(-400) : empty,
    candles1h: id === pair ? h1 : empty,
    lastPrice: id === pair ? bars[bars.length - 1].close : 0,
    nowMs,
    forceStale: false,
  }));
  const snap = await engine.runBook(updates);
  const view = snap.pairs.find((p) => p.pair === pair);
  base.state = view?.state ?? null;
  base.reason = view?.reason ?? null;
  base.fired = view?.state === 'WORKING';
  const tfNote =
    row.tf_entry === '5m'
      ? 'Scored on 5m.'
      : `Label is ${row.tf_entry}. Scored on closed 5m only — the engine does not invent a 3m or 2m series when 5m is continuous.`;
  if (severity === 'pass' && !base.fired) {
    base.note = `${tfNote} Green take did not arm on 5m (${base.state}${base.reason ? ` ${base.reason}` : ''}). Left unfired rather than relaxing the gates.`;
  } else if (severity === 'pass' && base.fired) {
    base.note = `${tfNote} Green take armed. Hard SPIT passed.`;
  } else if (severity === 'hard_skip' && base.fired) {
    base.note = `${tfNote} Hard-skip label still armed because the candle gates passed. A clock is not a spit reason.`;
  } else if (severity === 'hard_skip') {
    base.note = `${tfNote} Hard-skip did not arm (${base.state}${base.reason ? ` ${base.reason}` : ''}).`;
  } else if (base.fired) {
    base.note = `${tfNote} Warn row armed only because the hard candle gates passed.`;
  } else {
    base.note = `${tfNote} Warn row did not arm (${base.state}${base.reason ? ` ${base.reason}` : ''}).`;
  }
  return base;
}

async function main(): Promise<void> {
  const config = loadConfig(join(root, 'config/default.json'));
  const fixtures = readFileSync(join(root, 'fixtures/fixtures.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as FixtureRow);
  const veto = new Map<string, string>();
  const vetoPath = join(root, 'fixtures/specialists-veto.jsonl');
  for (const line of readFileSync(vetoPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as VetoRow;
    veto.set(row.id, row.severity);
  }
  const rows: ScoreRow[] = [];
  for (const fixture of fixtures) {
    const severity = veto.get(fixture.id) ?? 'warn';
    rows.push(await scoreOne(config, fixture, severity));
    const row = rows[rows.length - 1];
    console.log(`${row.severity.padEnd(9)} ${row.fired ? 'FIRE' : 'miss'} ${row.id} ${row.state ?? '-'} ${row.reason ?? ''}`.trim());
  }
  const out = {
    generatedAt: new Date().toISOString(),
    note: 'Labels in fixtures/fixtures.jsonl were not edited. Undated rows stay unscored. 3m and 2m takes are judged on 5m.',
    fired: rows.filter((r) => r.fired).length,
    scored: rows.filter((r) => r.state).length,
    rows,
  };
  writeFileSync(join(root, 'logs/fixture-score.json'), JSON.stringify(out, null, 2));
  console.log(`wrote logs/fixture-score.json  fired ${out.fired} / scored ${out.scored}`);
}

await main();
