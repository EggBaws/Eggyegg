import { unlinkSync, existsSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChokeEngine, demoBook, loadConfig, readOrderLog } from '../packages/engine/src/index.ts';
import { ConsoleFileNotifier } from '../packages/notify/src/index.ts';
import { createVenue } from '../packages/venues/src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(join(root, 'config/default.json'));
const dryPath = isAbsolute(config.dry_run_log) ? config.dry_run_log : join(root, config.dry_run_log);
const notePath = isAbsolute(config.notify_log) ? config.notify_log : join(root, config.notify_log);

if (existsSync(dryPath)) unlinkSync(dryPath);

const engine = new ChokeEngine({
  config,
  venue: createVenue(config.active_venue),
  notifier: new ConsoleFileNotifier(notePath, config.notify_debounce_ms),
  dryRunPath: dryPath,
});

const snap = engine.runBook(demoBook().updates);
const orders = readOrderLog(dryPath);

console.log(`LIVE_ARMED=${String(config.live_armed)} venue=${config.active_venue} window=disabled`);
for (const pair of snap.pairs) {
  console.log(`${pair.pair} ${pair.state} btc_aligned=${pair.btcAligned ? 'yes' : 'no'} ${pair.stamp}`);
}
console.log(`wrote ${orders.length} order(s) → ${dryPath}`);
console.log(JSON.stringify(orders, null, 2));
