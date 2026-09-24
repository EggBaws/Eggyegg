# Choke Watcher v1

Rules engine for BTCUSDT, ETHUSDT, and SOLUSDT perpetuals. It paints a 5m choke (sweep, smash, FVG, retrace into the box), pings, and writes a dry-run LIMIT order. It does not improvise. An unclear bar does not fire.

`LIVE_ARMED` defaults to **false**. Until that flag is true the process only paints, pings, and appends order JSON. It never sends a market order and never chases price. There are no exchange keys in this repo.

Structure, risk, and the state machine are deterministic candle math. Nothing in that path calls a model.

## Run

Node 22.14 or newer. No npm dependencies.

```bash
npm test
npm run dry-run
npm start
```

- `npm test` covers sweep, smash, FVG, neck, zone, entry cap, stop risk, NEED_DEEPER, SPIT codes, and the state machine.
- `npm run dry-run` replays a synthetic book and writes `logs/orders.json`. The sample ETH setup is 08:00 UK, outside the old afternoon clock, and still produces a LIMIT.
- `npm start` serves the desk at http://127.0.0.1:4173 . Three pair tiles. Tap a tile for the 5m overlay. The header badge is status only — it is not a switch.

Override the port with `PORT`.

## LIVE_ARMED

Set `live_armed` in `config/default.json`.

| value | behaviour |
| --- | --- |
| `false` (default) | Paint, ping, append a dry-run LIMIT with reason `LIVE_OFF`. Venue `place` is not called. |
| `true` | Same LIMIT, then the active venue stub attaches reduce-only SL and TP. If the stop cannot attach, the limit is cancelled and the pair goes `BLOCKED`. |

Order type is always `LIMIT`. Client order id is `choke-v1-{pair}-{yyyymmdd}` in Europe/London. Example: `choke-v1-ETHUSDT-20260924`.

## Config

`config/default.json` matches the locked spec. `window_start` and `window_end` are `null`. The engine does not reject a setup because of the clock, and it does not cancel at 20:00. Holidays raise a warning and do not stop detection. `LIVE_ARMED` is still what gates an exchange send.

| knob | default | role |
| --- | --- | --- |
| `live_armed` | `false` | Exchange send gate |
| `active_venue` | `kucoin` | `kucoin` or `mexc` |
| `pairs` | BTCUSDT, ETHUSDT, SOLUSDT | Book |
| `stake_gbp` | `1000` | Paper stake. Sizing uses this figure against USDT distance with no FX conversion |
| `leverage` | `10` | Margin risk and notional |
| `max_margin_risk` | `0.06` | 6% of stake. Wider than this is `NEED_DEEPER`, not a fill |
| `tp_price_pct` | `0.0112` | Frozen 1.12% of entry |
| `window_start` / `window_end` | `null` | Disabled |
| `timezone` | `Europe/London` | Stamps and the order-id date |
| `first_tag` | `true` | First tag of the box after it exists |
| `btc_align_required` | `false` | Locked off. `btc_aligned` is displayed and stored on the order |
| `max_arms_per_pair_per_day` | `1` | Second arm the same UK day is `ALREADY_USED` |
| `max_fills_across_book` | `3` | Further arms go `BLOCKED` |
| `dry_run_log` | `./logs/orders.json` | Append-only order JSON |
| `chase_neck_frac` | `0.4` | Price that leaves the zone by more than this fraction of neck height is `CHASE` |
| `stale_close_ms` | `2000` | A 5m close older than this does not fire. The chart still paints |

`btc_aligned` is true when BTC's 5m printed a sweep on the same UK date in the same direction. ETH or SOL can `ARM` while it is false.

Take profit is `entry * (1 ± 0.0112)`. The stop is one tick beyond the tighter of the sweep wick and a later session wick. Quantity is the minimum of stake × leverage and the size whose stop loss is about stake × 6%.

## States

`FLAT → FORMING → WAIT_RETRACE → ARM → WORKING → DONE`

Side states: `SPIT`, `NEED_DEEPER`, `EXPIRED`, `BLOCKED`.

Every transition is logged with a UK timestamp, price, and reason. SPIT codes: `FAKE_NECK`, `NO_FVG`, `NO_SWEEP`, `CHASE`, `FAT_STOP`, `ALREADY_USED`, `SECOND_ON_SAME_BOX`, `VENUE_UNHEALTHY`, `DAILY_KILL`. `HOLIDAY` and `LIVE_OFF` are not blocks. A realised plus open loss at or beyond 6% of stake is `DAILY_KILL`.

Kill on the desk asks for confirmation, cancels a working limit, records a reduce-only flatten intent (still `LIMIT`, not market), and mutes the book for the day.

## Chart

Overlay colours come from the engine levels, not from the page:

- orange — sweep wick
- white — neck
- purple — FVG / acceptance box
- green — buy or sell zone
- red — stop
- blue — 1.12% target
- grey dashed — last price when it is not inside the zone

30m candles and the 1h MA5 are context. The MA5 only feeds `entry_cap`. It does not block a direction. 3m is used only when a 5m candle is missing.

`pine/choke_watcher_v1.pine` is an optional mirror. If it disagrees with the engine, the engine wins. The study does not place orders.

## Venues and pings

`packages/venues` exposes one adapter interface and in-memory MEXC and KuCoin stubs. `active_venue` picks which stub the server constructs. Neither stub opens a socket.

`packages/notify` is a `Notifier` interface plus a console and file stub (`logs/notify.log`). The same interface is where a Telegram sender would plug in. Pings debounce for five minutes per pair per state: one FORMING, one ARM, one DONE / EXPIRED / SPIT.

## Fixtures

`fixtures/` is Balazs's labeled set for later paper scoring. Do not edit decisions or labels.

- `fixtures/fixtures.jsonl`
- `fixtures/rules.json`
- `fixtures/specialists-veto.jsonl`
- `fixtures/specialists-veto-summary.json`

## Out of scope

Live API keys, discretionary AI, grids, scale-in, and flipping the same pair on the same day.
