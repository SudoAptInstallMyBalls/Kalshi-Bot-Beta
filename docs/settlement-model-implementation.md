# Settlement model implementation and operation

Implemented September 7, 2026. This change fixes reference handling and adds controlled evaluation. It does not establish a profitable strategy.

## Runtime behavior

`SETTLEMENT_AWARE` defaults to true in runtime configuration. New entries require an authorized, fresh `CFB:BRTI` reference and an official Kalshi floor strike with `greater_or_equal` metadata. An unavailable index produces an explicit entry-block reason. Exits and account risk limits retain their existing paths. No bot process was started or restarted during implementation.

The live path does not use the research proxy. It reads the index directly, computes the distribution of the arithmetic mean of 60 one-second observations in [close-60 seconds, close), and rounds settlement to cents. Observations already received in this window are fixed; future observations use a driftless additive diffusion approximation with their covariance included. Missing elapsed-window observations block the forecast; future or not-yet-received observations cannot be used. The expected future price is modeled, not known.

Signal generation and the final execution risk check reject stale index references (older than 3 seconds). Historical index databases and proxy forecasts cannot authorize live entries. Probability blending cannot erase a reference uncertainty band. Sizing and cost-inclusive entry thresholds use conservative side probabilities. Polymarket signals are excluded in this mode because an equivalent settlement target has not been validated. Forecast source, timestamp, sigma and reference price also travel with the signal into ML feature extraction and telemetry.

Official-strike discovery no longer substitutes the current Binance price when the strike is absent. An absent target blocks entries instead.

## Connect an authorized index feed

An actual BRTI entitlement/provider connection is not present in this workspace. The software includes a provider-neutral JSONL recorder, but it cannot create a data license or authenticate to an unspecified provider. This is the remaining external setup requirement.

Have the authorized provider adapter emit one JSON object per line with these fields:

- `source`: exactly `CFB:BRTI`.
- `timestamp`: the provider's Unix event timestamp in milliseconds on exact one-second boundaries.
- `price`: a positive numeric BRTI value in USD.

Do not floor arbitrary 200ms timestamps or label another venue's prices BRTI. The adapter must supply the one-second index observations corresponding to the settlement sampling convention. The recorder validates the data shape, not the publisher's identity; it belongs behind your trusted provider adapter.

Pipe that adapter's stdout into:

```powershell
node scripts/record-settlement-index.js
```

The recorder stamps receipt time itself in live mode. It writes `BOT_DATA_DIR/settlement-index.sqlite`, or `data/settlement-index.sqlite` if BOT_DATA_DIR is absent. Use `--out` for another location and set `SETTLEMENT_INDEX_DB` to the same absolute path for the bot. The bot needs 16 contiguous completed minute endpoints for its 15-return volatility estimate (roughly 16–17 minutes from a cold start). The index can keep recording while the bot runs; reads use SQLite WAL. Conflicting revisions at a timestamp are rejected rather than silently replacing an earlier observation.

For authorized historical observations, each line must also include the true `received_ms` timestamp (at or after its event timestamp):

```powershell
node scripts/record-settlement-index.js --historical --input authorized-brti.jsonl
```

This writes a separate `settlement-index-history.sqlite`. Historical and live records cannot be mixed in one database. Do not fabricate receipt timestamps. A historical file cannot serve as the live entry feed.

`SETTLEMENT_AWARE=false` retains the old strategy path for explicit legacy diagnostics; it disables these reference requirements and is not the recommended live configuration. No existing private .env file was edited.

## Shared volatility

Live and replay use the same function: the population variance of 15 completed one-minute log returns, scaled to the requested horizon, with the same 900-second volatility floor. Gaps and insufficient history produce unknown volatility rather than a fallback estimate. Live BRTI uses index endpoints; historical proxy replay uses Binance trade closes. The legacy live Binance feed uses minute endpoints of sampled quote midpoints. Their statistical estimator is identical, but these distinct underlying observations should not be described as identical data.

