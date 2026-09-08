# Five-asset retrospective backtest

Retrospective minute-resolution replay. Same fixed BTC percentage-volatility floor and strategy thresholds across assets. Trailing calibration uses only outcomes with settlement_ts <= decision time. Next-minute simulated fills use bid/ask candles, fees, volume participation and adverse extrema, not actual depth or queue position. Historical settlement_ts is assumed availability. Coinbase and Binance are not the official index. Per-asset P&Ls are not a portfolio backtest. Repeated market forecasts are correlated. No ML training or live promotion.

Test period uses the final 12 days. Each strategy/asset starts with $100 in this block. Lower Brier is better.

| Asset | Test markets scored | Raw Brier | Proxy-average Brier | Market Brier | Baseline trades / net P&L | Robust trades / net P&L |
|---|---:|---:|---:|---:|---:|---:|
| BTC | 1144 | 0.17555 | 0.17672 | 0.17400 | 35 / $-1.76 | 2 / $0.00 |
| ETH | 1144 | 0.16898 | 0.17135 | 0.16622 | 20 / $-1.21 | 1 / $-0.22 |
| SOL | 1144 | 0.16717 | 0.17000 | 0.16677 | 4 / $-1.61 | 2 / $-0.90 |
| XRP | 1144 | 0.16767 | 0.16834 | 0.16336 | 2 / $-0.75 | 0 / $0.00 |
| DOGE | 674 | 0.16243 | 0.16271 | 0.15866 | 0 / $0.00 | 0 / $0.00 |