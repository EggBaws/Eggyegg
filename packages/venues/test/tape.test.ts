import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMexcTapeMessage } from '../src/mexcTape.ts';

describe('mexc public tape', () => {
  it('reads a 5m push and prefers the real OHLC', () => {
    const raw = JSON.stringify({
      symbol: 'BTC_USDT',
      data: {
        symbol: 'BTC_USDT',
        interval: 'Min5',
        t: 1790272500,
        o: 1,
        c: 2,
        h: 3,
        l: 0.5,
        ro: 84022.2,
        rc: 84000.9,
        rh: 84026.6,
        rl: 83956.3,
      },
      channel: 'push.kline',
    });
    const event = parseMexcTapeMessage(raw);
    assert.equal(event?.kind, 'kline');
    if (event?.kind !== 'kline') return;
    assert.equal(event.kline.timeMs, 1790272500_000);
    assert.equal(event.kline.open, 84022.2);
    assert.equal(event.kline.close, 84000.9);
    assert.equal(event.kline.high, 84026.6);
    assert.equal(event.kline.low, 83956.3);
    assert.equal(event.kline.interval, 'Min5');
  });

  it('reads last price and ignores subscribe acks', () => {
    const ticker = parseMexcTapeMessage(
      JSON.stringify({ symbol: 'ETH_USDT', data: { symbol: 'ETH_USDT', lastPrice: 2665.62 }, channel: 'push.ticker' }),
    );
    assert.deepEqual(ticker, { kind: 'ticker', symbol: 'ETH_USDT', lastPrice: 2665.62 });
    assert.deepEqual(parseMexcTapeMessage(JSON.stringify({ channel: 'pong', data: 1 })), { kind: 'pong' });
    assert.equal(parseMexcTapeMessage(JSON.stringify({ channel: 'rs.sub.kline', data: 'success' })), null);
    assert.equal(parseMexcTapeMessage('not-json'), null);
  });
});
