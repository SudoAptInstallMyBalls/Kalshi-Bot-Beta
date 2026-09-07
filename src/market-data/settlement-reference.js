const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { completedMinutes, minuteVolatility } = require('../strategy/volatility');
const { averageForecast } = require('../strategy/settlement-forecast');

class IndexRecorder {
  constructor(filename, { historical = false } = {}) {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS index_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS index_samples(timestamp INTEGER PRIMARY KEY,received_ms INTEGER NOT NULL,price REAL NOT NULL,source TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS index_received ON index_samples(received_ms);`);
    const mode = historical ? 'historical' : 'live';
    this.db.prepare("INSERT OR IGNORE INTO index_metadata VALUES ('mode',?)").run(mode);
    if (this.db.prepare("SELECT value FROM index_metadata WHERE key='mode'").get().value !== mode) {
      this.db.close(); throw Error('Cannot mix live and historical index records');
    }
    this.historical = historical;
    this.insert = this.db.prepare('INSERT INTO index_samples VALUES (@timestamp,@received_ms,@price,@source)');
  }
  record(row, receivedMs = Date.now()) {
    const received_ms = this.historical ? row.received_ms : receivedMs;
    if (row.source !== 'CFB:BRTI' || !Number.isSafeInteger(row.timestamp) || row.timestamp % 1000 !== 0 ||
        !Number.isSafeInteger(received_ms) || received_ms < row.timestamp || !Number.isFinite(row.price) || row.price <= 0) {
      throw Error('Expected CFB:BRTI, positive price, exact-second timestamp and valid receipt time');
    }
    const old = this.db.prepare('SELECT * FROM index_samples WHERE timestamp=?').get(row.timestamp);
    if (old) {
      if (old.price !== row.price || old.source !== row.source) throw Error('Conflicting index observation; original is immutable');
      return false;
    }
    this.insert.run({ timestamp: row.timestamp, received_ms, price: row.price, source: row.source });
    return true;
  }
  close() { this.db.close(); }
}

class SettlementReference {
  constructor(filename, { maxAgeMs = 3000, allowHistorical = false } = {}) {
    this.filename = filename; this.maxAgeMs = maxAgeMs; this.allowHistorical = allowHistorical;
  }
  getForecast(market, strike, now) {
    try {
      if (!this.filename || !fs.existsSync(this.filename)) return { ready: false, reason: 'index_feed_missing' };
      if (!this.db) {
        this.db = new Database(this.filename, { readonly: true, fileMustExist: true });
        this.db.pragma('busy_timeout = 1000');
        if (this.allowHistorical) this.db.exec('BEGIN'); // Freeze optional research index inputs.
      }
      const mode = this.db.prepare("SELECT value FROM index_metadata WHERE key='mode'").get()?.value;
      if (mode !== 'live' && !(mode === 'historical' && this.allowHistorical)) {
        return { ready: false, reason: 'historical_index_not_live' };
      }
      if (market.strikeSource !== 'kalshi' || market.strikeType !== 'greater_or_equal' ||
          !market.ticker.startsWith('KXBTC15M-')) return { ready: false, reason: 'official_strike_required' };
      const ticks = this.db.prepare('SELECT * FROM index_samples WHERE timestamp>=? AND timestamp<=? AND received_ms<=? ORDER BY timestamp')
        .all(now - 20 * 60000, now, now);
      if (ticks.some(t => t.source !== 'CFB:BRTI')) return { ready: false, reason: 'invalid_index_source' };
      const last = ticks.at(-1);
      if (!last || now - last.timestamp > this.maxAgeMs) return { ready: false, reason: 'index_feed_stale' };
      const sigma = minuteVolatility(completedMinutes(ticks, now, 1000), 900);
      if (sigma === null) return { ready: false, reason: 'index_volatility_warmup' };
      return { ...averageForecast({ now, closeTime: market.closeTime, strike, currentPrice: last.price,
        sigma, observed: ticks }), referenceSource: 'CFB:BRTI', referencePrice: last.price,
        referenceTimestamp: last.timestamp, errorModel: 'index diffusion; no cross-feed basis adjustment' };
    } catch (error) { return { ready: false, reason: 'index_feed_error', detail: error.message }; }
  }
  close() { this.db?.close(); this.db = null; }
}
module.exports = { IndexRecorder, SettlementReference };
