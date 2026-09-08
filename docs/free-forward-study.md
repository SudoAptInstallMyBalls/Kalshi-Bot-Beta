# Free forward study and candidate experiments

The original v1 policy and cutoff (`2026-09-07T00:15:00Z`) remain in `config/research/forward-study.json`, unchanged. The hardened code is registered separately in `config/research/forward-study-v2.json`. Each forward run verifies the selected manifest and its source hashes. V1 cannot run against modified v2 source; that rejection is intentional, not bypassed by the new version.

V2's cutoff is declared in the future when its manifest is created. Only markets opening at or after that timestamp enter its forecast scores and trading simulations. Earlier history may supply as-of calibration, but never counts as v2 forward results. This is a fixed-policy evaluation, not evidence that the strategy is profitable.

The registered v2 cutoff is **2026-09-08 00:45 UTC**, or **September 7 at 7:45 PM America/Chicago (CDT)**. Its manifest pins 76 files. Initial runner verification returned `waiting_for_cutoff`; no prospective results were fabricated from existing data.

## Running collection and evaluation

Run these commands from the repository root:

```powershell
# Start the continuous public Coinbase recorder; returns immediately.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-free-research.ps1

# Refresh public settled-market metadata, candles and Binance history, then evaluate.
npm run research:forward -- --study v2

# Evaluate the separate, explicitly exploratory policy candidates.
npm run research:candidates -- --study v2
```

Use `-Restart` on the launcher after recorder code changes. The launcher verifies the recorded process identity before stopping it. The execution-policy override applies only to this PowerShell process.

The active Codex heartbeat `btc-forward-study-and-feed-health` checks collection and runs the forward study every six hours. It reports failures, meaningful findings and new coverage milestones, remaining quiet for routine unchanged results. The machine must remain awake and online; the local recorder stops collecting when the machine is off. Codex scheduled execution also requires its local runtime to be available. Public market feeds need no paid BRTI subscription. Scheduled Codex work uses the account's existing usage allowance.

Read `data/research/forward-studies/settlement-forward-v2/latest.json` for the newest v2 report directory. Read `report.json` there for `forward`, `coinbaseShadow` (ticker) and `coinbaseBookShadow` (book midpoint). V2 candidate runs are saved under the sibling `candidates/` directory and remain explicitly exploratory. The previous `latest-forward-study.json`, settlement evaluation directories and candidate directories are preserved as historical outputs.

Commands without `--study` still select v1; they do not silently switch an existing scheduled study to v2. Any scheduled command intended to follow v2 must include `--study v2`. Before v2's cutoff, the runner reports `waiting_for_cutoff` without fetching or producing a report. Afterward, settled-market and recorder coverage may still be empty initially.

## Declaring and verifying versions

```powershell
# Verify the existing v2 manifest and pinned source without network access.
npm run research:freeze -- --study v2 --verify

# Future code changes need a NEW version, declared before its evaluation data.
# Default cutoff: a quarter-hour boundary at least 15 minutes after declaration.
npm run research:freeze -- --study v3
```

Creating an existing version is refused. Optional `--cutoff` accepts a future ISO timestamp; it never changes an existing version. Each new manifest has a `.sha256` declaration seal that detects metadata edits, and source hashes normalize CRLF to LF so checkout line endings do not invalidate identical code. Commit the manifest, seal and source together. The seal is an integrity check backed by repository history, not a digital signature. Do not edit both to rebaseline a study.

V2 pins all JavaScript under src, the study entrypoints, the research baseline JSON, package.json and package-lock.json. Newly added or removed source files also fail verification. Run v1 only from its original matching source. The old declaration alone is insufficient to reconstruct that source; the current checkout does not pretend otherwise.

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

## Coinbase clock-skew repair (v3)

Study v3 starts at 2026-09-08T14:00:00Z (9 AM Central). V2 declaration and reports remain unchanged; current source intentionally fails v2 verification. Switch recurring evaluation commands to --study v3.

The shadow recorder accepts exchange timestamps at most 500 ms ahead of the original receipt clock. Both timestamps remain unchanged. Research sorts and gates availability by their maximum, including volatility inputs and settlement sampling, and limits both event and receipt age to five seconds. Larger future offsets and stale data remain rejected. A quote rejection no longer reconnects a healthy transport; missing messages or pongs still trigger reconnection. Health counters include tolerated future timestamps. This is a shadow-data policy, not a trading-feed change or a timestamp correction.

Validation: 138 tests passed, including bounded clock-skew ingestion and delayed availability. The original overnight collection cannot be reconstructed.
