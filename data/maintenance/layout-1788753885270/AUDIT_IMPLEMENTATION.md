# Audit implementation and operating instructions

Implemented September 6, 2026. This extends the existing local Node/SQLite architecture. No credentials, funds, running demo state or live models were changed. The server has not been restarted by the coding session.

## Implemented

| Audit area | Changes |
|---|---|
| Probability calibration | Every evaluated market forecast is recorded before edge/sizing rejection, with probability, quotes, spot, strike, volatility and trend. Context records the reference feed when identifiable and explicitly marks the settlement index unobserved. A background lookup resolves settled markets and records when the result became known. Forecast settlement labels stay separate from profitable-exit ML labels. |
| Sample independence | Telemetry evaluation retains the earliest forecast per ticker, rather than counting each repeated scan as an independent outcome. Late-known labels are purged from calibration training. |
| Model simplicity | Constant training columns are skipped by stump fitting. A regularized logistic model drops constant columns and learns standardization from training only. The existing 27-feature schema is retained for compatibility. |
| Walk-forward evaluation | A frozen configuration policy, retained manifests/source hashes, anchored outer test blocks, inner chronological validation, and outcome-time purging are implemented. Base-rate, logistic and existing stump predictors are compared only when the data gates pass. Outer predictive evaluation and cost-inclusive fixed-policy P&L are reported separately. No model is automatically promoted. |
| Regimes and decay | Historical audit retains regime tables and feature/time-block diagnostics. New telemetry uses its earliest 300 resolved market forecasts to define volatility cutoffs, then reports later regime performance. Disjoint 30-market calibration blocks flag three successive blocks worse than market-mid Brier. This is a diagnostic flag, not a statistical claim of decay. |
| Equity risk | Fee-inclusive whole-contract entry cost is capped at 1% of marked account equity. Contracts round down; orders are skipped when one contract exceeds the cap. The research baseline also enforces the cap. |
| Independent drawdown latch | A 10% high-water equity drawdown blocks new entries until explicit review. Peak equity, declared external flows and the latch persist in state.json. API equity includes reported portfolio value. Equity snapshots older than 30 seconds block new entries. Existing exit/cancel management remains available subject to the original authentication controls. |
| Costs | Entry gating now reserves spread, estimated fees on both legs and a one-cent slippage buffer. This remains a conservative filter on a settlement probability edge, not a fitted model of expected scalp P&L. |
| Execution measurements | Separate SQLite events record decisions/rejections, submitted payloads, acknowledgments, observed order states, and cancel requests/acknowledgments. Analysis distinguishes first observed fill and terminal confirmation from order acceptance. |
| Depth recording | The recorder now selects demo endpoints when using .env.demo and isolates demo history under data/demo/recording. Environment metadata prevents mixing recordings. Existing snapshots, deltas, sequence gaps and connection events are retained. |
| Execution diagnostic | Recorded demo entries can be tested against displayed depth at a conservative arrival time, using observed acknowledgment p95 after 20 measurements. It respects limit prices, visible size and the 30-second deadline; stale/missing/gapped books produce no inferred fills. |
| BTC exposure | Equity observations contain positions and exchange balances. Analysis reports signed contract exposure and beta/correlation only when near-full-day equity observations align with cached BTC prices; days with declared external flows are excluded. |

## Important consequences

**A $30 account cannot trade the current 35–65 cent price range under a 1% risk cap:** its per-trade allowance is only 30 cents including fees. Forecast recording still works when sizing rejects the trade. A larger *mock* bankroll is needed for demo fill tests at these prices; the code does not move or add funds. For example, $100 permits up to $1 of contract cost and fees, subject to all other checks. This is not a recommendation to fund a real account.

ML upsizing is forced off by the server. A library opt-in remains only for explicit research tests; saved validation metrics alone cannot activate live upsizing.

The new equity baseline begins with the first valid account-equity observation after upgrade. It does not invent an earlier high-water mark. API marks arrive on the existing 15-second balance refresh, not continuously. A 10% latch cannot guarantee losses stay below 10% during gaps or pending executions.

External deposits/withdrawals must be explicitly declared while the server is stopped. Internal transfers between exchange shards do not change aggregate account equity and should not be declared as external cash flows. Undeclared flows cannot reliably be distinguished from performance by balance snapshots alone.

