const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { HistoryStore, PublicHistoryClient, downloadHistory, exportCSVs, candlePrice, csvCell } = require('#src/research/market-history');
const { authHeaders } = require('../scripts/record-market-history.js');

function fixture(t) {
  const store = new HistoryStore(':memory:');
  t.after(() => store.close());
  return store;
}
function trade(id, time, price = '0.4000', count = '2.50') {
  return { trade_id: id, ticker: 'KXBTC15M-TEST', created_time: time,
    yes_price_dollars: price, no_price_dollars: String(1 - Number(price)), count_fp: count, taker_side: 'yes' };
}

test('history rows deduplicate, retain raw precision, and aggregate occupied seconds only', t => {
  const store = fixture(t);
  const t1 = trade('first', '2026-01-01T00:00:00.100001Z');
  store.trades([t1, trade('second', '2026-01-01T00:00:00.900000Z', '0.6000', '1.50')], 'live');
  store.trades([t1], 'historical');
  store.trades([trade('third', '2026-01-01T00:00:02Z')], 'live');
  assert.equal(store.counts().trades, 3);
  const bars = store.db.prepare('SELECT * FROM trade_seconds ORDER BY second_ts').all();
  assert.equal(bars.length, 2);
  assert.equal(bars[0].yes_open, 0.4);
  assert.equal(bars[0].yes_close, 0.6);
  assert.equal(bars[0].contracts, 4);
  assert.equal(bars[0].yes_vwap, 0.475);
  assert.equal(JSON.parse(store.db.prepare('SELECT raw_json FROM trades WHERE trade_id=?').get('first').raw_json).created_time,
    '2026-01-01T00:00:00.100001Z');
});

test('candle field normalization distinguishes dollars from legacy cents and missing data', t => {
  const store = fixture(t);
  assert.equal(candlePrice({ close_dollars: '0.4500' }, 'close', false), 0.45);
  assert.equal(candlePrice({ close: 45 }, 'close', false), 0.45);
  assert.equal(candlePrice({ close: '0.4500' }, 'close', true), 0.45);
  assert.equal(candlePrice({}, 'close', false), null);
  store.candles('KXBTC15M-TEST', [{ end_period_ts: 123, yes_bid: { close: '0.4500' }, volume: '2.50' }], 'historical');
  const c = store.db.prepare('SELECT * FROM candles').get();
  assert.equal(c.yes_bid_close, 0.45);
  assert.equal(c.price_close, null);
  assert.equal(c.volume, 2.5);
});

test('pagination follows cursors and rejects loops; rate limit retries honor Retry-After', async () => {
  const requests = [], sleeps = [];
  let calls = 0;
  const client = new PublicHistoryClient({ delayMs: 0, sleep: async ms => sleeps.push(ms),
    request: async (url, options) => {
      requests.push(options.params);
      if (++calls === 1) throw Object.assign(new Error('rate limited'), { response: { status: 429, headers: { 'retry-after': '2' } } });
      return { data: { trades: [calls], cursor: calls === 2 ? 'next' : '' } };
    } });
  const rows = [];
  for await (const page of client.pages('/markets/trades', 'trades', { ticker: 'BTC' })) rows.push(...page);
  assert.deepEqual(rows, [2, 3]);
  assert.equal(requests[2].cursor, 'next');
  assert.ok(sleeps.includes(2000));
  const loop = new PublicHistoryClient({ delayMs: 0, sleep: async () => {},
    request: async () => ({ data: { trades: [], cursor: 'same' } }) });
  await assert.rejects(async () => { for await (const page of loop.pages('/markets/trades', 'trades')) void page; }, /repeated/);
});

test('full-market download merges trade tiers and rerun skips completed datasets', async t => {
  const store = fixture(t);
  const calls = [];
  const market = { ticker: 'KXBTC15M-TEST', result: 'yes', open_time: '2026-01-01T00:00:00Z', close_time: '2026-01-01T00:15:00Z' };
  const client = {
    get: async endpoint => {
      calls.push(endpoint);
      if (endpoint === '/historical/cutoff') return { trades_created_ts: '2026-01-01T00:05:00Z' };
      return { candlesticks: [] };
    },
    async *pages(endpoint) {
      calls.push(endpoint);
      if (endpoint === '/markets') yield [market];
      else yield [trade('shared', '2026-01-01T00:05:00Z')];
    },
  };
  const options = { client, store, minTrades: 1, log: () => {} };
  const result = await downloadHistory(options);
  assert.equal(result.targetMet, true);
  assert.equal(store.counts().trades, 1);
  assert.ok(calls.includes('/historical/trades'));
  assert.ok(calls.includes('/markets/trades'));
  calls.length = 0;
  await downloadHistory(options);
  assert.deepEqual(calls, ['/historical/cutoff', '/markets']);
});

test('an interrupted trade batch is not marked complete and can be safely retried', async t => {
  const store = fixture(t);
  assert.throws(() => store.trades([trade('ok', '2026-01-01T00:00:00Z'), { ...trade('bad', 'invalid') }], 'live'), /timestamp/);
  assert.equal(store.counts().trades, 0);
  assert.equal(store.done('job'), false);
});

test('CSV export escapes commas, quotes and newlines and includes empty-table headers', async t => {
  const store = fixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kalshi-history-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell(-1.5), '-1.5');
  store.trades([trade('one', '2026-01-01T00:00:00Z')], 'live');
  await exportCSVs(store, dir);
  assert.ok(fs.readFileSync(path.join(dir, 'trades.csv'), 'utf8').startsWith('trade_id,ticker,created_time'));
  assert.ok(fs.readFileSync(path.join(dir, 'stream_events.csv'), 'utf8').startsWith('id,session_id,received_ms'));
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.csv')).length, 5);
});

test('live recording preserves snapshots, deltas and gap markers; auth signs only websocket GET', t => {
  const store = fixture(t);
  store.events('session', [{ received_ms: 123, event: { type: 'orderbook_snapshot', sid: 1, seq: 2,
    msg: { market_ticker: 'KXBTC15M-TEST', yes_dollars_fp: [['0.4', '10']] } } },
  { received_ms: 124, event: { type: 'sequence_gap', msg: { expected: 3, actual: 4 } } }]);
  assert.equal(store.counts().stream_events, 2);
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const headers = authHeaders('key-id', keys.privateKey, 1234);
  assert.equal(headers['KALSHI-ACCESS-KEY'], 'key-id');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from('1234GET/trade-api/ws/v2'), {
    key: keys.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }, Buffer.from(headers['KALSHI-ACCESS-SIGNATURE'], 'base64')));
});
