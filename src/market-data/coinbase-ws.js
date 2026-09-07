// src/market-data/coinbase-ws.js
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const { minuteVolatility, completedMinutes } = require('#src/strategy/volatility');
const { IndexRecorder } = require('#src/market-data/settlement-reference');
const { dataDir } = require('#src/config/paths');

class CoinbaseFeed {
  constructor(state, options = {}) {
    this.state = state;
    this.product = options.product || 'BTC-USD';
    this.recordIndex = options.recordIndex ?? true; // Auto-populate settlement DB
    this.wsUrl = 'wss://ws-feed.exchange.coinbase.com';
    this.restUrl = `https://api.exchange.coinbase.com/products/${this.product}/ticker`;

    this.ws = null;
    this.running = false;
    this.wsConnected = false;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.pingInterval = null;
    this.restPollInterval = null;

    // Price history for minuteVolatility and trend indicator
    this.priceHistory = []; // [{ price, timestamp }]
    this.maxHistory = 3600; // 1 hour of 1-sec samples
    this.trendIndicator = null;
    this.lastRecordedSecond = 0;

    // Auto-feed the official settlement index SQLite if enabled
    this.recorder = null;
    if (this.recordIndex) {
      try {
        const dbPath = path.join(process.env.BOT_DATA_DIR || dataDir, 'settlement-index.sqlite');
        this.recorder = new IndexRecorder(dbPath, { historical: false });
      } catch (err) {
        console.warn('[CoinbaseFeed] IndexRecorder not started:', err.message);
      }
    }
  }

  setTrendIndicator(indicator) {
    this.trendIndicator = indicator;
  }

  start() {
    this.running = true;
    this.connectWs();
    // REST fallback poll if WS is disconnected
    this.restPollInterval = setInterval(() => {
      if (!this.wsConnected && this.running) this.pollRest();
    }, 2000);
  }

  stop() {
    this.running = false;
    this.wsConnected = false;
    clearInterval(this.pingInterval);
    clearInterval(this.restPollInterval);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    if (this.recorder) {
      try { this.recorder.close(); } catch (_) {}
    }
  }

  connectWs() {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(this.wsUrl, { handshakeTimeout: 10000 });

      this.ws.on('open', () => {
        this.wsConnected = true;
        this.reconnectDelay = 1000;

        const subscribeMsg = {
          type: 'subscribe',
          product_ids: [this.product],
          channels: ['ticker'],
        };
        this.ws.send(JSON.stringify(subscribeMsg));

        clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
        }, 15000);
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'ticker' && msg.price) {
            const price = parseFloat(msg.price);
            const bid = parseFloat(msg.best_bid || msg.price);
            const ask = parseFloat(msg.best_ask || msg.price);
            const eventMs = msg.time ? Date.parse(msg.time) : Date.now();
            this.updatePrice(price, bid, ask, eventMs);
          }
        } catch (_) {}
      });

      this.ws.on('close', () => {
        this.wsConnected = false;
        clearInterval(this.pingInterval);
        if (this.running) {
          setTimeout(() => this.connectWs(), this.reconnectDelay);
          this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
        }
      });

      this.ws.on('error', () => {
        this.ws?.close();
      });
    } catch (_) {
      setTimeout(() => this.connectWs(), this.reconnectDelay);
    }
  }

  async pollRest() {
    try {
      const res = await axios.get(this.restUrl, { timeout: 3000 });
      if (res.data?.price) {
        const price = parseFloat(res.data.price);
        const bid = parseFloat(res.data.bid || res.data.price);
        const ask = parseFloat(res.data.ask || res.data.price);
        this.updatePrice(price, bid, ask, Date.now());
      }
    } catch (_) {}
  }

  updatePrice(price, bid, ask, eventMs = Date.now()) {
    const now = Date.now();

    // 1. Update botState: write both coinbase and binance aliases
    // so all existing skills (signal-generator, risk-manager) work immediately!
    if (this.state) {
      if (!this.state.btcPrice) this.state.btcPrice = {};
      this.state.btcPrice.coinbase = price;
      this.state.btcPrice.coinbaseBid = bid;
      this.state.btcPrice.coinbaseAsk = ask;

      // Aliases ensuring backwards compatibility
      this.state.btcPrice.binance = price;
      this.state.btcPrice.binanceBid = bid;
      this.state.btcPrice.binanceAsk = ask;
      this.state.btcPrice.price = price;
      this.state.btcPrice.lastUpdate = now;
      this.state.btcPrice.source = 'coinbase';
    }

    // 2. Add to rolling 1-hour history for minuteVolatility
    this.priceHistory.push({ price, timestamp: now });
    if (this.priceHistory.length > this.maxHistory) {
      this.priceHistory.shift();
    }

    // 3. Update trend indicator if attached
    if (this.trendIndicator) {
      this.trendIndicator.update(price, now);
    }

    // 4. Stream into settlement-index.sqlite (one tick per exact second)
    const secondMs = Math.floor(now / 1000) * 1000;
    if (this.recorder && secondMs > this.lastRecordedSecond) {
      this.lastRecordedSecond = secondMs;
      try {
        this.recorder.record({
          timestamp: secondMs,
          received_ms: now,
          price,
          source: 'CFB:BRTI',
        }, now);
      } catch (_) {}
    }
  }

  getRecentVolatility(windowSeconds = 300) {
    const cutoff = Date.now() - windowSeconds * 1000;
    const samples = this.priceHistory.filter((p) => p.timestamp >= cutoff);
    if (samples.length < 2) return 0;
    const mins = completedMinutes(samples, Date.now());
    return minuteVolatility(mins, windowSeconds) || 0;
  }
}

module.exports = CoinbaseFeed;