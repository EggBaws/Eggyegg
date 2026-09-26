import { createHmac } from 'node:crypto';
import type { LimitRequest, PlaceResult, VenueAdapter } from './types.ts';

export const MEXC_SPECS = {
  BTCUSDT: { symbol: 'BTC_USDT', contractSize: 0.0001, priceScale: 1, minVol: 1 },
  ETHUSDT: { symbol: 'ETH_USDT', contractSize: 0.01, priceScale: 2, minVol: 1 },
  SOLUSDT: { symbol: 'SOL_USDT', contractSize: 0.1, priceScale: 2, minVol: 1 },
} as const;

export type MexcPair = keyof typeof MEXC_SPECS;

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export function signMexc(secret: string, accessKey: string, timestamp: string, paramString: string): string {
  return createHmac('sha256', secret).update(`${accessKey}${timestamp}${paramString}`).digest('hex');
}

export function contractsForQty(pair: string, coinQty: number): number {
  const spec = specOf(pair);
  if (!spec || !(coinQty > 0)) return 0;
  const vol = Math.floor(coinQty / spec.contractSize + 1e-9);
  if (vol < spec.minVol) return 0;
  return vol;
}

export function roundExchangePrice(pair: string, price: number): number {
  const digits = specOf(pair)?.priceScale ?? 2;
  const factor = 10 ** digits;
  return Math.round(price * factor) / factor;
}

/**
 * LIMIT only (type 1). Side 1 opens long, side 3 opens short.
 * Volume is an integer contract count. Stop and target travel with the order.
 */
export function mexcSubmitJson(req: LimitRequest, leverage: number): { json: string; vol: number } | { error: string } {
  if (req.type !== 'LIMIT') return { error: 'MARKET_FORBIDDEN' };
  const spec = specOf(req.pair);
  if (!spec) return { error: 'UNKNOWN_PAIR' };
  const vol = contractsForQty(req.pair, req.qty);
  if (vol < 1) return { error: 'VOL_BELOW_MIN' };
  const body = {
    symbol: spec.symbol,
    price: roundExchangePrice(req.pair, req.price),
    vol,
    leverage,
    side: req.side === 'buy' ? 1 : 3,
    type: 1,
    openType: 1,
    externalOid: req.clientOrderId,
    stopLossPrice: roundExchangePrice(req.pair, req.sl),
    takeProfitPrice: roundExchangePrice(req.pair, req.tp),
  };
  return { json: JSON.stringify(body), vol };
}

export function liveArmGate(input: {
  confirm: string;
  apiKey: string;
  apiSecret: string;
  accountOk: boolean;
}): { arm: boolean; message: string } {
  if (input.confirm !== 'START_LIVE') {
    return { arm: false, message: 'Confirmation required. Nothing was sent.' };
  }
  if (!input.apiKey || !input.apiSecret) {
    return { arm: false, message: 'MEXC_API_KEY and MEXC_API_SECRET are not set. Nothing was sent.' };
  }
  if (!input.accountOk) {
    return { arm: false, message: 'MEXC did not accept the keys. Nothing was sent.' };
  }
  return { arm: true, message: 'Live LIMIT fires are on. Market orders are not used.' };
}

/** USDT equity from GET /api/v1/private/account/assets. Other currencies are ignored. */
export function usdtEquityFromAssets(data: unknown): { equity: number; available: number } | null {
  if (!Array.isArray(data)) return null;
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const asset = row as { currency?: string; equity?: number; availableBalance?: number; positionMargin?: number };
    if (asset.currency !== 'USDT') continue;
    const available = typeof asset.availableBalance === 'number' ? asset.availableBalance : null;
    if (available == null || available < 0) return null;
    const equity =
      typeof asset.equity === 'number'
        ? asset.equity
        : available + (typeof asset.positionMargin === 'number' ? asset.positionMargin : 0);
    if (!(equity > 0)) return null;
    return { equity, available };
  }
  return null;
}

export function liveStopGate(confirm: string): { stop: boolean; message: string } {
  if (confirm !== 'STOP_LIVE') return { stop: false, message: 'Confirmation required.' };
  return { stop: true, message: 'Live fires are off.' };
}

export interface MexcLiveAdapter extends VenueAdapter {
  cancelExternal(pair: string, externalOid: string): Promise<{ ok: boolean; error?: string }>;
  pingAccount(): Promise<boolean>;
  orderFilled(orderId: string): Promise<boolean>;
  moveProtection(req: { pair: string; orderId: string; sl: number; tp: number }): Promise<{ ok: boolean; error?: string }>;
  accountEquity(): Promise<{ equity: number; available: number } | null>;
}

