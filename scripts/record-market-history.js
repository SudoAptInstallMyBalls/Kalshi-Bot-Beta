// Records public feeds only; never subscribes to account feeds or submits orders.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const dotenv = require('dotenv');
const { PublicHistoryClient, HistoryStore } = require('#src/research/market-history');

function authHeaders(apiKey, pem, now = Date.now()) {
  const timestamp = String(now);
  const signature = crypto.sign('RSA-SHA256', Buffer.from(timestamp + 'GET/trade-api/ws/v2'), {
    key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');
  return { 'KALSHI-ACCESS-KEY': apiKey, 'KALSHI-ACCESS-TIMESTAMP': timestamp, 'KALSHI-ACCESS-SIGNATURE': signature };
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('node scripts/record-market-history.js --env .env.history [--seconds 3600] [--out data/market-history]');
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--env', '--seconds', '--out', '--environment'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid recorder arguments; use --help');
    options[args[i].slice(2)] = args[i + 1];
  }
  const seconds = Number(options.seconds || 3600);
  if (!Number.isInteger(seconds) || seconds < 1) throw new Error('--seconds must be a positive integer');
  const envPath = path.resolve(options.env || '.env.history');
  const credentials = dotenv.parse(fs.readFileSync(envPath));
  if (!credentials.KALSHI_API_KEY || !credentials.KALSHI_PRIVATE_KEY_PATH) throw new Error('Set data-collection API credentials in the selected env file');
  const pem = fs.readFileSync(path.resolve(path.dirname(envPath), credentials.KALSHI_PRIVATE_KEY_PATH), 'utf8');
  // Validate the key before opening storage or scheduling timers.
  authHeaders(credentials.KALSHI_API_KEY, pem);
  const environment = options.environment || (path.basename(envPath)==='.env.demo'?'demo':'production');
  if(!['demo','production'].includes(environment))throw Error('Environment must be demo or production');
  if(path.basename(envPath)==='.env.demo'&&environment!=='demo')throw Error('Demo credentials require demo environment');
  const store = new HistoryStore(path.resolve(options.out || (environment==='demo'?'data/demo/recording':'data/market-history'), 'history.sqlite'));
  const oldEnvironment = store.db.prepare('SELECT value FROM metadata WHERE key=?').get('recording_environment');
  if((oldEnvironment&&JSON.parse(oldEnvironment.value)!==environment)||(!oldEnvironment&&environment==='demo'&&store.db.prepare('SELECT count(*) n FROM markets').get().n>0)) {
    store.close();throw Error('Refusing to mix demo and production recording data');
  }
  store.meta('recording_environment',environment);
  const client = new PublicHistoryClient({base:environment==='demo'?'https://external-api.demo.kalshi.co/trade-api/v2':'https://external-api.kalshi.com/trade-api/v2'});
  let ws, stopped = false, reconnect, refresh, heartbeat, duration, flushTimer, refreshRunning = false;
  let session = crypto.randomUUID(), command = 0, buffered = [], active = new Set(), channels = new Map(), sequences = new Map();
  let pong = true;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const append = event => buffered.push({ received_ms: Date.now(), event });
  const flush = () => {
    if (!buffered.length) return;
    store.events(session, buffered);
    buffered = [];
  };
  const stop = error => {
    if (stopped) return;
    stopped = true;
    for (const timer of [reconnect, refresh, heartbeat, duration, flushTimer]) clearTimeout(timer);
    ws?.terminate();
    try {
      append({ type: 'capture_stop', msg: { error: error?.message || null } });
      flush();
    } catch (err) { error = error || err; }
    store.close();
    if (error) { console.error('[Recorder]', error.message); process.exitCode = 1; }
    resolveDone();
  };
  const send = (cmd, params) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: ++command, cmd, params }));
  };
  const discover = async () => {
    const result = [];
    for await (const page of client.pages('/markets', 'markets', { series_ticker: 'KXBTC15M', status: 'open' })) {
      for (const m of page) {
        if (!m.ticker?.startsWith('KXBTC15M-')) throw new Error('Unexpected market in recorder discovery');
        if (Date.parse(m.close_time) > Date.now() && Date.parse(m.open_time) <= Date.now() + 1800000) result.push(m);
      }
    }
    return result;
  };
  const refreshMarkets = async () => {
    if (refreshRunning || stopped || ws?.readyState !== WebSocket.OPEN || channels.size < 3) return;
    refreshRunning = true;
    try {
      const markets = await discover();
      if (stopped) return;
      const next = new Set(markets.map(m => m.ticker));
      const added = [...next].filter(t => !active.has(t)), removed = [...active].filter(t => !next.has(t));
      for (const m of markets) store.market(m, 'live-recording');
      for (const sid of channels.values()) {
        if (added.length) send('update_subscription', { sids: [sid], market_tickers: added, action: 'add_markets' });
        if (removed.length) send('update_subscription', { sids: [sid], market_tickers: removed, action: 'delete_markets' });
      }
      active = next;
      if (added.length || removed.length) console.log(`[Recorder] Rollover: ${active.size} active market(s); added ${added.join(', ') || 'none'}; removed ${removed.join(', ') || 'none'}`);
    } catch (err) { append({ type: 'discovery_error', msg: { message: err.message } }); }
    finally { refreshRunning = false; }
  };
  const connect = async () => {
    if (stopped) return;
    try {
      const markets = await discover();
      if (stopped) return;
      if (!markets.length) throw new Error('No active BTC 15-minute markets available');
      flush();
      session = crypto.randomUUID();
      active = new Set(markets.map(m => m.ticker));
      channels = new Map(); sequences = new Map(); pong = true;
      for (const m of markets) store.market(m, 'live-recording');
      append({ type: 'connection_start', msg: { tickers: [...active] } });
      ws = new WebSocket(environment==='demo'?'wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2':'wss://external-api-ws.kalshi.com/trade-api/ws/v2', {
        headers: authHeaders(credentials.KALSHI_API_KEY, pem), handshakeTimeout: 15000,
      });
      ws.on('open', () => {
        for (const channel of ['orderbook_delta', 'trade', 'ticker']) {
          send('subscribe', { channels: [channel], market_tickers: [...active] });
        }
        console.log(`[Recorder] Recording ${active.size} markets; connection ${session}`);
      });
      ws.on('pong', () => { pong = true; });
      ws.on('message', data => {
        try {
          const event = JSON.parse(data.toString());
          append(event);
          if (event.type === 'error') return stop(new Error(`Subscription error: ${JSON.stringify(event.msg)}`));
          if (event.type === 'subscribed') channels.set(event.msg.channel, event.msg.sid);
          if (Number.isInteger(event.seq) && event.sid != null) {
            const prev = sequences.get(event.sid);
            if (prev != null && event.seq !== prev + 1) {
              append({ type: 'sequence_gap', sid: event.sid, msg: { expected: prev + 1, actual: event.seq } });
              // Reconnect for fresh snapshots. Never conceal a replay gap.
              ws.terminate();
            }
            sequences.set(event.sid, event.seq);
          }
          if (buffered.length >= 500) flush();
        } catch (err) { stop(err); }
      });
      ws.on('unexpected-response', (req, res) => {
        req.destroy(); res.resume();
        stop(new Error(`WebSocket HTTP ${res.statusCode}; verify data-collection credentials`));
      });
      ws.on('error', err => { if (!stopped) append({ type: 'connection_error', msg: { message: err.message } }); });
      ws.on('close', (code, reason) => {
        if (stopped) return;
        append({ type: 'connection_closed', msg: { code, reason: reason.toString() } });
        reconnect = setTimeout(connect, 3000);
      });
    } catch (err) { stop(err); }
  };
  const onSignal = () => stop();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  duration = setTimeout(() => stop(), seconds * 1000);
  flushTimer = setInterval(() => { try { flush(); } catch (err) { stop(err); } }, 500);
  refresh = setInterval(refreshMarkets, 15000);
  heartbeat = setInterval(() => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (!pong) { ws.terminate(); return; }
    pong = false; ws.ping();
  }, 15000);
  await connect();
  await done;
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
}
if (require.main === module) main().catch(err => { console.error('[Recorder]', err.message); process.exitCode = 1; });
module.exports = { authHeaders };
