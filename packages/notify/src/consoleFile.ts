import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NotifyEvent, Notifier } from './types.ts';

/**
 * Console + file notifier. One delivery per pair per state inside the debounce window.
 * Telegram can implement the same Notifier interface later. This stub does not send anywhere else.
 */
export class ConsoleFileNotifier implements Notifier {
  private last = new Map<string, number>();
  private filePath: string;
  private debounceMs: number;

  constructor(filePath: string, debounceMs = 300_000) {
    this.filePath = filePath;
    this.debounceMs = debounceMs;
  }

  ping(event: NotifyEvent): void {
    const key = `${event.pair}|${event.state}`;
    const prev = this.last.get(key);
    if (prev != null && event.tsMs - prev < this.debounceMs) return;
    this.last.set(key, event.tsMs);
    const text = `${event.tsUk} ${event.level.toUpperCase()} ${event.state} ${event.pair}\n${event.body}\n`;
    console.log(text.trimEnd());
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, text, 'utf8');
  }
}
