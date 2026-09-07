/**
 * KalshiMarketData Skill
 *
 * Wraps the existing KalshiClient as an agent skill.
 * Handles market discovery, price refresh, balance checks, position reconciliation.
 *
 * Capabilities: fetch-balance, discover-markets, refresh-markets, fetch-market,
 *               reconcile-positions, place-order, get-order, cancel-order, sell-position
 */

const BaseSkill = require('#src/agents/core/base-skill');
const KalshiClient = require('#src/exchange/kalshi-client');

class KalshiMarketData extends BaseSkill {
  constructor() {
    super({
      name: 'kalshi-market-data',
      description: 'Kalshi API client for market data, orders, and account management',
      domain: 'market-data',
      capabilities: [
        'fetch-balance', 'discover-markets', 'refresh-markets', 'fetch-market',
        'reconcile-positions', 'place-order', 'get-order', 'cancel-order', 'sell-position',
      ],
      dependencies: ['state-manager'],
    });

    this.client = null;
    this.seriesTicker = null;
    this.slotDuration = 900;
    this._marketCache = { data: [], ts: 0 };
    this._marketCacheTTL = 3000;
  }

  async initialize(context) {
    await super.initialize(context);
    const stateManager = context.registry.get('state-manager');
    this.client = new KalshiClient(context.config, stateManager.botState);
    this.seriesTicker = context.config.SERIES_TICKER || 'KXBTC15M';
    this.slotDuration = context.config.SLOT_DURATION || 900;
  }

  async start() {
    await super.start();
  }

