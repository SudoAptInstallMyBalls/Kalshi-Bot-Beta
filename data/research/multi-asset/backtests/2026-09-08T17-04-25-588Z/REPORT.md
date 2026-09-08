# Five-asset retrospective backtest

Retrospective minute-resolution replay. Same fixed BTC percentage-volatility floor and strategy thresholds across assets. Trailing calibration uses only outcomes with settlement_ts <= decision time. Next-minute simulated fills use bid/ask candles, fees, volume participation and adverse extrema, not actual depth or queue position. Historical settlement_ts is assumed availability. Coinbase and Binance are not the official index. Per-asset P&Ls are not a portfolio backtest. Repeated market forecasts are correlated. No ML training or live promotion.

Test period uses the final 12 days. Each strategy/asset starts with $100 in this block. Lower Brier is better.

| Asset | Test markets scored | Raw Brier | Proxy-average Brier | Market Brier | Baseline trades / net P&L | Robust trades / net P&L |
|---|---:|---:|---:|---:|---:|---:|
| BTC | 1144 | 0.18173 | 0.17599 | 0.17400 | 91 / $-7.63 | 1 / $-0.34 |
| ETH | 1144 | 0.17232 | 0.17017 | 0.16622 | 54 / $-6.80 | 1 / $-0.22 |
| SOL | 1144 | 0.16876 | 0.16935 | 0.16677 | 19 / $-0.99 | 3 / $-1.09 |
| XRP | 1144 | 0.16948 | 0.16849 | 0.16336 | 14 / $-0.12 | 0 / $0.00 |
| DOGE | 1143 | 0.16575 | 0.16448 | 0.16149 | 23 / $-1.43 | 0 / $0.00 |