# Strategy evaluation

Selection: **No candidate passed the predeclared gates**. No live promotion.

| Candidate | Training P&L | Validation trades | Validation P&L | Adverse validation P&L | Pass |
|---|---:|---:|---:|---:|---|
| corrected_baseline | $-9.76 | 32 | $-2.84 | $-1.91 | false |
| no_trend_boost | $-10.16 | 27 | $-1.41 | $-3.30 | false |
| market_blend_75 | $-10.09 | 15 | $-0.54 | $-0.64 | false |
| market_blend_50 | $-7.80 | 2 | $-0.31 | $-0.34 | false |
| eight_minute_window | $-10.04 | 46 | $-5.62 | $-4.96 | false |
| ten_point_edge | $-9.85 | 75 | $-6.51 | $-7.61 | false |
| twenty_point_edge | $-10.09 | 15 | $-0.54 | $-0.64 | false |
| no_scalping | $-9.12 | 32 | $-2.15 | $-1.96 | false |

Final time-block test (corrected_baseline, diagnostic only): 50 trades, $-3.51 net; adverse $-6.11.

At least 30 train and 30 validation trades; positive train, validation and adverse validation P&L; select largest validation P&L among eligible candidates.

Retrospective time-block holdout: aggregate results on this history were already inspected. Fresh future data is still required. Each block starts at the same research balance.

Untouched forward data must be later than 2026-09-07T00:15:00Z.

See manifest.json for fixed candidates and market membership; report.json for rejection counters and exit breakdowns.