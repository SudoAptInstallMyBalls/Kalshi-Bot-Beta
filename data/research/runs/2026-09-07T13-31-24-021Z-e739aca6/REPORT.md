# Kalshi history replay

Run: 2026-09-07T13-31-24-021Z-e739aca6

**Research simulation, not a live performance forecast.** Starting balance: $100.00.

| Scenario | Simulated trades | Net P&L | Maximum realized drawdown |
|---|---:|---:|---:|
| Next-minute close | 121 | $-9.76 | 9.83% |
| Adverse minute range | 33 | $-10.41 | 10.41% |

Eligible markets: 2099/2100. BTC reference candles: 32055.

Training / validation / test outcomes: 84 / 18 / 19.

Model: Only 121 simulated outcomes; need 300. Live model unchanged.

- Signals use only completed candles; entries and exits execute at the following minute end, never on the signal candle.
- One entry attempt per market; shared signal and exit rules, but not a full replay of the live orchestrator, risk breakers or ML-filtered trading.
- Normal scenario: next-minute closing ask for entry, closing bid minus configured slippage for exit; entry limit includes configured slippage.
- Adverse scenario: next-minute worst ask/bid. Full fills require volume participation capacity; aggregate volume is NOT evidence of available book depth.
- Fees use configurable quadratic rate and cent rounding per simulated order. Series-specific multipliers, rounding rebates and split fills are not reconstructed.
- Minute spot EMA and volatility approximate the tick feed. No historical Polymarket feed; that strategy is disabled. Settlement uses recorded Kalshi result.
- Configured fee-inclusive equity risk cap and a latched minute-mark equity drawdown threshold are modeled. This still does not reproduce exact live account marks or intrasecond execution.
- Recent performance features contain only earlier simulated closes; data and models are isolated from real execution labels.

See report.json for configuration, audit counters, model metrics and baselines; samples.csv for the 27-feature labeled dataset.
