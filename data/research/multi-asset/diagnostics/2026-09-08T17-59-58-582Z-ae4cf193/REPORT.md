# Multi-asset economic diagnosis

Retrospective diagnosis only. Do not tune thresholds from the test block, promote a candidate, or submit orders. All costs are charged at entry; no fill probability, queue position, or depth is inferred from minute candles.

Test block only; lower Brier is better. Costs are estimated from minute candle asks, a 7% quadratic fee, and one cent slippage.

| Asset | Model Brier | Market Brier | Model-minus-market | Price-window rows | Net-positive rows | Threshold-qualified | Mean net edge |
|---|---:|---:|---:|---:|---:|---:|---:|
| BTC | 0.17672 | 0.16271 | 0.01400 | 7085 | 2076 | 612 | -3.51 pts |
| ETH | 0.17135 | 0.15526 | 0.01608 | 6516 | 1900 | 530 | -3.63 pts |
| SOL | 0.17000 | 0.15342 | 0.01658 | 6157 | 1756 | 483 | -3.63 pts |
| XRP | 0.16834 | 0.14995 | 0.01839 | 6331 | 1705 | 429 | -3.62 pts |
| DOGE | 0.16271 | 0.14830 | 0.01441 | 3324 | 970 | 323 | -3.98 pts |

Combined model Brier: 0.17057; market Brier: 0.15450.
Combined estimated net-positive opportunities: 8407/29413; threshold-qualified: 2377; mean net edge: -3.64 points.

The threshold diagnosis is descriptive on inspected data. It does not establish fill probability, live profitability, or a basis for changing thresholds.