# Local history integration (Windows ARM64)

From the project folder, run:

```powershell
node scripts/replay-history.js --download-spot
```

This downloads public Binance BTCUSDT minute candles covering your settled Kalshi markets plus three hours of warmup, caches them locally, replays the markets, and writes a labeled research dataset and report. It does not start the server, load API credentials, or place orders. No new dependencies were added.

After downloading more Kalshi markets, run the same command again. Complete reference chunks are reused; missing chunks are fetched again. Each replay gets a new run ID so results from different configurations remain separate. To replay entirely offline once reference data is cached:

```powershell
node scripts/replay-history.js
```

The npm aliases are `research:prepare` and `research:replay`. `npm run backtest` now runs the recorded-data replay. The older invented-price simulation is explicitly named `backtest:synthetic` and should not be used to assess recorded markets.

## Files and connections

- `data/market-history/history.sqlite`: original Kalshi data, opened read-only.
- `data/research/research.sqlite`: reference candles, replay run metadata, simulated labeled outcomes. Tables: `spot_candles`, `replay_runs`, `replay_samples`.
- `data/research/latest-report.json`: latest completed run pointer/details.
- `data/research/runs/<run ID>/REPORT.md`: readable results.
- In the same run directory: `report.json`, `samples.csv`, and, when enough outcomes exist, `research-model.json`.

The shared `SignalGenerator` supplies directional entries and exits, `ProbabilityModel` supplies probabilities and existing sizing math, and `MLPipeline.extractFeatures()` supplies the same 27 features used by the bot. A historical clock is passed explicitly to the signal/exit generator; live callers retain their normal clock.

The replay trains the existing stump model once at least 300 filled, closed simulated trades exist. Until then the report states the shortfall. The threshold is total labeled examples before the 70/15/15 split. Each market contributes at most one attempted entry and one labeled trade, and nonoverlapping markets are processed chronologically. Labels must resolve before the next retained signal. Normalization and fitting use only the oldest training slice. Validation and test metrics include accuracy and Brier score, with constant-0.5 and training-win-rate baselines.

Research models carry a `usage: research` marker. The live loader rejects them even if accidentally copied over a live model. No simulated rows are inserted into `analytics.db`; simulated profit labels are not claims about actual fills. Training is exercised in isolated fixtures; with the initial 100-market real download only 24 filled simulated trades existed, so no real-data model was trained.

## Configuration and limits

`research-config.json` explicitly specifies the research settings. It does **not** read `.env`. The live `.env` maximum position and Kelly fraction have now been aligned to the research defaults ($5 and 0.08), with one position per contract and 10/15 edge thresholds. Change the research JSON or pass `--config path/to/config.json` for controlled experiments; each report captures the full configuration and relevant source hashes. Keep held-out data reserved when tuning: repeated inspection of the same test set invalidates its role as a final test.

Other options: `--history path/to/history.sqlite`, `--out path/to/research-directory`, `--help`. Always use a dedicated research output directory.

This is a minute-resolution research adapter, not a full simulation of the live two-second orchestrator:

- Only completed BTC and Kalshi candles enter a decision. Simulated execution is delayed to the following minute end. No final candle high/low is exposed to its own earlier decision.
- The normal scenario uses the following closing ask on entry (within the submitted price plus slippage allowance), and closing bid minus slippage on exit. The adverse scenario uses that minute's worst ask/bid. Adverse scenarios can select different trades and are not statistical confidence bounds.
- Trades require aggregate minute volume sufficient for the configured participation limit. This is an assumption about possible execution, not proof of book depth, queue position, fill probability or partial fills. Missing/invalid quotes cannot produce executions. There is no historical one-second order book here.
- Fees use a configurable quadratic rate (default 0.07) and cents rounded upward per simulated order. Confirm the appropriate historical series fee multiplier before interpreting profitability. Rounding rebates and per-fill allocation are not reconstructed.
- BTCUSDT is the directional spot input, not Kalshi's settlement index. Recorded Kalshi results determine settlement. Minute volatility and time-scaled minute EMA approximate the tick-based live indicators.
- Historical Polymarket inputs are absent, so the Polymarket strategy is disabled. Live risk circuit breakers, overlapping multi-position management and ML-filtered portfolio execution are not replayed. Only one attempted entry per market is allowed.
- Incomplete 15-minute candle sets, missing spot warmup/coverage, and overlapping or invalid market windows are rejected with audit counts. API download gaps raise errors and can be resumed.
- Maximum drawdown is measured on realized equity at trade closes; intratrade drawdown can be worse.

