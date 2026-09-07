# Local BTC 15-minute market data on Windows ARM64

The downloader was run successfully on `win32/arm64` using the project's existing
Node.js and `better-sqlite3` installation. It makes public GET requests only, loads
no trading credentials, and never starts the trading bot. No additional packages
are needed on this machine.

## Dataset downloaded

Output directory: `data/market-history/`.

| File | Contents |
|---|---|
| `history.sqlite` | Indexed SQLite database, including raw JSON for every source entity |
| `trades.csv` | Individual exchange executions: timestamp, YES/NO dollar prices, fractional contract quantity, taker side, source, raw JSON |
| `candles_1m.csv` | One-minute OHLC for YES bid, YES ask and trade price, plus volume/open interest |
| `trade_bars_1s.csv` | Derived trade-price OHLC/VWAP/volume, only for seconds containing executions |
| `markets.csv` | Market identity, open/close times, strike and settlement result; complete metadata/rules in raw JSON |
| `stream_events.csv` | Separately recorded live events; currently header-only because authenticated capture has not run |
| `download-summary.json` | Run options, actual row counts and limitations |

The initial run completed **39,193 individual trades**, **15 candles**, and **898
occupied one-second bars** from market `KXBTC15M-26SEP051745-45`. The trade timestamps
span September 5, 2026, 21:30:00.283773–21:44:59.892362 UTC. Their quantities sum to
**2,355,362.25 contracts**, matching the market's reported volume. SQLite integrity
check passed and there were no missing/out-of-range YES trade prices.

This exceeds the requested 5,000 execution rows because downloads finish an entire
market. It is still **one independent settled market**, not 39,193 independent bot
outcomes. The current SQLite file is roughly 26 MB and the trades CSV roughly 18 MB;
actual sizes vary by trading activity, and thousands of markets can consume substantial
disk space. Data stays separate from `data/analytics.db` and `ml_features`.

## What history actually contains

