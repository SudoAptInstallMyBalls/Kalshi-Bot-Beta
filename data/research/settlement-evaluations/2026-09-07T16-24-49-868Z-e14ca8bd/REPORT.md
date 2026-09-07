# Settlement model comparison

Retrospective data already inspected. Forecasts within markets are correlated. Proxy assumes opening basis persists, with trailing absolute residual stress; 95th percentile is empirical, not a guaranteed confidence bound. Historical settlement_ts is assumed public availability, not local historical receipt time. BRTI observations require both event and receipt timestamps. Proxy cannot observe the final settlement minute.

| Model | Common forecasts | Brier |
|---|---:|---:|
| rawTerminal | 14670 | 0.200839 |
| proxyTerminal | 14670 | 0.174408 |
| proxyAverage | 14670 | 0.174596 |
| marketMidpoint | 14670 | 0.173202 |

Trading simulation keeps the account risk latch. Forecast evaluation continues over all eligible markets independently.

legacyBaseline: 121 trades, normal P&L -9.765, adverse P&L -10.410.
proxyAverageRobust: 1 trades, normal P&L -0.340, adverse P&L -0.682.

Fresh data must be after 2026-09-07T16:15:00Z. No live promotion.

See report.json for fixed-time coverage, calibration bins, temporal blocks, source hashes and risk rejection counts.