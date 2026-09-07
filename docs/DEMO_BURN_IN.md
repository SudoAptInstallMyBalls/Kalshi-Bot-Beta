# Demo burn-in

## September 6 demo rejection: diagnosed and patched

The first demo attempt returned HTTP 404 `user_not_found`. Read-only account checks confirmed that market `KXBTC15M-26SEP060915-15` is on exchange 2, while the demo account held $30 on exchange 0 and $0 on exchange 2. Orders and fills for that market were empty, and Bitcoin positions were flat. This was an exchange funding/account setup failure, not a filled trade or a trading loss.

The client now resolves the authoritative market `exchange_index`, checks that exchange's available balance including estimated entry fees before POST, and explicitly routes the order. Cancellations carry the market ticker for routing. Explicit `404 user_not_found` rejections and failures before POST remove the new pending marker and halt with a specific reason; ambiguous responses still preserve the marker. Aggregate account cash is no longer reduced by the unrelated `payout` field. Regression suite: 63 passing tests.

To resume this particular demo after the patch:

1. Stop the existing demo process with Ctrl+C.
2. Run `node scripts/repair-demo-submission.js --apply`. It checks the account again, refuses unrelated state or a running demo listener, backs up the original state, and removes only the marker from this logged rejection. It does not place orders or transfer funds. This command is incident-specific and must not be used to clear other uncertain orders.
3. In the Kalshi demo account, allocate mock funds from the Default exchange (0) to Crypto (2). If the demo UI does not expose transfers, account setup requires Kalshi's supported demo transfer mechanism. Do not change to the production host to resolve this error.
4. Run `npm run demo`, then use the dashboard toggle when demo funding is ready. The old running process does not pick up code edits.

No funds were moved, saved demo state repaired, or trading restarted by the coding session. The end-to-end fill test is still outstanding. See [Kalshi exchange sharding](https://docs.kalshi.com/getting_started/exchange_sharding).

## Original setup and observation procedure

No live orders were submitted during implementation. The initial user-run demo
stopped at its first rejected submission. Offline regression tests do not replace
the requested 24–48 hour observation with actual demo fills.

1. Rotate the exposed production Kalshi API key/private key through the account
   settings. Replace the local key and API identifier; do not paste credentials
   into chat. The dashboard control token must also be rotated and the process
   restarted to use it. Credential rotation is not verified by this implementation.
2. Create a separate demo account and demo API key. Kalshi uses separate credentials
   and mock funds for demo. The launcher pins the origin to
   `https://external-api.demo.kalshi.co`; the client appends `/trade-api/v2` paths.
   See [Kalshi's official demo guide](https://docs.kalshi.com/getting_started/demo_env).
3. Copy `.env.demo.example` to `.env.demo`, set the demo key identifier, private-key
   path, and a new random dashboard token locally. Keep the default port 3334.
4. Run `npm test` and `npm run benchmark:ml`, then `npm run demo`.
   If the system npm launcher is broken, invoke its installed CLI directly:
   `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run demo`.
5. Verify the console shows the demo host. Open the local dashboard on port 3334,
   authenticate with the demo control token, and start using the dashboard toggle.
   The launcher never automatically starts trading. Demo state, analytics, and
   models all live under `data/demo/`, separate from the production ledger.
6. Observe for 24–48 hours. Record actual fills, full closes, partial exits,
   feature/outcome UUID joins, stop/start behavior, and any circuit-breaker events.
   Inspect `/api/ml` through the authenticated local API for sample counts and
   validation/test metrics. An absence of available demo contracts or fills is
   inconclusive, not a successful end-to-end test. Do not switch hosts to obtain fills.
7. Keep the run on demo until all observed discrepancies are resolved. Preserve its
   logs and database as evidence. Do not copy demo state or its trained model into
   production. Credentials and completion of burn-in still need operator verification.

Entry halts leave exit management active. A 401 blocks all subsequent Kalshi HTTP
requests; resolve authentication and restart the process. Failure and balance halts
also remain latched across dashboard stop/start. A normal process restart starts a
new session; it is not evidence that the cause of a halt has been resolved.