The source fields and public endpoint are documented by [Binance](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market) and its [market-data-only endpoint guide](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md). Fee assumptions are based on the [Kalshi fee schedule](https://kalshi.com/docs/kalshi-fee-schedule.pdf), with [rounding differences documented separately](https://docs.kalshi.com/getting_started/fee_rounding).

## Execution fixes included with this integration

Current [order fields](https://docs.kalshi.com/api-reference/orders/get-order) (`fill_count_fp`, dollar cost and fee fields) now normalize at the API boundary. Exit processing confirms the same order after cancellation, accounts for actual proceeds and fees, and persists unresolved order identities before retrying. An ambiguous submission blocks repeat exits and new entries until reconciled. Exit entry cost basis includes recorded entry fees; settlements include maker and taker components.

Quote refresh failures mark the retained market stale; signal generation and the final entry risk check reject stale quotes. Portfolio reconciliation now pages through [current position data](https://docs.kalshi.com/api-reference/portfolio/get-positions), compares signed quantities, preserves pending orders and cost information, and halts new entries on discrepancies rather than deleting local exposure or inventing zero-cost positions. Mismatched positions require manual reconciliation of the account's orders/fills before automated management resumes.

Settlement retry timers are deduplicated, capped at 60 attempts with backoff up to five minutes, and cleared on shutdown. Exhaustion halts new entries and logs the order needing attention. Pending entries are preserved until order tracking resolves them.

The follow-up repair corrected Kelly sizing to use the actual contract purchase price and entry fees. Sizing and the final risk check now budget for fees; entries require positive net estimated edge. Immediate entry fills, late fills on cancellation, uncertain submissions, stale spot prices and durable state writes also have regression coverage. The live risk overrides were aligned to the smaller research defaults. Credential rotation and the documented demo burn-in remain outstanding. No live trading or credentialed collector was run during these repairs.

ML labels now record `outcome_ts`. Live and research training group by market and purge outcomes unavailable before the next split. Legacy labels without known outcome timing are excluded; older model files must be retrained under the `market-outcome-v2` validation scheme. The additive database migration runs on the next normal database initialization. No live ledger was opened just to run research.

## Fixed strategy comparison

```powershell
node scripts/evaluate-strategies.js
```

This freezes eight candidates and a 60/20/20 chronological market split before evaluation. Selection requires at least 30 training trades, 30 validation trades, and positive training, validation and adverse-validation P&L. It writes `data/research/evaluations/<ID>/manifest.json`, `selection.json`, `report.json` and `REPORT.md`. The last 20% is evaluated only after selection; if nothing qualifies, the baseline is evaluated there as a diagnostic only. Nothing is promoted to live trading.

The first comparison selected no candidate. Previously inspected history is not a pristine holdout: use new data after the recorded `futureHoldoutAfter` timestamp to assess any subsequent change. Repeatedly tuning against the report would create selection bias; see [scikit-learn's evaluation guidance](https://scikit-learn.org/stable/modules/cross_validation.html).

## Verification

```powershell
node --test test/*.test.js
```

Tests exercise future-data exclusion, deterministic replay, missing data/liquidity rejection, reference download resume, training and live-model isolation, cancel/fill races, unknown submissions, fee accounting, stale quotes, portfolio pagination, and settlement timer lifecycle. The real 100-market dataset was also replayed locally on Windows ARM64.