/** Move the stop to the lock and keep the runner target on an existing limit. Latest price. */
export function mexcChangeProtectionJson(
  pair: string,
  orderId: string,
  sl: number,
  tp: number,
): { json: string } | { error: string } {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return { error: 'BAD_ORDER' };
  if (!specOf(pair)) return { error: 'UNKNOWN_PAIR' };
  const body = {
    orderId: id,
    stopLossPrice: roundExchangePrice(pair, sl),
    takeProfitPrice: roundExchangePrice(pair, tp),
    lossTrend: 1,
    profitTrend: 1,
  };
  return { json: JSON.stringify(body) };
}

export function createMexcLive(opts: {
  apiKey: string;
  apiSecret: string;
  leverage?: number;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}): MexcLiveAdapter {
  const base = (opts.baseUrl ?? 'https://contract.mexc.com').replace(/\/$/, '');
  const leverage = opts.leverage ?? 10;
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? (() => Date.now());

  async function call(method: 'GET' | 'POST', path: string, paramString: string): Promise<{ ok: boolean; data?: unknown; message?: string }> {
    const timestamp = String(now());
    const signature = signMexc(opts.apiSecret, opts.apiKey, timestamp, paramString);
    const headers: Record<string, string> = {
      ApiKey: opts.apiKey,
      'Request-Time': timestamp,
      Signature: signature,
      'Content-Type': 'application/json',
    };
    const url = method === 'GET' && paramString ? `${base}${path}?${paramString}` : `${base}${path}`;
    const res = await fetchImpl(url, {
      method,
      headers,
      body: method === 'POST' ? paramString : undefined,
    });
    const text = await res.text();
    let parsed: { success?: boolean; data?: unknown; message?: string; code?: number } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return { ok: false, message: 'BAD_RESPONSE' };
    }
    if (!res.ok || parsed.success === false || (parsed.code != null && parsed.code !== 0)) {
      return { ok: false, message: parsed.message || 'REJECTED' };
    }
    return { ok: true, data: parsed.data };
  }

  return {
    id: 'mexc',
    health() {
      if (!opts.apiKey || !opts.apiSecret) return { ok: false, reason: 'NO_KEYS' };
      return { ok: true };
    },
    async pingAccount() {
      if (!opts.apiKey || !opts.apiSecret) return false;
      const res = await call('GET', '/api/v1/private/account/assets', '');
      return res.ok;
    },
    async accountEquity() {
      if (!opts.apiKey || !opts.apiSecret) return null;
      const res = await call('GET', '/api/v1/private/account/assets', '');
      if (!res.ok) return null;
      return usdtEquityFromAssets(res.data);
    },
    async placeLimitWithProtection(req: LimitRequest): Promise<PlaceResult> {
      const built = mexcSubmitJson(req, leverage);
      if ('error' in built) {
        return { ok: false, clientOrderId: req.clientOrderId, error: built.error };
      }
      const res = await call('POST', '/api/v1/private/order/submit', built.json);
      if (!res.ok) {
        const stop = (res.message ?? '').toLowerCase().includes('stop');
        return {
          ok: false,
          clientOrderId: req.clientOrderId,
          cancelledBecauseSlFailed: stop,
          error: stop ? 'SL_ATTACH_FAILED' : 'VENUE_UNHEALTHY',
        };
      }
      const orderId = res.data == null ? undefined : String(res.data);
      return { ok: true, orderId, clientOrderId: req.clientOrderId };
    },
    async orderFilled(orderId: string) {
      const id = Number(orderId);
      if (!Number.isInteger(id) || id <= 0) return false;
      const res = await call('GET', `/api/v1/private/order/get/${id}`, '');
      if (!res.ok || res.data == null || typeof res.data !== 'object') return false;
      const row = res.data as { state?: number; dealVol?: number };
      return row.state === 3 || (typeof row.dealVol === 'number' && row.dealVol > 0);
    },
    async moveProtection(req: { pair: string; orderId: string; sl: number; tp: number }) {
      const built = mexcChangeProtectionJson(req.pair, req.orderId, req.sl, req.tp);
      if ('error' in built) return { ok: false, error: built.error };
      const res = await call('POST', '/api/v1/private/stoporder/change_price', built.json);
      return res.ok ? { ok: true } : { ok: false, error: res.message ?? 'AMEND_FAILED' };
    },
    async cancelExternal(pair: string, externalOid: string) {
      const spec = specOf(pair);
      if (!spec) return { ok: false, error: 'UNKNOWN_PAIR' };
      const json = JSON.stringify({ symbol: spec.symbol, externalOid });
      const res = await call('POST', '/api/v1/private/order/cancel_with_external', json);
      return res.ok ? { ok: true } : { ok: false, error: res.message ?? 'CANCEL_FAILED' };
    },
  };
}

function specOf(pair: string): (typeof MEXC_SPECS)[MexcPair] | null {
  if (pair === 'BTCUSDT' || pair === 'ETHUSDT' || pair === 'SOLUSDT') return MEXC_SPECS[pair];
  return null;
}
