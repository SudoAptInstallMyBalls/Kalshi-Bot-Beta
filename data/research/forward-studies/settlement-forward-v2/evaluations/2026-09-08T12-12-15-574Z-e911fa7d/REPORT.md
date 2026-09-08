# Settlement model comparison

Policy declared before the fixed evaluation cutoff; results are as-of replays on subsequently settled markets. Forecasts within markets are correlated. Proxy assumes opening basis persists, with trailing absolute residual stress; 95th percentile is empirical, not a guaranteed confidence bound. Historical settlement_ts is assumed public availability, not local historical receipt time. BRTI observations require both event and receipt timestamps. Proxy cannot observe the final settlement minute.

| Model | Common forecasts | Brier |
|---|---:|---:|
| rawTerminal | 315 | 0.206918 |
| proxyTerminal | 315 | 0.182307 |
| proxyAverage | 315 | 0.183141 |
| marketMidpoint | 315 | 0.181751 |

Trading simulation keeps the account risk latch. Forecast evaluation continues over eligible markets independently.

legacyBaseline: 1 trades, normal P&L -0.220, adverse P&L 0.000.
proxyAverageRobust: 0 trades, normal P&L 0.000, adverse P&L 0.000.

Fresh data must be after 2026-09-08T00:45:00.000Z. No live promotion.

See report.json for fixed-time coverage, calibration bins, temporal blocks, source hashes and risk rejection counts.