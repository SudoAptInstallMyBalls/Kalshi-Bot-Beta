# Kalshibot

A local Node.js application for Kalshi BTC fifteen-minute market research and demo execution. The strategy remains experimental; research results are separate from actual fills.

## Requirements

Node.js 24 or newer, npm, and the dependencies in package-lock.json. The current setup supports Windows ARM64. Backend code uses CommonJS with native Node package imports; the dashboard uses browser ES modules without a build step.

## Start

Run from the project directory. Existing commands are preserved:

```powershell
node scripts/start-demo.js
```

The demo launcher reads `.env.demo`, uses the demo exchange, and stores its state under `data/demo/`. The server starts idle; the dashboard START button enables trading. Configure credentials following [security setup](docs/SECURITY_SETUP.md). To start the production-configured dashboard, use `node server.js`.

Record demo market data in another terminal:

```powershell
node scripts/record-market-history.js --env .env.demo --environment demo --out data/demo/recording --seconds 86400
```

## Layout

```text
src/
  agents/          Skill orchestration and lifecycle adapters
  config/          Environment parsing and repository paths
  exchange/        Authenticated exchange client
  execution/       Order lifecycle, normalization and book simulation
  market-data/     External price-feed clients
  ml/              Features, training, models and write buffering
  research/        Historical data, replay and diagnostic metrics
  risk/            Independent safety checks and fee-aware sizing
  server/          HTTP, Socket.io and authentication
  storage/         State, SQLite analytics and telemetry
  strategy/        Trend indicator and exit policy
config/research/   Frozen research configurations and policy
public/js/         Dashboard state, rendering, chart, API and socket handlers
scripts/           Stable operational and research CLI entry points
 test/             Offline regression tests
 docs/             Operational guides, research reports and architecture
 data/             Local databases, recordings and generated reports (ignored)
server.js          Stable server launcher
```

## Configuration and research

Runtime defaults live in [src/config/runtime.js](src/config/runtime.js). `.env` and `.env.demo` provide overrides. Secrets and private keys stay outside source modules. `BOT_DATA_DIR` controls runtime storage; default paths are anchored to the project root.

Research configurations live in `config/research/`. The baseline and its frozen policy are unchanged. An explicit demo replay uses:

```powershell
node scripts/replay-history.js --config config/research/research-demo-active.json
```

Other commands:

```powershell
node scripts/download-history.js --help
node scripts/replay-history.js --help
node scripts/walk-forward.js
node scripts/evaluate-telemetry.js
```

See [market data](docs/MARKET_DATA.md), [research workflow](docs/RESEARCH_WORKFLOW.md), and [demo entry experiment](docs/DEMO_ENTRY_EXPERIMENT.md).

## Development checks

```powershell
node --test test/*.test.js
node --experimental-vm-modules scripts/check-dashboard.js
node scripts/check-server.js
```

The dashboard check links modules and exercises rendering using an offline DOM stub. The server check launches an isolated, idle server with temporary storage; it never starts trading. npm aliases include `test`, `check:dashboard`, and `check:server`.

See [architecture and migration notes](docs/ARCHITECTURE.md) for boundaries and maintenance conventions. Archived design documents describe previous versions and are not current trading instructions.
