// Public reference data, isolated from the account ledger and trading clients.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const axios = require('axios');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function openResearch(filename) {
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS spot_candles (
    open_ms INTEGER PRIMARY KEY, available_ms INTEGER NOT NULL, close REAL NOT NULL,
    source TEXT NOT NULL, raw_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS replay_runs (
      id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, report_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS replay_samples (
      run_id TEXT NOT NULL, ticker TEXT NOT NULL, ts INTEGER NOT NULL, outcome_ms INTEGER NOT NULL,
      features TEXT NOT NULL, label INTEGER NOT NULL, pnl REAL NOT NULL, details_json TEXT NOT NULL,
      PRIMARY KEY(run_id,ticker));`);
  return db;
}

function normalizeKline(row) {
  const open = Number(row[0]), available = Number(row[6]) + 1, close = Number(row[4]);
  if (!Number.isSafeInteger(open) || open % 60000 !== 0 || available !== open + 60000 ||
      !Number.isFinite(close) || close <= 0) throw new Error('Invalid one-minute Binance candle');
  return { open, available, close, raw: JSON.stringify(row) };
}

async function downloadSpot(db, from, to, { symbol, request = axios.get, pause = sleep, log = console.log } = {}) {
  if (!['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT'].includes(symbol)) throw Error('Unsupported symbol');
  const start = Math.floor(from / 60000) * 60000, end = Math.floor(to / 60000) * 60000;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) throw new Error('Invalid spot range');
  const count = db.prepare('SELECT count(*) n FROM spot_candles WHERE open_ms>=? AND open_ms<?');
  const insert = db.prepare('INSERT OR REPLACE INTO spot_candles VALUES (?,?,?,?,?)');
  let downloaded = 0;
  for (let cursor = start; cursor < end; cursor += 1000 * 60000) {
    const stop = Math.min(end, cursor + 1000 * 60000);
    if (count.get(cursor, stop).n === (stop - cursor) / 60000) continue;
    let response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await request('https://data-api.binance.vision/api/v3/klines', {
          params: { symbol, interval: '1m', startTime: cursor, endTime: stop - 1, limit: 1000 },
          timeout: 30000,
        });
        break;
      } catch (error) {
        const status = error.response?.status;
        if (attempt >= 4 || (status && status !== 429 && status < 500)) throw error;
        const retry = Number(error.response?.headers?.['retry-after']);
        await pause(Math.min(60000, Math.max(500 * 2 ** attempt, Number.isFinite(retry) ? retry * 1000 : 0)));
      }
    }
    if (!Array.isArray(response.data)) throw new Error('Expected Binance kline array');
    db.transaction(() => {
      for (const raw of response.data) {
        const row = normalizeKline(raw);
        if (row.open < cursor || row.available > stop) throw new Error('Spot response outside requested range');
        insert.run(row.open, row.available, row.close, `binance:${symbol}:1m`, row.raw);
        downloaded++;
      }
    })();
    log(`[Reference] ${downloaded} ${symbol} candles downloaded`);
    await pause(250);
  }
  const stored = count.get(start, end).n, expected = (end - start) / 60000;
  if (stored !== expected) throw new Error(`Incomplete ${symbol} coverage: ${stored}/${expected} minutes. Rerun to resume.`);
  return { stored, downloaded, from: start, to: end };
}

module.exports = { openResearch, normalizeKline, downloadSpot };
