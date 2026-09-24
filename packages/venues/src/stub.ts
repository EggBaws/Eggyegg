import type { LimitRequest, PlaceResult, StubOptions, VenueAdapter } from './types.ts';

/**
 * In-memory venue. No keys, no HTTP, no market orders.
 * LIMIT is accepted and SL+TP are attached as reduce-only protection.
 * If the stop cannot attach, the limit is cancelled and the result is not ok.
 */
export function createStubVenue(id: 'mexc' | 'kucoin', opts: StubOptions = {}): VenueAdapter {
  const open = new Map<string, LimitRequest>();
  const cancelled: string[] = [];
  return {
    id,
    health() {
      if (opts.healthy === false) return { ok: false, reason: 'VENUE_UNHEALTHY' };
      return { ok: true };
    },
    placeLimitWithProtection(req: LimitRequest): PlaceResult {
      if (req.type !== 'LIMIT') {
        return { ok: false, clientOrderId: req.clientOrderId, error: 'MARKET_FORBIDDEN' };
      }
      open.set(req.clientOrderId, req);
      if (opts.failSl) {
        open.delete(req.clientOrderId);
        cancelled.push(req.clientOrderId);
        return {
          ok: false,
          clientOrderId: req.clientOrderId,
          cancelledBecauseSlFailed: true,
          error: 'SL_ATTACH_FAILED',
        };
      }
      return { ok: true, orderId: `sim-${id}-${req.clientOrderId}`, clientOrderId: req.clientOrderId };
    },
  };
}

export function createMexc(opts?: StubOptions): VenueAdapter {
  return createStubVenue('mexc', opts);
}

export function createKucoin(opts?: StubOptions): VenueAdapter {
  return createStubVenue('kucoin', opts);
}

export function createVenue(id: 'mexc' | 'kucoin', opts?: StubOptions): VenueAdapter {
  return id === 'mexc' ? createMexc(opts) : createKucoin(opts);
}
