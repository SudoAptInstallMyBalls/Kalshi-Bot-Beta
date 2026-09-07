# More active demo entry experiment

The demo's MIN_DIVERGENCE is now 10 percentage points, down from 15. The four-minute entry window, fee/slippage filter, 1% equity risk cap, and drawdown latch remain enabled. Restart the demo to load the setting. No running process was restarted automatically. Production defaults and the frozen research baseline were not changed.

This is an explicitly experimental frequency change, not a profitable-policy promotion. The model's historical calibration remains a weakness. More historical data does not itself cause overfitting; repeated tuning against the same outcomes does. This experiment uses four fixed candidates, not an open-ended parameter search.

Comparison used the existing 1,500 markets split into chronological thirds, restarting each third with $59.40. Totals below sum three independent blocks; they are not a single compounded equity curve. Both normal and adverse replay include costs and minute-resolution execution assumptions.

| Entry settings | Normal trades | Normal net P&L | Adverse net P&L |
|---|---:|---:|---:|
| 15-point edge, 4 minutes | 64 | -$0.70 | -$4.81 |
| 10-point edge, 4 minutes (demo experiment) | 121 | -$5.63 | -$9.91 |
| 10-point edge, 10 minutes | 175 | -$11.33 | -$13.04 |
| 10-point edge, 10 minutes, trend disabled | 171 | -$11.77 | -$15.03 |

None demonstrates positive expectancy. The more active setting was applied in demo at the user's request despite worse retrospective results. The ten-minute window and removal of trend filtering were not applied. No new data is required to repeat this comparison:

```powershell
node scripts/compare-entry-policy.js
```

The manifest and detailed block results are in data/research/entry-comparison/2026-09-07T00-33-44-477Z. This history was already inspected, so these are retrospective diagnostics, not an untouched test.

The matching research-demo-active.json can be passed to scripts/replay-history.js with --config. It does not replace the frozen research policy.

Entry telemetry now records aggregated filter counts every 30 seconds, including outside-window, missing-strike, quote, price-band and edge exclusions. Forecast contexts also retain the adjusted edge and thresholds. Counts refer to repeated checks, not independent markets. Risk and sizing rejection telemetry remains separate.

To activate after stopping only the demo bot with Ctrl+C:

```powershell
node scripts/start-demo.js
```

The recorder can continue in its separate terminal. To revert, set MIN_DIVERGENCE=15 in .env.demo and restart the demo. Do not infer profitability from a quoted win rate: average win, average loss, fees and executed fills determine expectancy.
