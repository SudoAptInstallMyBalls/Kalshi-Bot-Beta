const DEFAULTS = require('#src/config/defaults');

function assertReplayRegistry(generator, registry) {
  for (const name of generator.dependencies) {
    if (!registry.has(name)) throw new Error(`Replay registry missing dependency: ${name}`);
  }
  return registry;
}

function createReplayRegistry({ generator, probability, getSpot, getState, strategy }) {
  return assertReplayRegistry(generator, new Map([
    ['state-manager', { get botState() { return getState(); } }],
    ['probability-model', probability],
    ['binance-price-feed', { getFeed: () => ({ getRecentVolatility: () => getSpot().sigma }) }],
    ['polymarket-price-feed', { getCachedPrice: () => null }],
    ['trend-analysis', { getIndicator: () => ({ getTrend: getSpot }), getTrendMultiplier: side => {
      const spot = getSpot();
      if (strategy.TREND_ENABLED === false || spot.trend === 'NEUTRAL') return 1;
      const aligned = (side === 'yes') === (spot.trend === 'BULLISH');
      return aligned ? 1 + (strategy.TREND_BOOST ?? DEFAULTS.TREND_BOOST) : 1 - (strategy.TREND_PENALTY ?? DEFAULTS.TREND_PENALTY);
    } }],
  ]));
}
module.exports = { createReplayRegistry, assertReplayRegistry };
