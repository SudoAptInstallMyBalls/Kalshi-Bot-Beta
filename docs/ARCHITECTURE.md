# Architecture and source migration

## Runtime flow

`server.js` loads `src/server/index.js`. The server loads validated configuration, authenticates dashboard clients, and delegates lifecycle control to MasterAgent. Its skills orchestrate price acquisition, signals, risk checks, execution and persistence. Domain modules contain exchange protocols, storage, calculations and model code; they do not depend on CLI scripts or dashboard code.

Backend imports use Node's built-in package imports, such as `require('#src/risk/trading-math')`. The mapping is declared in package.json. Keep CommonJS for the server; use explicit browser ES-module imports inside public/js. No transpiler, bundler or alias package is required.

## Ownership

| Location | Responsibility |
|---|---|
| src/agents/core | Skill registry, workflow routing, lifecycle and scheduling |
| src/agents/skills | Adapters connecting the domain modules to the workflow |
| src/config | Validated runtime defaults and repository-root paths |
| src/exchange | Kalshi authentication, API requests and exchange routing |
| src/execution | Order reconciliation, normalized fills, rejection classification and depth simulation |
| src/market-data | External price-feed connections |
| src/strategy | Trend calculation and shared exit decisions |
| src/risk | Independent safety latch, fees and affordable sizing |
| src/storage | Persisted state, analytics database and research telemetry |
| src/ml | Feature extraction, model fitting, prediction and buffering |
| src/research | Historical download primitives, replay and metrics |
| src/server | HTTP routes, WebSocket bridge and authentication |
| public/js | Browser state, API access, rendering, chart and event wiring |
| scripts | CLI argument parsing and orchestration; stable user-facing commands |

Entry generation remains in its existing skill. Exit evaluation is extracted into src/strategy/exit-policy.js and called through the skill's existing interface, preserving the shared live/replay path. Persisted-position compatibility branches are retained; absence of a current producer is insufficient evidence that old stored positions cannot reference them.

## What moved

- agents/ became src/agents/.
- bot/ clients, storage and lifecycle helpers moved to their domain folders.
- lib/ was eliminated in favor of execution, risk, ml, research and storage modules.
- Root research JSON files moved to config/research/ without changing their contents or the frozen config digest.
- Operational guides and reports moved to docs/. Earlier Rules.md, Soul.md and synthetic findings are explicitly archived.
- The synthetic backtest moved to scripts/synthetic-backtest.js; its npm alias was updated.
- server.js is a compatibility launcher; environment parsing and authentication are separate modules.
- The former public/app.js is now six browser ES modules. index.html loads the module entry point.
- Shared audit metrics no longer require importing a CLI. Unused bindings and redundant metric exports were removed.

Default data directories remain rooted at the repository; moving source code does not relocate SQLite databases, models, recordings, credentials or private keys. Existing scripts/start-demo.js, download-history.js, replay-history.js and record-market-history.js commands remain available. For explicit research config arguments, use config/research/research-config.json or config/research/research-demo-active.json.

## Verification

- All existing regression tests plus import-resolution, storage/config identity and extracted authentication tests.
- Offline browser-module linking and representative snapshot, chart and connection handlers.
- Isolated server startup from a different working directory; idle health, protected route rejection and all dashboard assets.
- Downloader/replay/synthetic CLI help checks.
- Replay parity on the original 1,500-market comparison: all 24 candidate/block/scenario combinations retained exactly the same trade counts and P&L.

These checks validate the refactor, not strategy profitability or real exchange fills. Historical generated reports retain their original provenance paths; new reports reference the new source locations, including the extracted exit policy.

## Rollback and running processes

The pre-migration source snapshot and initial move manifest are retained at data/maintenance/layout-1788753885270/. It excludes credentials, private keys, dependencies and trading databases. Restore source coherently, including package.json, if rollback is needed; do not combine old files with new alias mappings.

Restart the bot and recorder after this migration, then refresh the dashboard. A process that loaded the old source may still lazily resolve an old module path. The migration did not automatically stop or restart user processes.

## Maintenance conventions

Keep reusable logic out of scripts/. Prefer a focused domain module over adding unrelated functions to a generic utility file. Add paths to research manifests when extracting strategy calculations so later results remain reproducible. Preserve authentication, data isolation and persisted state compatibility in refactors. Keep generated artifacts under data/ and secrets excluded by .gitignore.
