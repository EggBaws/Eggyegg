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
- `npm run backtest` replays six months of MEXC 5m and 1h candles from `data/` (gitignored) and writes `logs/backtest.json`.
- `npm run score-fixtures` scores `fixtures/fixtures.jsonl` on closed 5m candles and writes `logs/fixture-score.json`.
- `npm start` serves the desk at http://127.0.0.1:4173 . It loads a MEXC 5m tape. Three pair tiles. Tap a tile for the chart. The header badge is status. **Start live fires** stays off.

Override the port with `PORT`.

## LIVE_ARMED

`live_armed` in `config/default.json` still defaults to **false**. The desk button is what turns a real send on and off for this process.

| control | behaviour |
| --- | --- |
| Button off (default) | Paint the live MEXC tape, ping, and on a fresh 5m close append a dry-run LIMIT with reason `LIVE_OFF`. No exchange order is sent. |
| **Start live fires** | Asks you to confirm, then checks `MEXC_API_KEY` and `MEXC_API_SECRET`. If either is missing, or MEXC rejects the account call, the switch stays off and nothing is sent. |
| Button on | The next fresh 5m close can send a **LIMIT** (type 1) on MEXC with `stopLossPrice` and `takeProfitPrice`. Size is an integer contract count. Ticker updates paint the zone and do not fire. |
| **Stop live fires** | Asks you to confirm, cancels working limits by `externalOid`, and stops further sends. The tape keeps painting. |

Live sends go to MEXC even when `active_venue` is `kucoin`. Keys are read from the environment only. They are not written into config or the order log.

```bash
MEXC_API_KEY=... MEXC_API_SECRET=... npm start
```

Order type is always `LIMIT`. Client order id is `choke-v1-{pair}-{yyyymmdd}` in Europe/London. Example: `choke-v1-ETHUSDT-20260924`.

## Backtest

`npm run backtest` replays BTC, ETH, and SOL for about six months. Each decision uses only candles that have already closed. The limit is eligible on the next bar, not on the signal bar. A bar that trades through both the stop and the target counts as a loss. Setups that never fill, or that invalidate first, are misses and are not in the win rate. Paper pnl is quantity times the price distance. The stake is the config GBP figure with no FX conversion.

The page reads `logs/backtest.json` and lists wins, losses, win rate, and net. Click a trade to see that window with FVG, BOS, MSS, entry, TP, and SL on the candles that produced them. Cached klines live in `data/` and are not committed. Set `BACKTEST_REFRESH=1` to download again.

Paying replay, 25 Mar 2026 → 24 Sep 2026. Target is 0.04% of entry. The tape closes flat.

| | Wins | Losses | Misses | Win rate | Net |
| --- | ---: | ---: | ---: | ---: | ---: |
| Book | 230 | 30 | 6 | 88.5% | +£96.76 |
| BTCUSDT | 52 | 6 | 1 | 89.7% | +£83.61 |
| ETHUSDT | 96 | 11 | 2 | 89.7% | +£51.94 |
| SOLUSDT | 82 | 13 | 3 | 86.3% | −£38.78 |

Wins by UK month: March 12 (from the 25th), April 53, May 32, June 39, July 48, August 29, September 17 (through the 24th).

The target is the lever for the win count and the loss count. On this tape, 0.50% paid 113 times and lost 131 (+£1,549.67). Each step closer adds wins and removes losses, and each win pays less. 0.04% is the closest target that is still green: 230 wins, 30 losses, +£96.76. 0.03% is 232 wins and 28 losses, and the book loses £90. The neck floor, the 4 hour 40 minute retest, and the 0.175% stop floor stay. A deeper entry and a tighter wick both add losses.

What the replay kept:

- The limit is the first touch of the FVG. The smash still has to close through a neck at least 0.15% of the sweep. A smaller neck stays FORMING.
- The retest has to print within 56 closed 5m bars of the smash. Older displacement stays FORMING so the pair can arm a later choke.
- A 2-candle or 3-candle gap both count. No gap is still `NO_FVG`.
- The stop is one tick past the sweep wick, and at least 0.175% of entry. A stop on the profit side of the entry is not filled.
- A pair may arm three different chokes in one UK day, after the earlier one has closed. A second tag of the same box is still `SECOND_ON_SAME_BOX`.
- `FAKE_NECK`, `CHASE`, `NO_SWEEP`, `FAT_STOP` above 6% margin at 10x, `ALREADY_USED`, and `DAILY_KILL` are unchanged. A clock is still not a spit reason.

