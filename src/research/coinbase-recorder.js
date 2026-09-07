// Public market data only. Separate database; never claims to be the settlement index.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const WebSocket = require('ws');
class CoinbaseRecorder {
  constructor(filename, { Socket = WebSocket, clock = Date.now } = {}) {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new Database(filename); this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS proxy_ticks(second_ms INTEGER PRIMARY KEY,event_ms INTEGER NOT NULL,received_ms INTEGER NOT NULL,
      price REAL NOT NULL,bid REAL NOT NULL,ask REAL NOT NULL,source TEXT NOT NULL,raw_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feed_events(id INTEGER PRIMARY KEY,ts INTEGER,event TEXT,detail TEXT);`);
    this.insert = this.db.prepare('INSERT OR IGNORE INTO proxy_ticks VALUES (?,?,?,?,?,?,?,?)');
    this.Socket = Socket; this.clock = clock; this.retryMs = 1000; this.stopped = true;
  }
  record(message, received = this.clock()) {
    if (message.type !== 'ticker' || message.product_id !== 'BTC-USD') return false;
    const event = Date.parse(message.time), price = Number(message.price), bid = Number(message.best_bid), ask = Number(message.best_ask);
    if (![event, received, price, bid, ask].every(Number.isFinite) || price <= 0 || bid <= 0 || ask < bid ||
        event > received || received - event > 5000 || event < (this.lastEvent ?? -Infinity)) return false;
    this.lastEvent = event;
    // First observed ticker in each receipt second is immutable and was actually available then.
    return this.insert.run(Math.floor(received / 1000) * 1000, event, received, price, bid, ask, 'coinbase:BTC-USD:ticker', JSON.stringify(message)).changes > 0;
  }
  event(name, detail = '') { if (!this.stopped) this.db.prepare('INSERT INTO feed_events(ts,event,detail) VALUES (?,?,?)').run(this.clock(), name, detail); }
  start() { this.stopped = false; this.connect(); }
  connect() {
    if (this.stopped) return;
    this.lastEvent = undefined;
    const ws = this.ws = new this.Socket('wss://ws-feed.exchange.coinbase.com', { handshakeTimeout: 10000 });
    this.lastMessage = this.clock();
    ws.on('open', () => {
      if (this.stopped) return;
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker', 'heartbeat'] }));
      this.event('connected');
    });
    ws.on('message', bytes => {
      if (this.stopped) return;
      try {
        const m = JSON.parse(bytes.toString()); this.lastMessage = this.clock();
        if (m.type === 'error') { this.event('server_error', String(m.message)); ws.terminate(); return; }
        if (this.record(m)) this.retryMs = 1000;
      } catch (e) { this.event('record_error', e.message); ws.terminate(); }
    });
    ws.on('error', e => this.event('connection_error', e.message));
    this.watchdog = setInterval(() => { if (this.clock() - this.lastMessage > 15000) ws.terminate(); }, 5000);
    ws.on('close', () => {
      clearInterval(this.watchdog);
      if (this.stopped) return;
      this.event('disconnected');
      this.retry = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(30000, this.retryMs * 2);
    });
  }
  stop() {
    this.stopped = true; clearTimeout(this.retry); clearInterval(this.watchdog);
    this.ws?.terminate(); this.db.close();
  }
}
module.exports = { CoinbaseRecorder };
