# Kalshibot security setup

Required environment variable:

- `BOT_CONTROL_TOKEN`: a long random secret used to authenticate dashboard API requests and Socket.io handshakes.

Recommended deployment settings:

- Keep `HOST=127.0.0.1` (the new default) when using a local reverse proxy or SSH tunnel.
- If you intentionally set `HOST=0.0.0.0`, also set `DASHBOARD_ORIGINS` to a comma-separated allowlist such as `https://bot.example.com`.
- Use HTTPS at the reverse proxy. Do not send the control token over plaintext networks.
- Local `/api/state` and `/api/ml` use the same `BOT_CONTROL_TOKEN`.
- Analytics and ML data live in `data/analytics.db`; protect this directory with local filesystem permissions.
- Rotate exposed Kalshi credentials in the account settings and replace the local private key. Generate a fresh `BOT_CONTROL_TOKEN` locally and restart the server. Never paste secret values into chat.

The browser dashboard asks for the control token and stores it in `sessionStorage` for that tab/session. It is sent as a Bearer token for HTTP control calls and in the authenticated Socket.io handshake.