## Controlled research

### Coinbase Shadow Settlement Evaluation

The evaluation pipeline supports `--coinbase-shadow <db-path>` to benchmark settlement forecasts and settlement calculations against external, high-frequency Coinbase BTC-USD ticker data.

```powershell
node scripts/evaluate-settlement-models.js `
  --index-db data/history/settlement-index.sqlite `
  --coinbase-shadow data/history/coinbase.sqlite `
  --forward-after 2026-09-01T00:00:00.000Z
```

```powershell
node scripts/evaluate-settlement-models.js
```

The command creates a new directory under `data/research/settlement-evaluations/`, containing `REPORT.md`, `report.json`, and all timestamped `forecasts.jsonl`. Read snapshots and hashes preserve market, candle, spot and code provenance. Existing reports are preserved.

Models are the old mixed-reference terminal model, Binance opening-return terminal proxy, averaging proxy, and market midpoint. The proxy reference at time t is `Kalshi strike * Binance(t) / Binance(open)`. It does not use that market's eventual expiration value. Proxy error bands are the trailing 95th percentile of absolute settlement residuals from at most 256 prior published settlements, requiring at least 100 observations within seven days. These fixed choices were not optimized. The interval is an empirical stress range, not a guaranteed coverage bound. Earlier settlements are included only after their saved exchange settlement_ts; actual historical collector receipt times are unavailable and this availability assumption is disclosed in the report.

Forecast scoring covers fixed minutes 1, 2, 3, 4, 8, 12, 13 and 14 independently of the account risk latch. Four-model common-cohort scoring excludes minute 14 because the Binance proxy cannot observe the already-started official settlement window. A separate terminal comparison includes minute 14. Reports include Brier score, log loss, calibration bins, matched-cohort sizes, temporal blocks, and per-minute coverage. Repeated forecasts of one market are correlated and are not independent statistical trials.

The separate normal/adverse trading simulations preserve the drawdown stop. The research base config remains the historical baseline; this command explicitly selects baseline versus settlement-aware proxy simulation. The proxy is never selected for live promotion.

To compare authorized BRTI history:

```powershell
node scripts/evaluate-settlement-models.js --index-db data/settlement-index-history.sqlite
```

The official-index comparison reports its own common cohort and missing-data reasons; it does not quietly replace missing index observations with Binance. The index read snapshot is frozen for the research run.

For later data, preserve the current cutoff rather than choosing it after viewing results:

```powershell
node scripts/evaluate-settlement-models.js --forward-after 2026-09-07T00:15:00Z
```

The `forward` section scores markets opening at or after that cutoff. It is empty until the historical databases contain those markets. Fresh data still needs to be collected; elapsed future time cannot be backtested today.

## Results and checks

For the current free Coinbase collector, frozen forward study, and separate threshold/volatility experiments, see [Free forward study](free-forward-study.md). The results below describe the original implementation run.

The completed run scored 15,674 valid fixed-time forecasts. The four-model matched cohort contains 14,225 forecasts across 2,047 markets:

| Model | Brier |
|---|---:|
| Original mixed-reference terminal | 0.201489 |
| Binance opening-return terminal | 0.174358 |
| Binance opening-return averaging | 0.174548 |
| Market midpoint | 0.173173 |

The guarded proxy generated one trade: normal P&L -$0.340, adverse P&L -$0.682. The legacy baseline generated 121 trades and normal P&L -$9.765. Fewer losses with almost no trades is not demonstrated trading alpha. These are retrospective results on already-inspected data; the official-index strategy still needs actual index observations and forward validation.

All 95 tests passed, including volatility parity, partial-average variance, settlement rounding, missing/late/future samples, immutable index observations, historical/live separation, causal calibration, uncertainty guarding, execution freshness and forecast scoring after an actual simulated risk latch. No orders, credentials, licenses, or external messages were submitted.
