# Multi-asset economic diagnosis

Retrospective diagnosis only. Do not tune thresholds from the test block, promote a candidate, or submit orders. All costs are charged at entry; no fill probability, queue position, or depth is inferred from minute candles.

Test block only; lower Brier is better. Costs are estimated from minute candle asks, a 7% quadratic fee, and one cent slippage.

| Asset | Model Brier | Market Brier | Model-minus-market | Price-window rows | Net-positive rows | Threshold-qualified | Mean net edge |
|---|---:|---:|---:|---:|---:|---:|---:|
| BTC | 0.17599 | 0.16271 | 0.01328 | 7085 | 2018 | 605 | -3.52 pts |
| ETH | 0.17017 | 0.15526 | 0.01490 | 6516 | 1798 | 511 | -3.64 pts |
| SOL | 0.16935 | 0.15342 | 0.01593 | 6157 | 1802 | 491 | -3.67 pts |
| XRP | 0.16849 | 0.14995 | 0.01855 | 6331 | 1792 | 466 | -3.65 pts |
| DOGE | 0.16448 | 0.15023 | 0.01425 | 6440 | 1750 | 495 | -4.01 pts |

Combined model Brier: 0.16969; market Brier: 0.15429.
Combined estimated net-positive opportunities: 9160/32529; threshold-qualified: 2568; mean net edge: -3.70 points.

The threshold diagnosis is descriptive on inspected data. It does not establish fill probability, live profitability, or a basis for changing thresholds.