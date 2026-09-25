import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAGIC = Buffer.from('CK01');

export interface StoredKeys {
  apiKey: string;
  apiSecret: string;
}

export function validKeyMaterial(value: string): boolean {
  return /^[\x21-\x7e]{8,128}$/.test(value);
}

export function keyStatus(source: 'saved' | 'environment' | 'none', error?: string): {
  configured: boolean;
  source: 'saved' | 'environment' | 'none';
  error?: string;
} {
  const body: { configured: boolean; source: 'saved' | 'environment' | 'none'; error?: string } = {
    configured: source === 'saved' || source === 'environment',
    source,
  };
  if (error) body.error = error;
  return body;
}

export function sealKeys(payload: StoredKeys, passphrase: string): Buffer {
  if (!passphrase) throw new Error('KEY_SECRET missing');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify({ apiKey: payload.apiKey, apiSecret: payload.apiSecret }), 'utf8');
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, ct]);
}

export function openKeys(blob: Buffer, passphrase: string): StoredKeys | null {
  try {
    if (!passphrase || blob.length < 4 + 16 + 12 + 16 + 2) return null;
    if (!blob.subarray(0, 4).equals(MAGIC)) return null;
    const salt = blob.subarray(4, 20);
    const iv = blob.subarray(20, 32);
    const tag = blob.subarray(32, 48);
    const ct = blob.subarray(48);
    const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plain) as { apiKey?: unknown; apiSecret?: unknown };
    if (typeof parsed.apiKey !== 'string' || typeof parsed.apiSecret !== 'string') return null;
    if (!validKeyMaterial(parsed.apiKey) || !validKeyMaterial(parsed.apiSecret)) return null;
    return { apiKey: parsed.apiKey, apiSecret: parsed.apiSecret };
  } catch {
    return null;
  }
}

export function saveKeyFile(path: string, payload: StoredKeys, passphrase: string): void {
  const blob = sealKeys(payload, passphrase);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, blob, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function readKeyFile(path: string, passphrase: string): StoredKeys | null {
  if (!existsSync(path)) return null;
  return openKeys(readFileSync(path), passphrase);
}

export function removeKeyFile(path: string): void {
  rmSync(path, { force: true });
}
