# Review hardening — September 7, 2026

Implemented the verified fixes from the pasted C1–C10 review and its three phases.

| Finding | Disposition |
| --- | --- |
| C1 | Snapshots validate all rows before adoption; deltas validate only their touched price and resulting quantity, including overflow. Invalid books stay invalid until a valid snapshot. |
| C2 | No bug, as retracted. Sequential exposure commitment remains unchanged. |
| C3 | Added restart regression: legacy pending fillCount without a position restores four contracts once, and repeated polls add nothing. Existing-position compatibility remains intact. |
| C4 | Persist client order identity and requested size before exit POST. Retry exact-identity lookup / known-order reconciliation with exponential delay, deduplication, startup recovery, bounded attempts, and shutdown draining. Reconciliation never submits a replacement sell. |
| C5 | Telemetry instances are keyed by resolved database path, closed handles can reopen, and an explicit close operation releases all cached instances. |
| C6 | Documented why synchronous transactional SQLite writes cannot interleave across timer/immediate callbacks. |
| C7 | Normalize fixed-point/legacy numeric order fields for audit inserts; explicitly parse and validate insert/update numbers. |
| C8 | Initialize completion promises; scheduler also drains discovery and balance work. |
| C9 | Removed favorable styling from combined asks and explain that paired-leg arbitrage is unsupported. |
| C10 | Warn once on base64 credential loading without displaying either credential value. |

Additional hardening includes per-ticker quote retry backoff (2 seconds through 60 seconds), shared rejection constants and diagnostic labels, canonical numeric defaults, effective settings logging, coded execution-data errors, and propagation of feature insertion, labeling, and training-read failures. writeMLBatch already propagated errors through an atomic transaction; regression coverage verifies rollback.

Removed unsupported isDualSide threading and its exit exemption. The ML feature slot remains for compatibility with existing model vectors. Synthetic backtesting remains available with an explicit runtime warning that simulated results cannot validate live trading.

The skill framework remains because it provides startup dependency ordering, workflow dispatch, metrics, and stop ordering. The four loop bodies are independently injectable, and ScheduledTask makes overlap and draining testable without constructing a live bot. Replay now provides all declared signal-generator dependencies; a CI test compares literal registry lookups against that declaration and checks the replay adapter. This checks dependency names, not arbitrary dynamically computed method calls.

Archived Soul.md, Rules.md, and SYNTHETIC_FINDINGS.md remain historical evidence of superseded assumptions. They are not configuration authorities. Current numeric defaults are in src/config/defaults.js, and environment/research settings override those explicitly. Deleting the historical evidence would obscure why the synthetic runtime warning exists.

## Recovery limits

Exit reconciliation uses the documented [Kalshi order listing](https://docs.kalshi.com/api-reference/orders/get-orders) with pagination and exact ticker/client-order-ID matching. No match is not proof of rejection: old terminal orders may be beyond the endpoint's historical cutoff. Legacy unknown submissions with no saved identity, incomplete responses, exhausted retries, authentication failures, and positions already flagged for portfolio reconciliation continue to require operator review. Existing safety latches are never automatically cleared. The default retry limit is 60, with delays from 5 seconds to 5 minutes; EXIT_RECONCILIATION_MAX_ATTEMPTS can override it in the injected manager config.

The remaining architecture and ML scaling suggestions were evaluated, not turned into model changes. No model training algorithm, research cutoff, or frozen study hashes were retuned.

## Validation

The full suite reports 125 passing tests and one frozen-forward-study hash failure. The signal-generator hash already differs from the pinned study in the original HEAD (checked against both LF and CRLF encodings); this change also alters pinned replay and risk-manager source files. The guard is preserved, as are the original study manifest and research JSON files. Continuing that study with modified source requires a separately versioned study; this patch does not silently rebaseline it.

The local better-sqlite3 binary was rebuilt for Windows before running database tests. The isolated idle-server smoke check passes. The dashboard smoke check passes after supplying the browser performance global and updating its obsolete environment/message/disconnect assertions to the current status and market display handlers. It also verifies that combined asks are no longer styled as an executable opportunity.
