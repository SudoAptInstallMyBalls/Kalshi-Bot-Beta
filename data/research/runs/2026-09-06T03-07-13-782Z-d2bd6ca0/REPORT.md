# Kalshi history replay

Run: 2026-09-06T03-07-13-782Z-d2bd6ca0

**Research simulation, not a live performance forecast.** Starting balance: $100.00.

| Scenario | Simulated trades | Net P&L | Maximum realized drawdown |
|---|---:|---:|---:|
| Next-minute close | 24 | $-6.89 | 6.89% |
| Adverse minute range | 15 | $-16.41 | 16.41% |

Eligible markets: 100/100. BTC reference candles: 1680.

Training / validation / test outcomes: 16 / 4 / 4.

Model: Only 24 simulated outcomes; need 300. Live model unchanged.

- Signals use only completed candles; entries and exits execute at the following minute end, never on the signal candle.
- One entry attempt per market; shared signal and exit rules, but not a full replay of the live orchestrator, risk breakers or ML-filtered trading.
- Normal scenario: next-minute closing ask for entry, closing bid minus configured slippage for exit; entry limit includes configured slippage.
- Adverse scenario: next-minute worst ask/bid. Full fills require volume participation capacity; aggregate volume is NOT evidence of available book depth.
- Fees use configurable quadratic rate and cent rounding per simulated order. Series-specific multipliers, rounding rebates and split fills are not reconstructed.
- Minute spot EMA and volatility approximate the tick feed. No historical Polymarket feed; that strategy is disabled. Settlement uses recorded Kalshi result.
- Recent performance features contain only earlier simulated closes; data and models are isolated from real execution labels.

See report.json for configuration, audit counters, model metrics and baselines; samples.csv for the 27-feature labeled dataset.
