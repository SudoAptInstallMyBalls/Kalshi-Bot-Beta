# ETH, SOL, XRP and DOGE research collection

This is an exploratory data collection pipeline, not a trading bot or a frozen
forward study. It runs alongside BTC v3. All new implementation lives under
`scripts/multi-asset`; BTC source, package files and frozen declarations are not
modified. The recorder/book/spot modules are explicit research forks of the BTC
collectors to avoid invalidating the active study. Future fixes must be tested
against both implementations.

## Verified mappings

Verified against public Kalshi and Coinbase APIs on September 8, 2026:

| Asset | Kalshi series | Coinbase live proxy | Binance historical proxy |
|---|---|---|---|
| ETH | KXETH15M | ETH-USD | ETHUSDT |
| SOL | KXSOL15M | SOL-USD | SOLUSDT |
| XRP | KXXRP15M | XRP-USD | XRPUSDT |
| DOGE | KXDOGE15M | DOGE-USD | DOGEUSDT |

Current market rules compare the 60-second average of the asset's CF Benchmarks
RTI before expiration against the corresponding opening average. Equality
resolves Yes in the inspected contracts. The downloader preserves full market
JSON and series metadata, including rules, fees and settlement-source links.
Review those rules before modeling. Neither Coinbase USD nor Binance USDT is
the official settlement index; their basis differences must be measured.

Kalshi separates recent and historical data:
https://docs.kalshi.com/getting_started/historical_data

## Start collecting

Run these from `C:\Users\imadr\Desktop\kalshibot-main`. Existing dependencies
are sufficient; no API keys or account permissions are required.

In a new PowerShell window, keep the four live proxy recorders running:

```powershell
node scripts/multi-asset/run.js record
```

One startup JSON line is expected. Leave that window open and the computer
awake with Internet access. Ctrl+C stops all four new recorders and removes
their PID lock. It does not stop BTC. A duplicate recorder invocation fails
instead of opening duplicate writers. A stale PID lock is checked at startup.

In a second window, download seven days of history, then refresh the latest day
every 30 minutes:

```powershell
node scripts/multi-asset/run.js download --days 7
while ($true) {
  node scripts/multi-asset/run.js download --days 1
  Start-Sleep -Seconds 1800
}
```

Use only one download loop. Backfill is resumable: complete market candle sets
and complete spot chunks are skipped. Failed assets are reported independently;
rerun the command to resume. `--days` supports 1–90; seven days is a starting
dataset, not a readiness threshold. The requested range is rolling, and settled
markets less than two minutes old are excluded. Missing candles remain reported
as incomplete; no synthetic Kalshi prices are inserted. Historical candles
cannot reconstruct past second-level quotes or prove executable fills.

Check collection in another terminal:

```powershell
node scripts/multi-asset/run.js status
```

For each asset, inspect quote sample counts and age, latest health event, and
download completeness. Roughly 60 book samples per minute indicates frequent
updates. Ticker samples can be sparser when trades are quiet. A running process
alone is not evidence of coverage. The recorder preserves event and receipt
timestamps, tolerates at most 500ms future skew, rejects stale messages, and
reports health in SQLite. It does not print every tick.

## Files produced

Each asset has its own directory under `data/research/multi-asset/ASSET/`:

- `history.sqlite`: settled Kalshi metadata/outcomes and one-minute candles.
- `spot.sqlite`: completed Binance one-minute candles with availability times.
- `coinbase.sqlite`: live first-per-receipt-second ticker and book samples,
  original timestamps, asset-specific source labels, and connection/health events.
- `series.json`: timestamped series metadata and settlement/fee references.
- `download.json`: last successful download summary, including incomplete markets.

No data is written to BTC databases. Live proxy data starts when recording starts;
historical downloads cannot recover missed live observations.

## Remaining work before these are evaluated or traded

1. Audit coverage, missing intervals, strikes, outcomes, equality rules and
   settlement averages for each asset. Measure Coinbase/Binance basis against
   official outcomes; obtain official index observations if exact settlement
   replication is needed.
2. Parameterize the evaluation and replay engines. Audit BTC-specific symbols,
   price scales, rounding and minimum volatility assumptions; retain sub-dollar
   precision for XRP/DOGE. The collection code does not yet compute their Brier
   scores or simulated P&L.
3. Build each asset's volatility and basis calibration using only information
   available at decision time. Gate live samples by BOTH original timestamps,
   as BTC v3 does; do not treat receipt-second buckets as exact availability.
4. Compare against that asset's contemporaneous market probability on identical
   rows. Split by time and whole markets, report coverage and independent outcome
   counts, and keep exploratory tuning separate from held-out evaluation.
5. Simulate spreads, applicable fees, tick sizes, depth, latency, partial fills
   and adverse execution. Historical minute quotes alone cannot establish fill
   quality; add prospective Kalshi order-book recording where needed.
6. Report qualifying signals and rejection reasons, trades, net returns,
   drawdowns and uncertainty separately per asset. Account for trying multiple
   assets/models when assessing apparent winners.
7. Freeze a new multi-asset declaration with source hashes and a future cutoff
   once evaluation policies are ready. These historical downloads and live
   recordings are exploratory; do not relabel them as an untouched forward test.
8. Test portfolio exposure limits and correlated simultaneous signals across
   BTC and the other assets. Any eventual live integration also needs asset
   routing, contract sizing, order reconciliation and restart/risk tests. No
   live integration or order submission is enabled by this collector.

## Economic diagnosis

The separate `multi-asset-diagnostic-v1` declaration and `scripts/multi-asset/diagnose.js`
use the test block from the latest five-asset backtest. They compare probability
calibration and Brier/log loss with the contemporaneous Kalshi midpoint, then
charge the displayed ask a 7% quadratic fee and one cent of slippage. This is a
cost diagnostic, not a new trading policy. Run it with:

```powershell
node scripts/multi-asset/diagnose.js
```

The output is written under `data/research/multi-asset/diagnostics/` and records
the source backtest hash and declaration. It does not alter any study or enable
orders.

## Five-asset 60-day backfill

Run: node scripts/multi-asset/backfill.js

This includes BTC in its own exploratory directory and does not touch BTC v3.
The first invocation saves a fixed 60-day range in backfill-request.json. Reruns
resume that same range. Each asset gets backfill.json and the overall result is
backfill-summary.json. The downloader checks exact 15-minute candle coverage,
fetches both Kalshi history stores, and downloads aligned one-minute Coinbase
spot prices into `spot-coinbase.sqlite` with three hours of warm-up. Coinbase
omits minutes without an exchange candle; those gaps are preserved and reported.
The prior
Binance database is left untouched for reproducibility. Market counts can be below the number
of scheduled slots; absent markets are not synthesized. A complete candle set
can still contain null bid/ask values, which evaluation must reject.

This is the minute-resolution dataset for initial backtesting, not all possible
historical data. It excludes historical depth, queue position, local receipt
times, and the official second-level CF Benchmarks index. No claim of executable
fills or a profitable strategy follows from downloading it. Do not run another
historical downloader against these databases simultaneously.

After the Coinbase backfill succeeds, run the corrected replay and the separate
train-only calibration experiment:

```powershell
node scripts/multi-asset/backtest.js
node scripts/multi-asset/calibrated-experiment.js
```

If the Coinbase endpoint is unavailable, the command reports the failed asset
and leaves the old Binance files intact. Rerun it later to resume the separate
Coinbase databases.
