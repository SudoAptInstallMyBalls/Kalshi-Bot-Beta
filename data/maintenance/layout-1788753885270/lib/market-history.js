// Public market data only. This module has no account/order-placement methods.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Database = require('better-sqlite3');
const { once } = require('events');
const BASE = 'https://external-api.kalshi.com/trade-api/v2';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function number(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric data: ${value}`);
  return n;
}
function timestamp(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid timestamp: ${value}`);
  return ms;
}
function candlePrice(group, key, historical) {
  if (group?.[`${key}_dollars`] != null) return number(group[`${key}_dollars`]);
  const value = number(group?.[key]);
  return value == null ? null : historical ? value : value / 100;
}
function tradePrice(trade, side) {
  if (trade[`${side}_price_dollars`] != null) return number(trade[`${side}_price_dollars`]);
  const cents = number(trade[`${side}_price`]);
  return cents == null ? null : cents / 100;
}

class PublicHistoryClient {
  constructor({ delayMs = 250, request = axios.get, sleep = pause, base = BASE } = {}) {
    if(![BASE,'https://external-api.demo.kalshi.co/trade-api/v2'].includes(base)) throw Error('Unsupported history origin');
    this.base = base;
    this.delayMs = delayMs;
    this.request = request;
    this.sleep = sleep;
    this.nextRequestAt = 0;
  }
  async get(endpoint, params = {}) {
    if (!/^\/(markets|historical|series)(\/|$)/.test(endpoint)) throw new Error('Not a public market-data endpoint');
    for (let attempt = 0; ; attempt++) {
      await this.sleep(Math.max(0, this.nextRequestAt - Date.now()));
      this.nextRequestAt = Date.now() + this.delayMs;
      try {
        return (await this.request(this.base + endpoint, { params, timeout: 30000 })).data;
      } catch (err) {
        const status = err.response?.status;
        if (attempt >= 5 || (status && status !== 429 && status < 500)) throw err;
        const retry = err.response?.headers?.['retry-after'];
        const retryMs = retry ? (Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
        await this.sleep(Math.min(60000, Math.max(retryMs || 0, 500 * 2 ** attempt)));
      }
    }
  }
  async *pages(endpoint, key, params = {}) {
    let cursor;
    const seen = new Set();
    do {
      const data = await this.get(endpoint, { ...params, limit: 1000, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(data[key])) throw new Error(`${endpoint}: missing ${key} array`);
      yield data[key];
      cursor = data.cursor;
      if (cursor && seen.has(cursor)) throw new Error(`${endpoint}: repeated pagination cursor`);
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
}

class HistoryStore {
  constructor(filename) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS markets (
        ticker TEXT PRIMARY KEY, event_ticker TEXT, open_time TEXT, close_time TEXT,
        result TEXT, floor_strike REAL, expiration_value TEXT, source TEXT,
        fetched_at_ms INTEGER NOT NULL, raw_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trades (
        trade_id TEXT PRIMARY KEY, ticker TEXT NOT NULL, created_time TEXT NOT NULL,
        created_ms INTEGER NOT NULL, yes_price REAL, no_price REAL, contracts REAL,
        taker_side TEXT, source TEXT NOT NULL, raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_trades_time ON trades(ticker, created_ms, trade_id);
      CREATE TABLE IF NOT EXISTS candles (
        ticker TEXT NOT NULL, end_period_ts INTEGER NOT NULL, period_minutes INTEGER NOT NULL,
        yes_bid_open REAL, yes_bid_high REAL, yes_bid_low REAL, yes_bid_close REAL,
        yes_ask_open REAL, yes_ask_high REAL, yes_ask_low REAL, yes_ask_close REAL,
        price_open REAL, price_high REAL, price_low REAL, price_close REAL,
        volume REAL, open_interest REAL, source TEXT NOT NULL, raw_json TEXT NOT NULL,
        PRIMARY KEY(ticker, end_period_ts, period_minutes)
      );
      CREATE TABLE IF NOT EXISTS completed_jobs (
        job TEXT PRIMARY KEY, completed_at_ms INTEGER NOT NULL, rows_received INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stream_events (
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, received_ms INTEGER NOT NULL,
        exchange_ts_ms INTEGER, type TEXT NOT NULL, ticker TEXT, sid INTEGER, seq INTEGER,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stream_events_ticker ON stream_events(ticker, received_ms);
      CREATE VIEW IF NOT EXISTS trade_seconds AS
        WITH ranked AS (
          SELECT *, CAST(created_ms / 1000 AS INTEGER) AS second_ts,
            ROW_NUMBER() OVER (PARTITION BY ticker, CAST(created_ms / 1000 AS INTEGER)
              ORDER BY created_ms, created_time, trade_id) AS first_row,
            ROW_NUMBER() OVER (PARTITION BY ticker, CAST(created_ms / 1000 AS INTEGER)
              ORDER BY created_ms DESC, created_time DESC, trade_id DESC) AS last_row
          FROM trades
        )
        SELECT ticker, second_ts,
          MAX(CASE WHEN first_row = 1 THEN yes_price END) AS yes_open,
          MAX(yes_price) AS yes_high, MIN(yes_price) AS yes_low,
          MAX(CASE WHEN last_row = 1 THEN yes_price END) AS yes_close,
          SUM(contracts) AS contracts, COUNT(*) AS trade_count,
          SUM(yes_price * contracts) / NULLIF(SUM(contracts), 0) AS yes_vwap
        FROM ranked GROUP BY ticker, second_ts;
    `);
    this.insertMarket = this.db.prepare('INSERT OR REPLACE INTO markets VALUES (?,?,?,?,?,?,?,?,?,?)');
    this.insertTrade = this.db.prepare('INSERT OR IGNORE INTO trades VALUES (?,?,?,?,?,?,?,?,?,?)');
    this.insertCandle = this.db.prepare(`INSERT OR REPLACE INTO candles VALUES (${Array(19).fill('?').join(',')})`);
    this.insertEvent = this.db.prepare('INSERT INTO stream_events(session_id,received_ms,exchange_ts_ms,type,ticker,sid,seq,raw_json) VALUES (?,?,?,?,?,?,?,?)');
  }
  market(m, source) {
    this.insertMarket.run(m.ticker, m.event_ticker ?? null, m.open_time ?? null, m.close_time ?? null,
      m.result ?? null, number(m.floor_strike), m.expiration_value ?? null, source, Date.now(), JSON.stringify(m));
  }
  trades(rows, source) {
    this.db.transaction(() => {
      for (const t of rows) {
        if (!t.trade_id || !t.ticker) throw new Error('Trade missing identity');
        this.insertTrade.run(t.trade_id, t.ticker, t.created_time, timestamp(t.created_time),
          tradePrice(t, 'yes'), tradePrice(t, 'no'),
          number(t.count_fp ?? t.count), t.taker_outcome_side ?? t.taker_side ?? null, source, JSON.stringify(t));
      }
    })();
  }
  candles(ticker, rows, source) {
    this.db.transaction(() => {
      for (const c of rows) {
        const prices = ['yes_bid', 'yes_ask', 'price'].flatMap(group =>
          ['open', 'high', 'low', 'close'].map(key => candlePrice(c[group], key, source === 'historical')));
        this.insertCandle.run(ticker, c.end_period_ts, 1, ...prices,
          number(c.volume_fp ?? c.volume), number(c.open_interest_fp ?? c.open_interest), source, JSON.stringify(c));
      }
    })();
  }
  events(session, rows) {
    this.db.transaction(() => {
      for (const { received_ms, event } of rows) {
        const msg = event.msg || {};
        this.insertEvent.run(session, received_ms, msg.ts_ms ?? null, event.type || 'unknown',
          msg.market_ticker ?? msg.ticker ?? null, event.sid ?? null, event.seq ?? null, JSON.stringify(event));
      }
    })();
  }
  done(job) { return !!this.db.prepare('SELECT 1 FROM completed_jobs WHERE job=?').get(job); }
  complete(job, rows) { this.db.prepare('INSERT OR REPLACE INTO completed_jobs VALUES (?,?,?)').run(job, Date.now(), rows); }
  meta(key, value) { this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key, JSON.stringify(value)); }
  counts() {
    return Object.fromEntries(['markets', 'trades', 'candles', 'stream_events'].map(table =>
      [table, this.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
  }
  close() { this.db.close(); }
}

async function downloadHistory({ client, store, marketLimit = 100, minTrades = 5000, from = 0,
  to = Math.floor(Date.now() / 1000), log = console.log }) {
  const cutoff = await client.get('/historical/cutoff');
  store.meta('cutoff', cutoff);
  const tradeCutoff = Math.floor(timestamp(cutoff.trades_created_ts) / 1000);
  let processed = 0, selectedTrades = 0;
  const seen = new Set();
  const sources = [
    { source: 'live', endpoint: '/markets', params: { series_ticker: 'KXBTC15M', status: 'settled' } },
    { source: 'historical', endpoint: '/historical/markets', params: { series_ticker: 'KXBTC15M' } },
  ];
  for (const { source, endpoint, params } of sources) {
    for await (const page of client.pages(endpoint, 'markets', params)) {
      // Do not depend on undocumented global ordering to terminate pagination.
      for (const market of [...page].sort((a, b) => timestamp(b.close_time) - timestamp(a.close_time))) {
        if (!market.ticker?.startsWith('KXBTC15M-')) throw new Error('API returned a market outside the requested series');
        if (seen.has(market.ticker) || !['yes', 'no'].includes(market.result)) continue;
        const open = Math.floor(timestamp(market.open_time) / 1000);
        const close = Math.ceil(timestamp(market.close_time) / 1000);
        if (close < from || close > to) continue;
        seen.add(market.ticker);
        store.market(market, source);
        // Full market window; from/to select market close dates, not partial slices.
        const ticker = market.ticker;
        const ranges = [
          { tier: 'historical', endpoint: '/historical/trades', start: open - 1, end: Math.min(close + 1, tradeCutoff) },
          { tier: 'live', endpoint: '/markets/trades', start: Math.max(open - 1, tradeCutoff), end: close + 1 },
        ];
        for (const range of ranges) {
          if (range.start > range.end) continue;
          const job = `${ticker}:trades:${range.tier}:${range.start}:${range.end}`;
          if (store.done(job)) continue;
          let received = 0;
          for await (const trades of client.pages(range.endpoint, 'trades', {
            ticker, min_ts: range.start, max_ts: range.end,
          })) {
            if (trades.some(t => t.ticker !== ticker)) throw new Error('Trade ticker mismatch');
            store.trades(trades, range.tier);
            received += trades.length;
          }
          store.complete(job, received);
        }
        const candleJob = `${ticker}:candles:1:${open}:${close}`;
        if (!store.done(candleJob)) {
          const candlePath = source === 'historical' ? `/historical/markets/${encodeURIComponent(ticker)}/candlesticks` :
            `/series/KXBTC15M/markets/${encodeURIComponent(ticker)}/candlesticks`;
          const data = await client.get(candlePath, { start_ts: open, end_ts: close, period_interval: 1 });
          if (!Array.isArray(data.candlesticks)) throw new Error('Missing candle array');
          store.candles(ticker, data.candlesticks, source);
          store.complete(candleJob, data.candlesticks.length);
        }
        processed++;
        selectedTrades += store.db.prepare('SELECT COUNT(*) n FROM trades WHERE ticker=?').get(ticker).n;
        log(`[History] ${processed} markets complete; ${selectedTrades.toLocaleString()} trades in selected markets (${ticker})`);
        if (processed >= marketLimit || (minTrades > 0 && selectedTrades >= minTrades)) {
          return { processed, selectedTrades, targetMet: minTrades === 0 || selectedTrades >= minTrades };
        }
      }
    }
  }
  return { processed, selectedTrades,
    targetMet: minTrades === 0 ? processed >= marketLimit : selectedTrades >= minTrades };
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  // Guard spreadsheet formula execution on untrusted text, while keeping numbers numeric.
  if (typeof value === 'string' && /^[=+@\-\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}
async function exportCSVs(store, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const queries = {
    markets: 'SELECT * FROM markets ORDER BY close_time, ticker',
    trades: 'SELECT * FROM trades ORDER BY created_ms, created_time, trade_id',
    candles_1m: 'SELECT * FROM candles ORDER BY end_period_ts, ticker',
    trade_bars_1s: 'SELECT * FROM trade_seconds ORDER BY second_ts, ticker',
    stream_events: 'SELECT * FROM stream_events ORDER BY id',
  };
  for (const [name, sql] of Object.entries(queries)) {
    const statement = store.db.prepare(sql);
    const columns = statement.columns().map(c => c.name);
    const filename = path.join(directory, name + '.csv');
    const stream = fs.createWriteStream(filename + '.tmp', { encoding: 'utf8' });
    let streamError;
    stream.on('error', err => { streamError = err; });
    const write = async line => {
      if (streamError) throw streamError;
      if (!stream.write(line + '\r\n')) await once(stream, 'drain');
    };
    try {
      await write(columns.map(csvCell).join(','));
      for (const row of statement.iterate()) await write(columns.map(c => csvCell(row[c])).join(','));
      const finished = once(stream, 'finish');
      stream.end();
      await finished;
      if (streamError) throw streamError;
      fs.renameSync(filename + '.tmp', filename);
    } catch (err) { stream.destroy(); throw err; }
  }
}

module.exports = { PublicHistoryClient, HistoryStore, downloadHistory, exportCSVs, csvCell, candlePrice };
