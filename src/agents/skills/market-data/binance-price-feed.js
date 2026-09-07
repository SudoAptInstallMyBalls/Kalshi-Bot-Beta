/**
 * CoinbasePriceFeed Skill (registered under binance-price-feed for drop-in compatibility)
 *
 * Provides real-time BTC-USD spot pricing via Coinbase WebSocket.
 * Also populates settlement-index.sqlite so SettlementReference has 0 basis error.
 */

const BaseSkill = require('#src/agents/core/base-skill');
const CoinbaseFeed = require('#src/market-data/coinbase-ws');

class BinancePriceFeed extends BaseSkill {
  constructor() {
    super({
      name: 'binance-price-feed',
      description: 'Real-time BTC spot price from Coinbase WebSocket with REST fallback',
      domain: 'market-data',
      capabilities: ['get-binance-price', 'get-coinbase-price', 'get-volatility', 'get-price-history'],
      dependencies: ['state-manager'],
    });

    this.feed = null;
  }

  async initialize(context) {
    await super.initialize(context);
    const stateManager = context.registry.get('state-manager');
    this.feed = new CoinbaseFeed(stateManager.botState, { recordIndex: true });
  }

  async start() {
    await super.start();
    this.feed.start();
  }

  async stop() {
    if (this.feed) this.feed.stop();
    await super.stop();
  }

  async handleTask(task) {
    const stateManager = this.context.registry.get('state-manager');
    const btc = stateManager.botState.btcPrice || {};

    switch (task.action) {
      case 'get-coinbase-price':
      case 'get-binance-price': {
        return {
          price: btc.coinbase ?? btc.binance,
          bid: btc.coinbaseBid ?? btc.binanceBid,
          ask: btc.coinbaseAsk ?? btc.binanceAsk,
          lastUpdate: btc.lastUpdate,
          source: 'coinbase',
        };
      }

      case 'get-volatility': {
        const windowSeconds = task.params?.windowSeconds || 300;
        return { volatility: this.feed.getRecentVolatility(windowSeconds) };
      }

      case 'get-price-history': {
        return { history: this.feed.priceHistory };
      }
    }
  }

  getFeed() {
    return this.feed;
  }
}

module.exports = BinancePriceFeed;