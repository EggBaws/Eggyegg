import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConsoleFileNotifier } from '../src/index.ts';

describe('console file notifier', () => {
  it('debounces the same pair and state for five minutes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'choke-note-'));
    const path = join(dir, 'notify.log');
    const note = new ConsoleFileNotifier(path, 300_000);
    const base = {
      pair: 'ETHUSDT',
      state: 'ARM',
      level: 'info' as const,
      body: 'ETH ARM first-tag',
      tsUk: '2026-09-24T08:00:00.000+01:00',
    };
    note.ping({ ...base, tsMs: 0 });
    note.ping({ ...base, tsMs: 60_000 });
    note.ping({ ...base, tsMs: 300_000, state: 'FORMING', body: 'ETH FORMING' });
    note.ping({ ...base, tsMs: 300_000 });
    const text = readFileSync(path, 'utf8');
    assert.equal(text.split('ETHUSDT').length - 1, 3);
  });
});
