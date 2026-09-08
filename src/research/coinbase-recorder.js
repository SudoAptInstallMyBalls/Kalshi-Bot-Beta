// Public market data only. Separate database; never claims to be the settlement index.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const WebSocket = require('ws');
const { CoinbaseBook } = require('./coinbase-book');
const { MAX_FUTURE_SKEW_MS } = require('./coinbase-time');
class CoinbaseRecorder {
  constructor(filename, { Socket = WebSocket, clock = Date.now } = {}) {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new Database(filename); this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS proxy_ticks(second_ms INTEGER PRIMARY KEY,event_ms INTEGER NOT NULL,received_ms INTEGER NOT NULL,
      price REAL NOT NULL,bid REAL NOT NULL,ask REAL NOT NULL,source TEXT NOT NULL,raw_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feed_events(id INTEGER PRIMARY KEY,ts INTEGER,event TEXT,detail TEXT);`);
    this.insert = this.db.prepare('INSERT OR IGNORE INTO proxy_ticks VALUES (?,?,?,?,?,?,?,?)');
    this.db.exec('CREATE TABLE IF NOT EXISTS proxy_quotes(second_ms INTEGER PRIMARY KEY,event_ms INTEGER NOT NULL,received_ms INTEGER NOT NULL,price REAL NOT NULL,bid REAL NOT NULL,ask REAL NOT NULL,source TEXT NOT NULL,raw_json TEXT NOT NULL)');
    this.insertQuote = this.db.prepare('INSERT OR IGNORE INTO proxy_quotes VALUES (?,?,?,?,?,?,?,?)');
    this.book = new CoinbaseBook(); this.counts = {};
    this.Socket = Socket; this.clock = clock; this.retryMs = 1000; this.stopped = true;
  }
  record(message, received = this.clock()) {
    if (message.type !== 'ticker' || message.product_id !== 'BTC-USD') return false;
    const event = Date.parse(message.time), price = Number(message.price), bid = Number(message.best_bid), ask = Number(message.best_ask);
    if (![event, received, price, bid, ask].every(Number.isFinite) || price <= 0 || bid <= 0 || ask < bid ||
        event > received + MAX_FUTURE_SKEW_MS || received - event > 5000 || event < (this.lastEvent ?? -Infinity)) {
      const reason = event > received + MAX_FUTURE_SKEW_MS ? 'future_ticker_time' : received - event > 5000 ? 'stale_ticker' : 'invalid_or_out_of_order_ticker';
      this.counts[reason] = (this.counts[reason] || 0) + 1; return false;
    }
    if (event > received) this.counts.tolerated_future_ticker = (this.counts.tolerated_future_ticker || 0) + 1;
    this.lastEvent = event;
    // First observed ticker in each receipt second is immutable and was actually available then.
    return this.insert.run(Math.floor(received / 1000) * 1000, event, received, price, bid, ask, 'coinbase:BTC-USD:ticker', JSON.stringify(message)).changes > 0;
  }
  event(name, detail = '') { if (!this.stopped) this.db.prepare('INSERT INTO feed_events(ts,event,detail) VALUES (?,?,?)').run(this.clock(), name, detail); }
  start() { this.stopped = false; this.connect(); }
  recordBook(m, received) {
    if (!this.book.apply(m, received)) return;
    const second = Math.floor(received / 1000) * 1000;
    if (second === this.lastQuoteSecond) return;
    const q = this.book.quote();
    if (!q || q.event > received + MAX_FUTURE_SKEW_MS || received - q.event > 5000) {
      this.counts.stale_or_future_book = (this.counts.stale_or_future_book || 0) + 1; return;
    }
    if (q.event > received) this.counts.tolerated_future_book = (this.counts.tolerated_future_book || 0) + 1;
    this.insertQuote.run(second, q.event, received, q.price, q.bid, q.ask, 'coinbase:BTC-USD:book-midpoint', JSON.stringify(q));
    this.lastQuoteSecond = second; this.lastQuote = received; this.retryMs = 1000;
  }
  connect() {
    if (this.stopped) return;
    this.lastEvent = undefined;
    this.book.reset(); this.lastQuoteSecond = undefined; this.lastHealth = this.clock();
    const ws = this.ws = new this.Socket('wss://ws-feed.exchange.coinbase.com', { handshakeTimeout: 10000 });
    this.lastMessage = this.clock();
    this.lastQuote = this.lastMessage; this.lastPong = this.lastMessage;
    ws.on('pong', () => { this.lastPong = this.clock(); });
    ws.on('open', () => {
      if (this.stopped) return;
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker', 'heartbeat', 'level2_batch'] }));
      this.event('connected');
    });
    ws.on('message', bytes => {
      if (this.stopped) return;
      try {
        const m = JSON.parse(bytes.toString()); this.lastMessage = this.clock();
        this.counts[m.type] = (this.counts[m.type] || 0) + 1;
        if (m.type === 'error') { this.event('server_error', String(m.message)); ws.terminate(); return; }
        if (this.record(m, this.lastMessage)) this.retryMs = 1000;
        this.recordBook(m, this.lastMessage);
      } catch (e) { this.event('record_error', e.message); ws.terminate(); }
    });
    ws.on('error', e => this.event('connection_error', JSON.stringify({ message: e.message, code: e.code })));
    ws.on('unexpected-response', (req, response) => { this.event('http_error', String(response.statusCode)); response.resume(); req.destroy(); ws.terminate(); });
    this.watchdog = setInterval(() => {
      const now = this.clock();
      if (now - this.lastHealth >= 60000) { this.event('health', JSON.stringify({ counts: this.counts, messageAgeMs: now - this.lastMessage, quoteAgeMs: now - this.lastQuote })); this.counts = {}; this.lastHealth = now; }
      // Quote rejection is a data-quality problem, not a broken transport.
      if (now - this.lastMessage > 15000 || now - this.lastPong > 30000) {
        this.event('watchdog_timeout', JSON.stringify({ messageAgeMs: now - this.lastMessage, quoteAgeMs: now - this.lastQuote, pongAgeMs: now - this.lastPong }));
        ws.terminate();
      } else if (ws.readyState === 1) ws.ping();
    }, 5000);
    ws.on('close', (code, reason) => {
      clearInterval(this.watchdog);
      if (this.stopped) return;
      this.book.reset(); this.event('disconnected', JSON.stringify({ code, reason: reason?.toString(), retryMs: this.retryMs }));
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
