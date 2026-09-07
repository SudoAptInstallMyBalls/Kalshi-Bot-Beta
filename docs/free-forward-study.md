# Free forward study and candidate experiments

The original policy and cutoff (`2026-09-07T00:15:00Z`) are recorded in `config/research/forward-study.json`. Each forward run verifies the policy hashes. Threshold and volatility experiments run separately; they do not change the live strategy or the frozen baseline.

## Running collection and evaluation

Run these commands from the repository root:

```powershell
# Start the continuous public Coinbase recorder; returns immediately.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-free-research.ps1

# Refresh public settled-market metadata, candles and Binance history, then evaluate.
npm run research:forward

# Evaluate the separate, explicitly exploratory policy candidates.
npm run research:candidates
```

Use `-Restart` on the launcher after recorder code changes. The launcher verifies the recorded process identity before stopping it. The execution-policy override applies only to this PowerShell process.

The active Codex heartbeat `btc-forward-study-and-feed-health` checks collection and runs the forward study every six hours. It reports failures, meaningful findings and new coverage milestones, remaining quiet for routine unchanged results. The machine must remain awake and online; the local recorder stops collecting when the machine is off. Codex scheduled execution also requires its local runtime to be available. Public market feeds need no paid BRTI subscription. Scheduled Codex work uses the account's existing usage allowance.

Read `data/research/latest-forward-study.json` for the newest report directory. Read `report.json` there for `forward`, `coinbaseShadow` (ticker) and `coinbaseBookShadow` (book midpoint). Candidate runs are saved under `data/research/candidate-evaluations/`, with a manifest written before evaluation.

## Collector repair and evidence

The ticker-only database had gaps as long as 393 seconds. New rejection counters showed many exchange timestamps ahead of the collector's receipt time (227 of 265 ticker messages in one measured minute). That is consistent with clock skew contributing to missing samples; the old diagnostics cannot attribute every historical gap. No rate-limit response was observed in this investigation.

The recorder now also subscribes to Coinbase `level2_batch`, maintains the order book, and records the first valid midpoint observed in each receipt second. It applies every book update, including removals, before sampling. Book quotes and ticker trades have separate tables and source labels. Samples with future timestamps or excessive age remain rejected. No old gaps are backfilled or relabeled as observed data.

Connection handling includes handshake timeout, heartbeat/message monitoring, ping/pong checks, a stale-book watchdog, reconnect backoff, book reset on reconnect, HTTP failure diagnostics and rejection counters. The initial six-minute verification collected 355 book quotes across about 354 seconds, with a largest receipt gap of 1.469 seconds. This establishes short-run improvement, not a guarantee of uninterrupted future data.

The book shadow is a new observational variant introduced after the frozen ticker study. Its coverage begins with actual book collection on September 7 around 18:09 UTC. It cannot claim earlier ticker-only coverage. Coinbase remains a single-exchange USD proxy, not BRTI. Shadow forecasts need sufficient completed minute history and fully observed markets; zero common markets immediately after a restart is expected.

Diagnostics are in `data/research/free-feed/coinbase.sqlite` (`feed_events`, `proxy_ticks`, `proxy_quotes`) and `recorder.out.log` / `recorder.err.log` in that directory. If future-timestamp rejection persists, check Windows clock synchronization; timestamps must not be silently altered to make rejected data pass.

## Threshold and model results

The exploratory run at `2026-09-07T18-11-38-103Z` tested eight fixed variants: baseline, divergence thresholds 10 and 5, an eight-minute entry window, their combination, a 90th-percentile basis band, 60-return volatility, and a combined candidate. All retain transaction costs and execution/risk checks. These are already-inspected data, unsuitable for claiming out-of-sample alpha.

| Candidate | Trades | Normal simulated P&L | Adverse simulated P&L |
|---|---:|---:|---:|
| Frozen robust baseline | 1 | -$0.340 | -$0.682 |
| Threshold 5 and eight-minute window | 4 | +$0.060 | -$0.682 |
| Combined threshold, window, basis and volatility changes | 6 | -$0.630 | -$0.682 |

The 60-return volatility estimate improved common-cohort Brier from 0.174479 to 0.174380 in this exploratory sample. Lower thresholds alone did not establish a durable trading advantage. No candidate was promoted to live configuration.

The subsequent frozen forward refresh reached 71 common markets, up from 52. Proxy-average Brier was 0.171668 versus midpoint 0.173695. The ranking changed in a small sample; this is not established alpha, and repeated forecasts of a market are correlated. Continue collecting fresh results using the fixed cutoff before selecting a policy.

Validation after implementation: 109 tests passed, covering book updates, timestamp rejection, source separation, baseline equivalence and candidate volatility readiness alongside the existing strategy tests.
