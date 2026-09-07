# Kalshi history replay

Run: 2026-09-07T00-27-21-336Z-c5756063

**Research simulation, not a live performance forecast.** Starting balance: $100.00.

| Scenario | Simulated trades | Net P&L | Maximum realized drawdown |
|---|---:|---:|---:|
| Next-minute close | 92 | $-7.74 | 7.74% |
| Adverse minute range | 36 | $-9.45 | 9.45% |

Eligible markets: 1525/1526. BTC reference candles: 24195.

Training / validation / test outcomes: 64 / 14 / 14.

Model: Only 92 simulated outcomes; need 300. Live model unchanged.

- Signals use only completed candles; entries and exits execute at the following minute end, never on the signal candle.
- One entry attempt per market; shared signal and exit rules, but not a full replay of the live orchestrator, risk breakers or ML-filtered trading.
- Normal scenario: next-minute closing ask for entry, closing bid minus configured slippage for exit; entry limit includes configured slippage.
- Adverse scenario: next-minute worst ask/bid. Full fills require volume participation capacity; aggregate volume is NOT evidence of available book depth.
- Fees use configurable quadratic rate and cent rounding per simulated order. Series-specific multipliers, rounding rebates and split fills are not reconstructed.
- Minute spot EMA and volatility approximate the tick feed. No historical Polymarket feed; that strategy is disabled. Settlement uses recorded Kalshi result.
- Configured fee-inclusive equity risk cap and a latched minute-mark equity drawdown threshold are modeled. This still does not reproduce exact live account marks or intrasecond execution.
- Recent performance features contain only earlier simulated closes; data and models are isolated from real execution labels.

See report.json for configuration, audit counters, model metrics and baselines; samples.csv for the 27-feature labeled dataset.