## Run sequence

First let existing orders/positions resolve, then stop the old demo process with Ctrl+C. Do not delete its state to bypass a reconciliation warning. Restart to load the new code:

```powershell
npm run demo
```

Use the existing dashboard controls to start. Telemetry writes to `data/demo/telemetry.sqlite`. Settlement lookup runs during market refresh, approximately once per minute, with retry backoff. The old process does not pick up source edits.

In a second PowerShell terminal, capture demo depth for up to 24 hours:

```powershell
npm run demo:record
```

This uses the existing demo credentials for market-data access and never submits orders. Keep the computer awake while recording. It is a foreground command, not an installed background service or automation. Use Ctrl+C for a clean stop.

Inspect accumulated forecasts, calibration windows, execution timing and exposure:

```powershell
npm run demo:telemetry
```

To resolve up to 200 overdue demo markets while the bot is stopped, use the optional read-only account lookup:

```powershell
node scripts/evaluate-telemetry.js --resolve
```

Once acknowledgment and depth coverage exist:

```powershell
npm run demo:execution-replay
```

These commands explicitly report missing data rather than claiming a successful test. Their outputs are `data/demo/telemetry-report.json` and `data/demo/execution-replay.json` when sufficient inputs exist.

Research commands:

```powershell
node scripts/replay-history.js --download-spot
npm run research:walk-forward
npm run research:audit
```

The walk-forward baseline is locked by `research-policy.json`. Editing research-config.json causes a mismatch error; a new experiment requires a separately named policy passed with `--policy`, with prior policies and trial outputs retained. The currently inspected history ends at 2026-09-06 03:00 UTC. This date is not proof that all subsequently collected data is untouched: freeze each experiment before observing its test outcomes.

## Explicit risk review

The review tool refuses to operate while the configured server listener is open or local pending orders/open positions remain. It backs up state and appends a review record. It never transfers funds or restarts trading.

To declare an external deposit/withdrawal, stop the bot and supply the signed amount, for example a $10 deposit:

```powershell
node scripts/review-risk.js --env .env.demo --cash-flow 10
```

Only after investigating a latched loss limit and reconciling the account, reset with a substantive reason:

```powershell
node scripts/review-risk.js --env .env.demo --reset-reason "Account reconciled and loss incident reviewed"
```

Do not reset simply to keep a losing bot trading. The production form uses `--env .env`; no production review/reset was performed here.

## Verification and actual results

**71 tests pass.** Added coverage includes persisted equity latches, cash-flow adjustment, stale equity, the 1% whole-contract cap, constant-feature exclusion, depth/limit/gap behavior, and forecast settlement labeling independent of rejected executions. The original execution, persistence, historical data and ML checks also pass.

With the new risk cap, the full 1,500-market replay still produces 91 normal-scenario outcomes and loses **$6.90 from $100**, versus **$9.45 lost** across 36 adverse-scenario outcomes. Normal realized maximum drawdown is **6.98%**; sampled marked drawdown is **7.24%**. These improvements are largely reduced exposure, not better predictions. Both strategies remain unprofitable. The minute replay now includes the configured risk cap and a latched drawdown approximation, but it is still not the complete live orchestrator.

The anchored folds still fail and correctly produce **no selected model** because fit/validation counts are inadequate. No demo telemetry exists yet under the new schema; no actual latency, book-fill, calibration, or beta result is claimed for it.

## Requirements that remain dependent on future data

- Several months of diverse markets and enough independent outcomes for model comparison, calibration and per-regime conclusions.
- Recorded fills and book coverage. The new execution replay is deliberately a conservative *entry diagnostic*, not a complete queue-aware portfolio replay: it does not infer passive fills, reconstruct hidden liquidity, or claim strategy P&L from entry depth alone. Empirical acknowledgment latency is a proxy, not matching-engine arrival time. Exit cash flows remain measured through actual order telemetry and the existing minute stress replay until enough event data supports a fuller model.
- The actual settlement-index feed and historical series-specific fees. Their absence is explicit; Binance spot is not silently labeled as Kalshi's index. Per-fill rebates and exact fee rounding still require account-level validation.
- Forward evidence that any strategy/model beats its baselines after costs. A smaller loss and a passing software test suite do not establish a profitable strategy.
