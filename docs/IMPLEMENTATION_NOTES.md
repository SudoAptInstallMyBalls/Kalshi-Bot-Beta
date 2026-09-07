# Implementation and verification

Parts 1–6 are implemented locally. Part 7 is prepared but its 24–48 hour demo run
is pending separate demo credentials and observation. No trading process was
started, and no live-money or demo-money orders were placed. Credentials have not
been rotated or verified; the account-side key rotation remains an operator action.

## Part 1 — Local deployment only

Changed: `package.json`, `package-lock.json`, `.env`, `.env.example`,
`docs/SECURITY_SETUP.md`, storage comments in `src/storage/analytics-db.js`, `src/ml/ml-pipeline.js`,
`src/agents/skills/analysis/ml-signal-scorer.js`, and key-loading text in `src/exchange/kalshi-client.js`.
Deleted the entire `api/` directory, hosted deployment configuration, cloud storage
adapter and its SQL migration file. The cloud client package was uninstalled; the
dependency listing is empty. Application-source scans found no references to the
removed cloud products. Installed third-party package documentation is excluded
from this check; vendor code was not rewritten to remove incidental product names.
The authenticated local Express `/api/state`, `/api/ml`, and health routes remain.

## Part 2 — ML latency and persistence

Changed: `src/storage/analytics-db.js`, `src/ml/ml-pipeline.js`, new `src/ml/ml-write-buffer.js`,
`src/agents/skills/analysis/ml-signal-scorer.js`, `src/agents/core/master-agent.js`, and
`server.js`. Added `test/ml.test.js` and `test/benchmark-ml.js`.

Scoring is synchronous in-memory inference plus a buffer enqueue and cached history
lookups. Flushes run every 500 ms or after 50 total feature/prediction rows, scheduled
with `setImmediate`. A single SQLite transaction writes both tables, preserving
scoring timestamps. Failed batches roll back and remain queued. A full-close outcome
flushes pending features first so rapid settlement cannot miss an uninserted row.
Shutdown drains in-flight scans/exits before synchronously flushing the scorer.
Ticker history and global strategy performance use a configurable 20-second TTL.

Models are saved with atomic temporary-file replacement. Startup reloads model
parameters and evaluation metrics without rebuilding from SQLite. Missing or invalid
files leave a new pipeline untrained; startup trains only when no valid model loaded.

Measured on this Windows ARM64 machine, using an isolated on-disk WAL database and
a 100-stump model: 1,000 scores took **7.54 ms**, averaging **0.00754 ms/signal**;
p99 **0.0591 ms**, maximum **0.752 ms**. After warm-up there were **zero synchronous
database reads** and 1,000 features plus 1,000 predictions remained buffered until
flush. This measures warm-cache scoring, not cold reads, disk flushes, training, or
whole-event-loop latency under live load.

## Part 3 — Circuit breakers

Changed: new `src/risk/trading-safety.js`, `src/agents/skills/trading/risk-manager.js`,
`src/agents/skills/trading/order-executor.js`, `src/exchange/kalshi-client.js`,
`src/agents/skills/market-data/kalshi-market-data.js`, `src/agents/core/master-agent.js`,
`server.js`, `.env.example`. Added `test/safety.test.js`.

| Guard | Behavior | Verification |
|---|---|---|
| Session drawdown | Above 10% halves integer contract sizing; above 20% blocks entries for 15 minutes | Historical PnL baseline, sizing, rounding, cooldown expiry, renewed loss, config overrides |
| Execution failures | Five consecutive placement failures latch a halt; accepted placement resets the streak | Mocked HTTP verifies no sixth entry POST; exits remain possible |
| Balance/authentication | Total account cash below $5 latches an entry halt; any Kalshi 401 latches all HTTP access | Boundary values, recovery stays latched, GET/POST/DELETE blocked after a mocked balance 401 |

The shared safety controller is installed on state before skills start. Placement
failure counting lives at the common client boundary so it also covers sell orders,
not just one executor route. Raw skill entry-order actions now reject requests that
bypass sizing and tracking. Execution rechecks risk after inter-order delays.
Pausing scans preserves fresh quotes for exit management; overlapping exit loops
are prevented. Halt messages are published through the existing dashboard intent.

Interpretations: a session is one process lifetime, with realized closed-trade PnL
relative to the initially loaded cumulative PnL and first fetched account balance.
Dashboard stop/start cannot clear latches. Minimum balance means total account cash,
not cash temporarily unavailable due to reservations. After a cooldown, unchanged
loss permits reduced sizing; additional realized loss starts another cooldown.
Existing resting orders are not automatically canceled by an entry halt, and already
submitted requests cannot be recalled. Unresolved/partial-position losses enter the
session PnL check when the trade fully closes, not as mark-to-market drawdown.

