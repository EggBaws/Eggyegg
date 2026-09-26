import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  contractsForQty,
  createMexcLive,
  liveArmGate,
  liveStopGate,
  mexcChangeProtectionJson,
  mexcSubmitJson,
  parseMexcKlines,
  signMexc,
  usdtEquityFromAssets,
} from '../src/index.ts';

const req = {
  clientOrderId: 'choke-v1-ETHUSDT-20260924',
  pair: 'ETHUSDT',
  side: 'buy' as const,
  type: 'LIMIT' as const,
  price: 2650,
  qty: 3.7735849,
  sl: 2641.99,
  tp: 2679.68,
  reduceOnlySlTp: true as const,
};

describe('mexc live adapter', () => {
  it('signs the access key, timestamp, and param string', () => {
    const sig = signMexc('secret', 'key', '1000', 'symbol=ETH_USDT');
    const expected = createHmac('sha256', 'secret').update('key1000symbol=ETH_USDT').digest('hex');
    assert.equal(sig, expected);
  });

  it('builds a limit order with integer contracts and attached protection', () => {
    assert.equal(contractsForQty('ETHUSDT', 3.7735849), 377);
    assert.equal(contractsForQty('BTCUSDT', 0.00005), 0);
    const built = mexcSubmitJson(req, 10);
    if (!('json' in built)) throw new Error('expected json');
    const body = JSON.parse(built.json) as Record<string, unknown>;
    assert.equal(body.type, 1);
    assert.equal(body.side, 1);
    assert.equal(body.openType, 1);
    assert.equal(body.vol, 377);
    assert.equal(body.symbol, 'ETH_USDT');
    assert.equal(body.externalOid, req.clientOrderId);
    assert.equal(body.stopLossPrice, 2641.99);
    assert.equal(body.takeProfitPrice, 2679.68);
    const moved = mexcChangeProtectionJson('ETHUSDT', '99', 2685.45, 2698.77);
    if (!('json' in moved)) throw new Error('expected json');
    const change = JSON.parse(moved.json) as Record<string, unknown>;
    assert.equal(change.orderId, 99);
    assert.equal(change.stopLossPrice, 2685.45);
    assert.equal(change.takeProfitPrice, 2698.77);
    assert.equal(change.lossTrend, 1);
    assert.equal(change.profitTrend, 1);
    assert.equal('error' in mexcChangeProtectionJson('ETHUSDT', 'nope', 1, 2) && true, true);
    assert.equal(body.leverage, 10);
    const market = mexcSubmitJson({ ...req, type: 'MARKET' as 'LIMIT' }, 10);
    assert.equal('error' in market && market.error, 'MARKET_FORBIDDEN');
  });

  it('stays off without keys and posts only the signed limit body', async () => {
    assert.equal(liveArmGate({ confirm: 'START_LIVE', apiKey: '', apiSecret: '', accountOk: false }).arm, false);
    assert.match(liveArmGate({ confirm: 'START_LIVE', apiKey: '', apiSecret: 'x', accountOk: true }).message, /not set/);
    assert.equal(liveArmGate({ confirm: 'nope', apiKey: 'k', apiSecret: 's', accountOk: true }).arm, false);
    assert.equal(liveArmGate({ confirm: 'START_LIVE', apiKey: 'k', apiSecret: 's', accountOk: false }).arm, false);
    assert.equal(liveArmGate({ confirm: 'START_LIVE', apiKey: 'k', apiSecret: 's', accountOk: true }).arm, true);
    assert.equal(liveStopGate('STOP_LIVE').stop, true);
    assert.equal(liveStopGate('FLATTEN').stop, false);

    const calls: { url: string; body?: string; headers?: Record<string, string> }[] = [];
    const venue = createMexcLive({
      apiKey: 'key',
      apiSecret: 'secret',
      leverage: 10,
      now: () => 1_700_000_000_000,
      fetchImpl: async (url, init) => {
        calls.push({ url, body: init?.body, headers: init?.headers });
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, code: 0, data: 99 }) };
      },
    });
    assert.equal(venue.health().ok, true);
    const placed = await venue.placeLimitWithProtection(req);
    assert.equal(placed.ok, true);
    assert.equal(placed.orderId, '99');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/v1\/private\/order\/submit$/);
    const sent = JSON.parse(calls[0].body ?? '{}') as { type: number };
    assert.equal(sent.type, 1);
    assert.equal(calls[0].headers?.ApiKey, 'key');
    assert.equal(calls[0].headers?.['Request-Time'], '1700000000000');
    const expected = signMexc('secret', 'key', '1700000000000', calls[0].body ?? '');
    assert.equal(calls[0].headers?.Signature, expected);

    const tiny = await venue.placeLimitWithProtection({ ...req, pair: 'BTCUSDT', qty: 0.00001 });
    assert.equal(tiny.ok, false);
    assert.equal(tiny.error, 'VOL_BELOW_MIN');
    assert.equal(calls.length, 1);

    calls.length = 0;
    const open = await venue.orderFilled('99');
    assert.equal(open, false);
    assert.match(calls[0].url, /\/api\/v1\/private\/order\/get\/99$/);
    calls.length = 0;
    const movedLive = await venue.moveProtection({ pair: 'ETHUSDT', orderId: '99', sl: 2685.45, tp: 2698.77 });
    assert.equal(movedLive.ok, true);
    assert.match(calls[0].url, /\/api\/v1\/private\/stoporder\/change_price$/);
    const changeBody = JSON.parse(calls[0].body ?? '{}') as { stopLossPrice: number; takeProfitPrice: number };
    assert.equal(changeBody.stopLossPrice, 2685.45);
    assert.equal(changeBody.takeProfitPrice, 2698.77);

    const cancelled = await venue.cancelExternal('ETHUSDT', req.clientOrderId);
    assert.equal(cancelled.ok, true);
    assert.match(calls[1].url, /cancel_with_external/);
    const cancelBody = JSON.parse(calls[1].body ?? '{}') as { externalOid: string; symbol: string };
    assert.equal(cancelBody.externalOid, req.clientOrderId);
    assert.equal(cancelBody.symbol, 'ETH_USDT');
  });

  it('reads USDT equity and ignores other currencies', () => {
    assert.equal(usdtEquityFromAssets(null), null);
    assert.equal(usdtEquityFromAssets([{ currency: 'BTC', equity: 1, availableBalance: 1 }]), null);
    assert.deepEqual(
      usdtEquityFromAssets([
        { currency: 'BTC', equity: 1, availableBalance: 1 },
        { currency: 'USDT', equity: 250.5, availableBalance: 180.25, positionMargin: 70.25 },
      ]),
      { equity: 250.5, available: 180.25 },
    );
    assert.deepEqual(usdtEquityFromAssets([{ currency: 'USDT', availableBalance: 40, positionMargin: 10 }]), {
      equity: 50,
      available: 40,
    });
  });

  it('parses columnar klines and drops the forming bar', () => {
    const now = 1_790_265_300_000;
    const candles = parseMexcKlines(
      {
        success: true,
        data: {
          time: [1790265000, 1790265300],
          open: [1, 2],
          close: [1.2, 2.2],
          high: [1.3, 2.3],
          low: [0.9, 1.9],
          realOpen: [10, 20],
          realClose: [11, 21],
          realHigh: [12, 22],
          realLow: [9, 19],
        },
      },
      'Min5',
      now,
    );
    assert.equal(candles.length, 1);
    assert.equal(candles[0].time, 1_790_265_000_000);
    assert.equal(candles[0].open, 10);
    assert.equal(candles[0].close, 11);
    assert.equal(candles[0].closed, true);
  });
});
