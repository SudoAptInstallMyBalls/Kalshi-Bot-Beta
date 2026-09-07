# Bot repair and evaluation — September 6, 2026

The implementation is more robust, but a profitable strategy has **not** been demonstrated. No live orders were placed. No candidate was promoted from research to live trading.

## Results on recorded data

All 1,500 downloaded markets passed candle and BTC-reference coverage checks.

| Full-history simulation, $100 start | Earlier code | Corrected code |
|---|---:|---:|
| Completed simulated trades | 89 | 91 |
| Normal net P&L | -$24.67 | -$15.53 |
| Adverse-fill net P&L | -$35.38 | -$23.45 |
| Normal maximum realized drawdown | 25.63% | 16.64% |

These are minute-resolution simulations with assumed fills. Smaller losses reflect changed sizing and costs as well as slightly different trade selection; they are not evidence of improved forecasting. Only 91 labeled outcomes exist for the corrected baseline, so the 300-example training floor remains unmet.

The original loss breakdown was 37 stop exits totaling -$50.38 and 52 scalp exits totaling +$25.71. Corrected replay diagnostics show entry filtering, rather than missing data, limits trading. All 70 rejected entry attempts in the corrected full replay exceeded the simulated next-minute entry limit; none were rejected for cash balance or volume capacity. These counts do not prove the next-minute fill model matches actual execution.

## Fixed comparison

Eight candidates were declared before evaluation: corrected baseline, no trend boost, 75% and 50% model/market probability blends, an eight-minute entry window, ten-point and twenty-point edge thresholds, and scalping disabled. Each used the same starting research balance and fee assumptions.

Markets were divided chronologically into 900 training, 300 validation and 300 final-test markets. Candidate selection required sufficient trades and positive training, validation and stressed-validation P&L. **None qualified.** The baseline diagnostic on the final block lost $7.96 normally and $13.92 under adverse fills. Aggregate results on the overall history had already been inspected, so these are retrospective time-block checks, not a pristine unseen-data claim.

The evaluation artifacts live under `data/research/evaluations/2026-09-06T07-08-59-400Z-070155d5/`. New forward evaluation data must be later than **2026-09-06 03:00:00 UTC**, the final market close in this snapshot. Do not choose a parameter set because it looks best on repeated runs of these same test markets.

## Repairs

- Kelly now uses `(probability - cost) / (1 - cost)` for the fraction of bankroll at risk, followed by fractional sizing and existing caps. Cost uses the actual entry price plus estimated entry fees. Trend-adjusted edge is never interpreted as an entry price.
- Order sizes and final risk checks include estimated entry fees. Net estimated edge must remain positive after the entry fee; fee rates are explicit configuration rather than implied claims about a series fee schedule.
- Entry and exit execution preserve fractional-cent dollar quotes instead of rounding them to whole cents before constructing the API payload.
- Immediate placement fills become tracked positions exactly once. Later partial fills are incremental, including after an upgrade from older persisted pending records.
- Stale entry cancellation rechecks the same order and preserves late fills and actual cost basis. It refreshes account balance instead of granting a guessed refund. Partially filled resting entries also age out.
- Entry submission intent and client ID are persisted before POST. Unknown responses remain tracked and block subsequent entries. Exits wait for pending entry orders to resolve. Shutdown waits for the order poll to finish.
- Stale spot data blocks entries, and the REST fallback uses the same configured currency pair as the websocket. Venue/index basis differences still require empirical assessment.
- Required state writes now fail visibly and stop new entries on errors. Corrupt saved positions cannot silently be overwritten by an empty startup state.
- The ML median split now assigns equal feature values consistently during fitting and inference. Zero-valued quotes remain zero during feature extraction.
- ML labels record when their outcomes became known. Training keeps contracts separate across chronological splits and purges overlapping outcome times. Legacy labels with unknown timing and older model validation schemes are excluded from training/loading until valid data supports retraining.
- `.env` noncredential settings now use $5 maximum position, 0.08 Kelly fraction, one position per contract, `MIN_EDGE=10` and `MIN_DIVERGENCE=15`. They match the baseline defaults; they are not marketed as optimized settings. Credentials were not altered.
- The normal `backtest` command now uses recorded data. The legacy invented-price simulation is explicitly named `backtest:synthetic`.

## What remains

The minute replay cannot establish second-level execution quality, historical queue position or order-book depth. It does not reproduce the complete live multi-position orchestrator, all risk pauses, or ML-filtered portfolio execution. A changed strategy needs new forward data and realistic execution measurements before any claim of profitability.

The local model has insufficient real replay labels to train. Increasing trade frequency or lowering the training floor simply to produce a model would not establish an edge. If future data supports a model, it remains research-only until separately evaluated.

Credential rotation and a 24–48-hour demo burn-in remain unperformed. Portfolio mismatches and uncertain submissions halt for account reconciliation; automated recovery from arbitrary external/account changes is not claimed. The live account integration, its fee schedule and balance/reservation behavior still need authenticated demo validation. No funded-account experiment was run.

## Commands

Verification: 57 automated tests pass. A 1,000-signal, 100-stump inference benchmark measured 0.012 ms mean and 0.088 ms p99 per signal, with zero synchronous database reads on the cached scoring path. These are local benchmark results, not exchange latency measurements.

```powershell
node --test test/*.test.js
node scripts/replay-history.js
node scripts/evaluate-strategies.js
```

After adding future history, use `node scripts/replay-history.js --download-spot` to align the new reference data. See `RESEARCH_WORKFLOW.md` for all assumptions and output locations.
