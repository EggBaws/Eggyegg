export interface LimitRequest {
  clientOrderId: string;
  pair: string;
  side: 'buy' | 'sell';
  type: 'LIMIT';
  price: number;
  qty: number;
  sl: number;
  tp: number;
  reduceOnlySlTp: true;
}

export interface PlaceResult {
  ok: boolean;
  orderId?: string;
  clientOrderId: string;
  cancelledBecauseSlFailed?: boolean;
  error?: string;
}

export interface VenueHealth {
  ok: boolean;
  reason?: string;
}

export interface VenueAdapter {
  readonly id: 'mexc' | 'kucoin';
  health(): VenueHealth;
  placeLimitWithProtection(req: LimitRequest): PlaceResult;
}

export interface StubOptions {
  healthy?: boolean;
  failSl?: boolean;
}
