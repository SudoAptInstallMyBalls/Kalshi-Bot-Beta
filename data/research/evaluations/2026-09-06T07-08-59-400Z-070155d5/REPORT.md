# Strategy evaluation

Selection: **No candidate passed the predeclared gates**. No live promotion.

| Candidate | Training P&L | Validation trades | Validation P&L | Adverse validation P&L | Pass |
|---|---:|---:|---:|---:|---|
| corrected_baseline | $-2.32 | 31 | $-5.50 | $-4.88 | false |
| no_trend_boost | $-3.60 | 21 | $-1.94 | $-5.65 | false |
| market_blend_75 | $0.13 | 13 | $-0.77 | $-2.42 | false |
| market_blend_50 | $-0.62 | 1 | $-0.14 | $0.00 | false |
| eight_minute_window | $-2.69 | 43 | $-9.36 | $-7.80 | false |
| ten_point_edge | $-3.74 | 65 | $-9.00 | $-9.99 | false |
| twenty_point_edge | $0.22 | 13 | $-1.47 | $-3.36 | false |
| no_scalping | $-3.16 | 31 | $-4.03 | $-4.01 | false |

Final time-block test (corrected_baseline, diagnostic only): 39 trades, $-7.96 net; adverse $-13.92.

At least 30 train and 30 validation trades; positive train, validation and adverse validation P&L; select largest validation P&L among eligible candidates.

Retrospective time-block holdout: aggregate results on this history were already inspected. Fresh future data is still required. Each block starts at the same research balance.

Untouched forward data must be later than 2026-09-06T03:00:00Z.

See manifest.json for fixed candidates and market membership; report.json for rejection counters and exit breakdowns.