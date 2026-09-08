const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const { normalizeOrder } = require('#src/execution/kalshi-order');
const { notSubmitted } = require('#src/execution/order-rejection');
const { orderCost } = require('#src/risk/trading-math');

class KalshiClient {
  constructor(config, state) {
    this.config = config;
    this.state = state;
    this.privateKeyPem = null;
    this.baseUrl = config.KALSHI_API_BASE || 'https://api.elections.kalshi.com';
  }

  loadPrivateKey() {
    if (!this.privateKeyPem) {
      // Support a base64-encoded key supplied through the local environment.
      if (process.env.KALSHI_PRIVATE_KEY_BASE64) {
        console.warn('[Kalshi] Using KALSHI_PRIVATE_KEY_BASE64 credentials; this overrides KALSHI_PRIVATE_KEY_PATH.');
        this.privateKeyPem = Buffer.from(process.env.KALSHI_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
      } else {
        const keyPath = this.config.KALSHI_PRIVATE_KEY_PATH || './kalshi_private_key.pem';
        if (!fs.existsSync(keyPath)) {
          throw new Error(`Private key not found: ${keyPath}. Set KALSHI_PRIVATE_KEY_PATH.`);
        }
        this.privateKeyPem = fs.readFileSync(keyPath, 'utf8');
      }
    }
    return this.privateKeyPem;
  }

  generateAuth(method, apiPath) {
    const pem = this.loadPrivateKey();
    const timestampMs = Date.now().toString();
    // Kalshi requires signing the API path WITHOUT query parameters.
    const pathWithoutQuery = apiPath.split('?')[0];
    const message = timestampMs + method + pathWithoutQuery;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(message);
    sign.end();

    const signature = sign.sign({
      key: pem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }, 'base64');

    return {
      headers: {
        'Content-Type': 'application/json',
        'KALSHI-ACCESS-KEY': this.config.KALSHI_API_KEY,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestampMs,
      },
    };
  }

  async get(apiPath) {
    this.checkAuthentication();
    const auth = this.generateAuth('GET', apiPath);
    return this.guardRequest(() => axios.get(`${this.baseUrl}${apiPath}`, { ...auth, timeout: 8000 }));
  }

  async post(apiPath, body) {
    this.checkAuthentication();
    const auth = this.generateAuth('POST', apiPath);
    return this.guardRequest(() => axios.post(`${this.baseUrl}${apiPath}`, body, { ...auth, timeout: 8000 }));
  }

  async delete(apiPath) {
    this.checkAuthentication();
    const auth = this.generateAuth('DELETE', apiPath);
    return this.guardRequest(() => axios.delete(`${this.baseUrl}${apiPath}`, { ...auth, timeout: 8000 }));
  }

  checkAuthentication() {
    if (this.state.safety?.authFailed) throw new Error('Authentication circuit breaker is latched');
  }

  async guardRequest(request) {
    try { return await request(); }
    catch (err) {
      if (Number(err.response?.status) === 401) this.state.safety?.authenticationFailure();
      throw err;
    }
  }

  async fetchBalance() {
    try {
      const resp = await this.get('/trade-api/v2/portfolio/balance');
      const available = resp.data.balance_dollars != null ? Number(resp.data.balance_dollars) : Number(resp.data.balance) / 100;
      if (!Number.isFinite(available) || available < 0) throw new Error('Invalid account balance');

      const balance = {
        total: available,
        available,
        reserved: 0,
        equity: available + Number(resp.data.portfolio_value || 0) / 100,
        observedAt: Date.now(),
        exchangeBalances: resp.data.balance_breakdown,
      };

      this.state.updateBalance(balance);
      if(this.config.ENABLE_TELEMETRY) require('#src/storage/research-telemetry').record('recordEquity',balance,this.state.openPositions || [],this.state.riskState);
      this.state.updateKalshiConnection(true);
      return balance;
    } catch (error) {
      this.state.updateKalshiConnection(false);
      throw error;
    }
  }

  async discoverMarkets(seriesTicker) {
    const apiPath = `/trade-api/v2/markets?series_ticker=${seriesTicker}&limit=20&status=open`;
    const resp = await this.get(apiPath);
    return resp.data.markets || [];
  }

async fetchMarket(ticker) {
    try {
      const resp = await this.get(`/trade-api/v2/markets/${ticker}`);
      const m = resp.data.market;

      // 1. Extract Kalshi's official target / strike price
      const targetPrice = Number(m.floor_strike);

      // 2. Support both new (*_dollars) and legacy (*_cents) Kalshi API fields
      const yesBid = m.yes_bid_dollars != null ? parseFloat(m.yes_bid_dollars) : (m.yes_bid != null ? m.yes_bid / 100 : 0);
      const yesAsk = m.yes_ask_dollars != null ? parseFloat(m.yes_ask_dollars) : (m.yes_ask != null ? m.yes_ask / 100 : 0);

      const noBid = m.no_bid_dollars != null
        ? parseFloat(m.no_bid_dollars)
        : (m.no_bid != null ? m.no_bid / 100 : (yesAsk > 0 ? +(1 - yesAsk).toFixed(2) : 0));

      const noAsk = m.no_ask_dollars != null
        ? parseFloat(m.no_ask_dollars)
        : (m.no_ask != null ? m.no_ask / 100 : (yesBid > 0 ? +(1 - yesBid).toFixed(2) : 0));

      const lastPrice = m.last_price_dollars != null
        ? parseFloat(m.last_price_dollars)
        : (m.last_price != null ? m.last_price / 100 : 0);

      const yesBidCents = Math.round(yesBid * 100);
      const yesAskCents = Math.round(yesAsk * 100);
      const noBidCents = Math.round(noBid * 100);
      const noAskCents = Math.round(noAsk * 100);

      // 3. Return the single combined market object
      return {
        ticker: m.ticker,
        exchangeIndex: m.exchange_index,
        priceRanges: m.price_ranges,
        status: m.status,
        result: m.result,
        targetPrice: targetPrice > 0 ? targetPrice : null,
        strikeSource: Number.isFinite(targetPrice) && targetPrice > 0 ? 'kalshi' : null,
        strikeType: m.strike_type,
        yesBid,
        yesAsk,
        noBid,
        noAsk,
        lastPrice,
        yesBidCents,
        yesAskCents,
        noBidCents,
        noAskCents,
        openTime: new Date(m.open_time).getTime(),
        closeTime: new Date(m.close_time).getTime(),
      };
    } catch (error) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  async placeOrder(orderData) {
    this.checkAuthentication();
    if (!orderData.reduce_only) {
      const check = this.state.safety?.check();
      if (!check?.approved) throw new Error(`Trading blocked: ${check?.reason || 'safety_unavailable'}`);
    }
    let routed;
    try {
      const market = await this.fetchMarket(orderData.ticker);
      const exchangeIndex = market?.exchangeIndex;
      if (!Number.isInteger(exchangeIndex) || exchangeIndex < 0) {
        throw new Error('Authoritative market exchange_index unavailable');
      }
      routed = { ...orderData, exchange_index: exchangeIndex };
      let limit = Number(orderData.price);
      if (orderData.reduce_only) {
        // Improve toward the fresh executable quote, without relaxing the requested limit.
        const quote = orderData.side === 'ask' ? market.yesBid : market.yesAsk;
        if (Number.isFinite(quote) && quote > 0 && quote < 1) {
          limit = orderData.side === 'ask' ? Math.max(limit, quote) : Math.min(limit, quote);
        }
      }
      routed.price = require('#src/execution/price-grid').snapLimit(limit, orderData.side, market.priceRanges).toFixed(4);
      if (!orderData.reduce_only) {
        const response = await this.get(`/trade-api/v2/portfolio/balance?exchange_index=${exchangeIndex}`);
        const data = response.data;
        const available = data.balance_dollars != null ? Number(data.balance_dollars) : Number(data.balance) / 100;
        const price = orderData.side === 'bid' ? Number(orderData.price) : 1 - Number(orderData.price);
        const count = Number(orderData.count);
        if (!Number.isFinite(available) || available < 0 || !Number.isInteger(count) || count <= 0 || !(price > 0 && price < 1)) {
          throw new Error('Invalid shard balance or order');
        }
        const cost = orderCost(count, price, this.config.TAKER_FEE_RATE ?? 0.07);
        if (available < cost) {
          throw notSubmitted(`Exchange ${exchangeIndex} has $${available.toFixed(2)} available; order needs $${cost.toFixed(2)}. Allocate funds to this exchange before restarting.`, 'exchange_balance_insufficient');
        }
        // The account reads above may yield while an unrelated safety halt occurs.
        const check = this.state.safety?.check();
        if (!check?.approved) throw new Error(`Trading blocked: ${check?.reason || 'safety_unavailable'}`);
      }
    } catch (err) {
      err.orderNotSubmitted = true;
      err.haltReason ||= 'order_preflight_failed';
      throw err;
    }
    try {
      if(this.config.ENABLE_TELEMETRY) require('#src/storage/research-telemetry').record('recordEvent','submit',{...routed});
      const resp = await this.post('/trade-api/v2/portfolio/events/orders', routed);
      if(this.config.ENABLE_TELEMETRY) require('#src/storage/research-telemetry').record('recordEvent','acknowledgment',{client_order_id:routed.client_order_id,order:resp.data.order || resp.data});
      this.state.safety?.executionSucceeded();
      return normalizeOrder(resp.data.order || resp.data);
    } catch (err) {
      this.state.safety?.executionFailed();
      const rejection = err.response?.data?.error || err.response?.data || {};
      if(this.config.ENABLE_TELEMETRY) require('#src/storage/research-telemetry').record('recordEvent','submission_error',{client_order_id:routed.client_order_id,status:err.response?.status,code:rejection.code,message:rejection.message,details:rejection.details});
      throw err;
    }
  }

  async getOrder(orderId) {
    const resp = await this.get(`/trade-api/v2/portfolio/orders/${orderId}`);
    if(this.config.ENABLE_TELEMETRY) require('#src/storage/research-telemetry').record('recordEvent','order_observed',{order:resp.data.order || resp.data});
    return normalizeOrder(resp.data.order || resp.data);
  }

  async findOrderByClientId(ticker, clientOrderId) {
    if (!ticker || !clientOrderId) throw new Error('Order lookup requires ticker and client order id');
    const matches = new Map(), seen = new Set();
    let cursor;
    do {
      const response = await this.get(`/trade-api/v2/portfolio/orders?ticker=${encodeURIComponent(ticker)}&limit=100` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
      if (!Array.isArray(response.data.orders)) throw new Error('Missing orders array');
      for (const order of response.data.orders) {
        if (order.client_order_id === clientOrderId && order.ticker === ticker) {
          if (!order.order_id) throw new Error('Matched order missing identity');
          matches.set(order.order_id, normalizeOrder(order));
        }
      }
      cursor = response.data.cursor;
      if (cursor && seen.has(cursor)) throw new Error('Repeated orders cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (matches.size > 1) throw new Error('Ambiguous client order identity');
    // Absence (including historical cutoff) never proves a POST was rejected.
    return matches.values().next().value || null;
  }

  async cancelOrder(orderId, ticker) {
    ticker ||= [...(this.state.pendingOrders || []), ...(this.state.openPositions || [])]
      .find(p => p.orderId === orderId || p.exitOrder?.id === orderId)?.ticker;
    if (!ticker) throw new Error('Market ticker required to route cancellation; order preserved');
    if(this.config.ENABLE_TELEMETRY) require('#src/storage/research-telemetry').record('recordEvent','cancel_request',{orderId,ticker});
    const resp = await this.delete(`/trade-api/v2/portfolio/events/orders/${encodeURIComponent(orderId)}?market_ticker=${encodeURIComponent(ticker)}`);
    if(this.config.ENABLE_TELEMETRY) require('#src/storage/research-telemetry').record('recordEvent','cancel_acknowledgment',{orderId,ticker,response:resp.data});
    return resp.data;
  }

  // Fetch actual positions from Kalshi (for reconciliation on startup)
  async fetchSettlements(ticker) {
    const response = await this.get(`/trade-api/v2/portfolio/settlements?ticker=${encodeURIComponent(ticker)}&subaccount=0&limit=100`);
    if (!Array.isArray(response.data.settlements) || response.data.cursor) throw new Error('Ambiguous settlement history');
    return response.data.settlements.filter(s => s.ticker === ticker);
  }

  async fetchPositions(seriesTicker) {
    try {
      const all = [], seen = new Set();
      let cursor;
      do {
        const apiPath = '/trade-api/v2/portfolio/positions?count_filter=position&limit=1000' +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const resp = await this.get(apiPath);
        if (!Array.isArray(resp.data.market_positions)) throw new Error('Missing portfolio positions array');
        all.push(...resp.data.market_positions);
        cursor = resp.data.cursor;
        if (cursor && seen.has(cursor)) throw new Error('Repeated portfolio cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
      return all.filter(p => p.ticker && p.ticker.startsWith(seriesTicker));
    } catch (error) {
      console.error('[Kalshi] Failed to fetch positions:', error.message);
      // An unavailable portfolio is not an empty one: reconciliation must not
      // erase locally tracked exposure after an authentication/network failure.
      throw error;
    }
  }

  // Sell existing position (for take-profit before settlement)
  async sellPosition(ticker, side, count, priceCents, clientOrderId = crypto.randomUUID()) {
    const isYes = side === 'yes';
    const bookSide = isYes ? 'ask' : 'bid';
    const priceDollars = isYes
      ? (priceCents / 100).toFixed(4)
      : ((100 - priceCents) / 100).toFixed(4);

    const orderData = {
      ticker,
      client_order_id: clientOrderId,
      side: bookSide,
      count: Number(count).toFixed(2),
      price: priceDollars,
      time_in_force: 'immediate_or_cancel',
      self_trade_prevention_type: 'taker_at_cross',
      post_only: false,
      cancel_order_on_pause: false,
      reduce_only: true,
    };

    return this.placeOrder(orderData);
  }
}

module.exports = KalshiClient;