## Part 4 — ML validity

Changed: `src/ml/ml-pipeline.js`, `src/storage/analytics-db.js`,
`src/agents/skills/analysis/ml-signal-scorer.js`, `server.js`, `.env.example`.

The default training floor is 300 valid labeled rows. The latest 10,000 rows are
ordered oldest to newest, then split 70/15/15 without shuffling. Normalization and
stump fitting use only training rows; validation and test accuracy/Brier scores are
stored, exposed by `describe()`, and persisted. `trainingSize` counts the training
slice alone, so the enlargement threshold requires at least 1,000 fitting rows.
Until validation Brier is strictly below 0.25 and that sample gate passes, influence
is limited to 0.3–1.0. After both pass, 0.3–2.0 is permitted within risk/dollar caps.

Leakage audit: active writes to wins, losses, closed-trade count, cumulative PnL,
and streak occur synchronously in `BotState.closePosition()` after full resolution.
Restored state also represents earlier closes. Scoring extracts features before
execution; the current signal's eventual outcome is absent. A code comment and
regression test document this invariant. Historical features are not recomputed.

The local database inspected read-only has **no ML feature table yet**. Thus no
real-data validation accuracy or Brier score can be reported. Synthetic tests verify
the computation, chronological ordering, train-only normalization, reload, and gates;
they do not establish trading performance or eliminate temporal overlap between
signals from the same underlying market near split boundaries.

## Part 5 — Tests

Added `test/math.test.js`, `test/ml.test.js`, `test/safety.test.js`,
`test/outcomes.test.js`, `test/benchmark-ml.js`; added package scripts.
**22 offline tests pass** using Node's built-in test runner and actual SQLite
transactions in temporary databases. HTTP is mocked in safety tests. Coverage
includes known CDF quantiles, probability bounds, existing Kelly outputs, risk
budgets, partial/final outcomes, buffer rollback, timers, shutdown flush, and guards.
The incompatible installed native SQLite binary was rebuilt for this Windows runtime.

## Part 6 — Obsolete bot generations

Deleted `kalshi-bot.js`, `bot/engine.js`, `bot/strategy.js`; removed `npm run legacy`.
Changed the server entry-point comment and added the current-runtime notice to
`README.md`. `.env.example` now matches existing server defaults (including $5
positions and Kelly fraction 0.08); the user's current strategy values in `.env`
were preserved. No entry edge thresholds, Kelly formula, or exit tiers were changed.

## Part 7 — Demo preparation

Added `scripts/start-demo.js`, `.env.demo.example`, `docs/DEMO_BURN_IN.md`, and the `demo`
package script. Updated `.gitignore`, `src/storage/bot-state.js`, `src/storage/analytics-db.js`,
`src/ml/ml-pipeline.js`, and `server.js` to isolate demo environment/data. The demo
launcher pins the documented demo host, requires a separate credentials file,
ignores inherited base64 keys, uses port 3334, and keeps state/ML under `data/demo/`.
The requested multi-day run has **not** been performed. See the burn-in document.

## Adjacent findings and fixes

- Fixed the risk-budget call passing an array instead of state, which previously
  omitted existing open/pending exposure. Regression tests exercise nonempty books.
- Fixed partial-exit PnL disappearing from the final close/ML label. Prior partial
  proceeds, cost, and PnL now persist on the position and are included at full close.
  A profitable final portion can therefore correctly label an overall losing trade.
- Fixed failed portfolio fetches being interpreted as an empty account. Remote
  reconciliation is fetched before local mutation, preserving tracked exposure on
  failure. Successful reconciliation's existing pruning/mapping logic is unchanged.
- Fixed reopening the analytics connection after dashboard stop/start.
- Separated a post-placement balance-refresh error from the accepted order result.

Remaining findings, outside this pass: Kelly currently ignores its `edge` argument
and derives odds from model probability rather than execution price; its existing
outputs were pinned, not redesigned. The backtest file exists and syntax-checks,
but duplicates an older CDF/strategy and defaults, and fetches external candles;
it was not run or represented as validating this runtime. Existing exit accounting
estimates proceeds at submitted prices, omits some fee effects, and can miss fills
between cancel/status checks. Settlement retries remain unbounded, and old partial
exits cannot be retroactively reconstructed. Model fitting with tied median feature
values remains simplistic. The synchronous trainer can block the event loop if
explicitly invoked during trading, so retraining should occur while entries are idle.
Abrupt termination before a buffer flush can still lose pending memory-only rows;
graceful shutdown and transaction rollback are tested, not power-loss durability.
