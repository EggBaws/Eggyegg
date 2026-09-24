import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OrderLogEntry } from './types.ts';

export function readOrderLog(path: string): OrderLogEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`order log ${path} is not a JSON array`);
  return parsed as OrderLogEntry[];
}

export function appendOrderLog(path: string, entry: OrderLogEntry): OrderLogEntry[] {
  const prev = readOrderLog(path);
  const next = [...prev, entry];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function writeOrderLog(path: string, entries: OrderLogEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}