  async handleTask(task) {
    const state = this.context.registry.get('state-manager').botState;

    switch (task.action) {
      case 'fetch-balance': {
        const balance = await this.client.fetchBalance();
        return { balance };
      }

      case 'discover-markets': {
        return await this._discoverMarkets(state);
      }

      case 'refresh-markets': {
        return await this._refreshMarkets(state);
      }

      case 'fetch-market': {
        const ticker = task.params?.ticker;
        if (!ticker) throw new Error('ticker required');
        const market = await this.client.fetchMarket(ticker);
        return { market };
      }

      case 'reconcile-positions': {
        return await this._reconcilePositions(state);
      }

      case 'place-order': {
        throw new Error('Use order-executor execute-signals for tracked, risk-checked entries');
      }

      case 'get-order': {
        const orderId = task.params?.orderId;
        if (!orderId) throw new Error('orderId required');
        const order = await this.client.getOrder(orderId);
        return { order };
      }

      case 'cancel-order': {
        const orderId = task.params?.orderId;
        if (!orderId) throw new Error('orderId required');
        await this.client.cancelOrder(orderId);
        return { cancelled: true };
      }

      case 'sell-position': {
        const { ticker, side, count, priceCents } = task.params || {};
        const order = await this.client.sellPosition(ticker, side, count, priceCents);
        return { order };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  async _discoverMarkets(state) {
    try {
      const markets = await this.client.discoverMarkets(this.seriesTicker);
      const now = Date.now();
      const processed = [];

      for (const m of markets) {
        const closeTime = new Date(m.close_time).getTime();
        if (closeTime <= now) continue;

        const ticker = m.ticker;

        // 1. Lock onto Kalshi's official target strike price
        const kalshiTarget = Number(m.floor_strike);
        if (kalshiTarget > 0) {
          state.marketOpenPrices[ticker] = kalshiTarget;
        } else {
          delete state.marketOpenPrices[ticker];
        }

        // 2. Parse decimal dollar fields from Kalshi V2 API
        const yesBid = m.yes_bid_dollars != null ? parseFloat(m.yes_bid_dollars) : (m.yes_bid != null ? m.yes_bid / 100 : 0);
        const yesAsk = m.yes_ask_dollars != null ? parseFloat(m.yes_ask_dollars) : (m.yes_ask != null ? m.yes_ask / 100 : 0);
        const noBid = m.no_bid_dollars != null ? parseFloat(m.no_bid_dollars) : (m.no_bid != null ? m.no_bid / 100 : (yesAsk > 0 ? +(1 - yesAsk).toFixed(2) : 0));
        const noAsk = m.no_ask_dollars != null ? parseFloat(m.no_ask_dollars) : (m.no_ask != null ? m.no_ask / 100 : (yesBid > 0 ? +(1 - yesBid).toFixed(2) : 0));
        const lastPrice = m.last_price_dollars != null ? parseFloat(m.last_price_dollars) : (m.last_price != null ? m.last_price / 100 : 0);

        processed.push({
          ticker,
          eventTicker: m.event_ticker,
          exchangeIndex: m.exchange_index,
          title: m.title,
          targetPrice: kalshiTarget > 0 ? kalshiTarget : null,
          strikeSource: kalshiTarget > 0 ? 'kalshi' : null,
          strikeType: m.strike_type,
          openTime: new Date(m.open_time).getTime(),
          closeTime,
          yesBid,
          yesAsk,
          noBid,
          noAsk,
          yesBidCents: Math.round(yesBid * 100),
          yesAskCents: Math.round(yesAsk * 100),
          noBidCents: Math.round(noBid * 100),
          noAskCents: Math.round(noAsk * 100),
          lastPrice,
          minutesUntilClose: Math.floor((closeTime - now) / 60000),
          secondsUntilClose: Math.floor((closeTime - now) / 1000),
          status: m.status,
          quoteUpdatedAt: now,
          quoteStale: false,
        });
      }

      state.updateMarkets(processed);

      // Clean up old open prices
      for (const ticker of Object.keys(state.marketOpenPrices)) {
        if (!processed.find(m => m.ticker === ticker)) {
          delete state.marketOpenPrices[ticker];
        }
      }

      return { markets: processed, count: processed.length };
    } catch (err) {
      return { markets: [], count: 0, error: err.message };
    }
  }

  async _refreshMarkets(state) {
    if(this.context?.config?.ENABLE_TELEMETRY && Date.now()-(this._lastResolutionCheck||0)>60000) {
      this._lastResolutionCheck=Date.now();
      await require('#src/storage/research-telemetry').resolveOne(this.client);
    }
    const markets = state.activeMarkets;
    if (markets.length === 0) return { markets: [], count: 0 };

    const results = await Promise.allSettled(
      markets.map(m => this.client.fetchMarket(m.ticker))
    );

    const refreshed = markets.map((m, i) => {
      if (results[i].status === 'fulfilled' && results[i].value) {
        const val = results[i].value;
        // Keep strike price synchronized
        if (val.targetPrice && val.targetPrice > 0) {
          state.marketOpenPrices[m.ticker] = val.targetPrice;
        } else {
          delete state.marketOpenPrices[m.ticker];
        }
        return { ...m, ...val, quoteUpdatedAt: Date.now(), quoteStale: false };
      }
      return { ...m, quoteStale: true };
    });

    state.updateMarkets(refreshed);
    this._marketCache = { data: refreshed, ts: Date.now() };

    // Update unrealized P&L
    if (state.openPositions.length > 0) {
      let unrealized = 0;
      for (const pos of state.openPositions) {
        const market = refreshed.find(m => m.ticker === pos.ticker);
        if (!market) continue;
        const currentBid = pos.side === 'yes' ? (market.yesBid || 0) : (market.noBid || 0);
        unrealized += (currentBid - pos.priceDecimal) * (pos.filledContracts || pos.contracts);
      }
      state.updateUnrealizedPnL(unrealized);
    }

    return { markets: refreshed, count: refreshed.length };
  }

  async _reconcilePositions(state) {
    try {
      // Compare authoritative quantities without deleting local orders or
      // inventing zero-cost positions. Missing fill history needs reconciliation.
      const remote = await this.client.fetchPositions(this.seriesTicker);
      const remoteMap = new Map(), localMap = new Map();
      for (const p of remote) {
        const quantity = p.position_fp ?? p.position;
        const net = quantity != null ? Number(quantity) : Number(p.yes_sub_total ?? 0) - Number(p.no_sub_total ?? 0);
        if (!Number.isFinite(net)) throw new Error('Invalid remote position quantity');
        remoteMap.set(p.ticker, (remoteMap.get(p.ticker) || 0) + net);
      }
      // A finalized position disappears from the exchange's open-position list.
      // Require its account settlement quantity to match before booking a local close.
      const manager = this.context?.registry?.get('position-manager');
      for (const p of [...state.openPositions]) {
        if (!manager || typeof this.client.fetchSettlements !== 'function' || p.closeTime > Date.now() ||
          remoteMap.get(p.ticker) || p.exitOrder || p.exitSubmissionUnknown || p.type === 'RECONCILED' ||
          state.pendingOrders.some(o => o.ticker === p.ticker) || state.openPositions.filter(o => o.ticker === p.ticker).length !== 1) continue;
        const market = await this.client.fetchMarket(p.ticker);
        if (market?.status !== 'finalized' || !['yes','no'].includes(market.result)) continue;
        const settlements = await this.client.fetchSettlements(p.ticker);
        if (settlements.length !== 1) continue;
        const settled = settlements[0], quantity = Number(p.filledContracts ?? p.contracts);
        const held = Number(settled[p.side === 'yes' ? 'yes_count_fp' : 'no_count_fp']);
        const opposite = Number(settled[p.side === 'yes' ? 'no_count_fp' : 'yes_count_fp']);
        if (!(quantity > 0) || held !== quantity || opposite !== 0 || settled.market_result !== market.result ||
          Number(settled.revenue) !== (p.side === market.result ? quantity * 100 : 0)) continue;
        const previous = p.reconciliationRequired;
        delete p.reconciliationRequired;
        try { await manager._settlePosition(p.orderId); }
        finally {
          if (state.openPositions.includes(p)) p.reconciliationRequired = previous;
          state.saveNow();
        }
      }
      for (const p of state.openPositions) {
        const quantity = Number(p.filledContracts ?? p.contracts ?? 0);
        if (!Number.isFinite(quantity)) throw new Error('Invalid local position quantity');
        localMap.set(p.ticker, (localMap.get(p.ticker) || 0) + (p.side === 'yes' ? quantity : -quantity));
      }
      const mismatches = [...new Set([...remoteMap.keys(), ...localMap.keys()])]
        .filter(ticker => Math.abs((remoteMap.get(ticker) || 0) - (localMap.get(ticker) || 0)) > 1e-8)
        .map(ticker => ({ ticker, local: localMap.get(ticker) || 0, remote: remoteMap.get(ticker) || 0 }));
      const pending = state.pendingOrders.length;
      if (mismatches.length || pending || state.openPositions.some(p => p.type === 'RECONCILED')) {
        state.safety?.halt('portfolio_reconciliation_required');
        for (const p of state.openPositions) {
          if (mismatches.some(m => m.ticker === p.ticker) || p.type === 'RECONCILED') p.reconciliationRequired = true;
        }
        state.saveNow();
      }
      return { added: 0, removed: 0, pruned: 0, total: state.openPositions.length, mismatches,
        pendingOrdersPreserved: pending, requiresReview: !!(mismatches.length || pending) };
    } catch (err) {
      state.safety?.halt('portfolio_reconciliation_failed');
      return { error: err.message, added: 0, removed: 0 };
    }
  }

  /**
   * Direct access to underlying client and cache.
   */
  getClient() { return this.client; }
  getMarketCache() { return this._marketCache; }

  async stop() {
    await super.stop();
  }
}

module.exports = KalshiMarketData;