- Public trade prints can be paginated at up to 1,000 rows per request. The downloader
  follows every cursor for each selected market, rather than treating the first page
  as the entire history. [Trade endpoint](https://docs.kalshi.com/api-reference/market/get-trades).
- Historical candles have a minimum interval of one minute. Bid/ask candles describe
  top-of-book summaries, not every quote or all depth levels.
  [Candle endpoint](https://docs.kalshi.com/api-reference/market/get-market-candlesticks).
- Older markets/trades move into a separate archive tier. The downloader fetches the
  current cutoff, discovers both market tiers as needed, routes trade time ranges,
  and uses the corresponding candle endpoint.
  [Historical data](https://docs.kalshi.com/getting_started/historical_data).
- The documented order-book REST endpoint returns a **current** aggregated book;
  I found no documented historical full-depth replay endpoint. The live WebSocket
  sends a snapshot followed by deltas, and requires authentication.
  [Current book](https://docs.kalshi.com/api-reference/market/get-market-orderbook),
  [live updates](https://docs.kalshi.com/websockets/orderbook-updates).

The one-second CSV is computed from actual trade timestamps. It does not fabricate
activity during empty seconds, interpolate one-minute candles, reconstruct historical
quotes, or contain BTC spot/index ticks. Original timestamp strings and raw JSON are
preserved; indexed millisecond timestamps truncate any submillisecond precision.
When executions share an identical timestamp, their ordering is not authoritative;
trade ID is a deterministic tie-breaker for derived OHLC.

## Download more

Run from this project directory in PowerShell:

```powershell
# At least 5,000 executions, finishing the last selected market (default).
node scripts/download-history.js --min-trades 5000 --markets 100

# Download 100 separate resolved markets, regardless of execution count.
node scripts/download-history.js --markets 100 --min-trades 0

# Download up to 1,000 or 5,000 resolved market windows.
node scripts/download-history.js --markets 1000 --min-trades 0
node scripts/download-history.js --markets 5000 --min-trades 0

# Select markets by UTC close date, using a separate output directory.
node scripts/download-history.js --markets 1000 --min-trades 0 --from 2026-08-01 --to 2026-09-01 --out data/august-history

# Rebuild CSVs locally, without requesting market history again.
node scripts/download-history.js --export-only
```

`--markets` is a maximum selected-market count. `--min-trades 0` disables early
stopping on the execution target. `--from`/`--to` select close times (date-only means
midnight UTC); the complete open-to-close trade window is downloaded for each match.
Default selection ends at the current time and includes only resolved YES/NO markets.
The downloader visits the recent tier before the archive, and sorts each returned
page by close time; it does not assume an undocumented globally sorted archive.

Requests are spaced at least 250 ms apart by default, with bounded retries for 429,
server and connection errors. `--delay-ms 500` makes them slower. Existing completed
datasets are skipped; partially downloaded pages are safe to re-fetch because trade
IDs deduplicate. Re-running a completed query after new settlements may select newer
markets, so the database can grow beyond a previous run's selected-market limit.
Exports include everything accumulated in that output directory. Use separate output
directories for fixed study datasets. An unmet nonzero execution target exits with
code 2 and is identified in the summary; network/validation errors exit with code 1.

Package aliases are `npm run data:download -- ...`, `npm run data:export`, and
`npm run data:record -- ...`. Direct `node` commands avoid this machine's broken npm
launcher. A fresh Windows installation needs ARM64 Node and a matching native SQLite
binary; do not copy `node_modules` from another OS/architecture.

## Capture bids and depth going forward

Create `.env.history` from `.env.history.example` with a newly provisioned data-access
key and its private-key path. The recorder uses this separate file, never `.env`,
and subscribes only to `orderbook_delta`, `trade`, and `ticker` public data channels.
It cannot place orders. Authentication/signing and storage are unit-tested; a live
authenticated capture has **not** been performed in this task.

```powershell
node scripts/record-market-history.js --env .env.history --seconds 3600
# Later export captured events:
node scripts/download-history.js --export-only
```

The recorder retains every received snapshot/delta/trade/ticker message as raw JSON
with receipt time, available exchange timestamp, session, subscription ID and sequence.
It flushes batches every 500 ms or 500 messages. It refreshes active markets, reconnects
after disconnection, and logs sequence gaps instead of silently claiming continuous
coverage. A reconnect obtains fresh snapshots. `stream_events` is an event tape;
order-book reconstruction and one-second quote sampling are not implemented here.
Snapshots contain aggregated price levels, not identities of every individual order.
An abrupt process/power loss can lose the unflushed in-memory batch.

## Read it from the bot or SQLite

```sql
-- In a separate research connection, read the downloaded trade history:
ATTACH DATABASE 'data/market-history/history.sqlite' AS history;
SELECT ticker, created_time, yes_price, no_price, contracts, taker_side
FROM history.trades ORDER BY created_ms LIMIT 1000;

-- Read a market's one-minute bid/ask history:
SELECT ticker, end_period_ts, yes_bid_close, yes_ask_close, price_close, volume
FROM history.candles ORDER BY ticker, end_period_ts;

-- Trade-derived one-second bars:
SELECT * FROM history.trade_seconds ORDER BY ticker, second_ts;
```

Prices are dollars/probabilities (0–1); quantities can be fractional. CSVs have a
header and standard quoted JSON fields and can be imported into SQLite with CSV
mode. Raw source text that could execute as a spreadsheet formula is prefixed with
an apostrophe in CSV only; SQLite retains the original text.

Do not insert these market prints directly into the bot's `ml_features` table or
count them as the bot's own wins/losses. Backtesting requires reconstructing what
was knowable at entry, aligned BTC spot/reference data, and fill/fee assumptions.
Market settlement results and final metadata are labels/future information, not
features available at trade time. Split evaluations by time and whole market so
trades from the same resolution cannot appear on both sides of a split.