The ETH morning example still arms: entry 2650.20, stop 2639.20, target 2651.26.

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
| `tp_price_pct` | `0.0004` | 0.04% of entry. Closest target on this tape that still pays |
| `window_start` / `window_end` | `null` | Disabled |
| `timezone` | `Europe/London` | Stamps and the order-id date |
| `first_tag` | `true` | First tag of the box after it exists |
| `btc_align_required` | `false` | Locked off. `btc_aligned` is displayed and stored on the order |
| `max_arms_per_pair_per_day` | `3` | A fourth arm the same UK day is `ALREADY_USED` |
| `max_fills_across_book` | `9` | Further arms go `BLOCKED` |
| `dry_run_log` | `./logs/orders.json` | Append-only order JSON |
| `chase_neck_frac` | `0.4` | Price that leaves the zone by more than this fraction of neck height is `CHASE` |
| `stale_close_ms` | `2000` | A 5m close older than this does not fire. The chart still paints |

`btc_aligned` is true when BTC's 5m printed a sweep on the same UK date in the same direction. ETH or SOL can `ARM` while it is false.

Take profit is `entry * (1 ± 0.0004)`. The stop is one tick beyond the sweep wick. Quantity is the minimum of stake × leverage and the size whose stop loss is about stake × 6%.

## States

`FLAT → FORMING → WAIT_RETRACE → ARM → WORKING → DONE`

Side states: `SPIT`, `NEED_DEEPER`, `EXPIRED`, `BLOCKED`.

Every transition is logged with a UK timestamp, price, and reason. SPIT codes: `FAKE_NECK`, `NO_FVG`, `NO_SWEEP`, `CHASE`, `FAT_STOP`, `ALREADY_USED`, `SECOND_ON_SAME_BOX`, `VENUE_UNHEALTHY`, `DAILY_KILL`. `HOLIDAY` and `LIVE_OFF` are not blocks. A realised plus open loss at or beyond 6% of stake is `DAILY_KILL`.

Kill on the desk asks for confirmation, cancels a working limit, records a reduce-only flatten intent (still `LIMIT`, not market), and mutes the book for the day.

## Chart

Marks are placed on the candles that created them:

- orange — sweep wick, from the sweep forward
- white — neck, from the sweep to the smash
- purple — FVG box, from the first candle of the gap
- amber — MSS, the smash candle (close back through the sweep body)
- sky — BOS, the smash close through the neck. Without that close the smash is not complete and the pair does not arm
- green — entry, from the bar after the smash
- red — stop
- blue — 0.04% target
- grey dashed — last price when it is not inside the zone

MSS is the smash candle. BOS is the same candle when its close breaks the neck, and that close is now required before the smash counts.

30m candles and the 1h MA5 are context. The MA5 only feeds `entry_cap`. It does not block a direction. 3m is used only when a 5m candle is missing.

`pine/choke_watcher_v1.pine` is an optional mirror. If it disagrees with the engine, the engine wins. The study does not place orders.

## Venues and pings

`packages/venues` exposes one adapter interface and in-memory MEXC and KuCoin order stubs. `active_venue` picks which stub the server constructs. Neither stub opens an order socket.

The desk subscribes once to the public MEXC contract websocket (`wss://contract.mexc.com/edge`) for 5m, 1h, and last price, after a single REST backfill. Structure uses closed 5m bars only. A close older than 2 seconds does not fire. Last price updates the zone and does not arm. KuCoin has no public candle feed in this repo, so the tape is MEXC. There is no per-tick REST poll and no model call on the fire path.

`packages/notify` is a `Notifier` interface plus a console and file stub (`logs/notify.log`). The same interface is where a Telegram sender would plug in. Pings debounce for five minutes per pair per state: one FORMING, one ARM, one DONE / EXPIRED / SPIT.

## Fixtures

`fixtures/` is Balazs's labeled set. Do not edit decisions or labels. Replace `fixtures/fixtures.jsonl` with another JSONL of the same shape and run:

```bash
npm run score-fixtures
```

A row is scored only when the id contains `YYYY-MM-DD` and `entry_time_uk` is set. The clock is Europe/London. The engine sees closed 5m bars up to that bar's close, plus 1h context. It does not build a 3m or 2m series when 5m is continuous. Undated rows are listed and left unscored.

The latest run fired 2 of 18 dated rows. The nine green takes are 3m or 2m labels. On 5m at the entry bar they were `CHASE`, `NO_FVG`, `FAKE_NECK`, `FAT_STOP`, or `FORMING`, so they did not arm. One warn row armed, and one hard skip armed, because a clock is not a spit reason. The score is `logs/fixture-score.json`.

## Out of scope

Discretionary AI, grids, scale-in, and flipping the same pair on the same day. Live MEXC sends exist only behind the start button, and only as LIMIT orders with a stop and a target.
