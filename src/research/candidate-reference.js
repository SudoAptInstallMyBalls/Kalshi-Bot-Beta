const { ProxyReference } = require('./proxy-reference');
const { minuteVolatility } = require('../strategy/volatility');
const { averageForecast } = require('../strategy/settlement-forecast');
// Experimental adapter; deliberately separate from the frozen forward-study policy.
class CandidateReference extends ProxyReference {
  constructor(markets, spot, { volatilityReturns = 15, quantile = .95 } = {}) {
    super(markets, spot, { quantile });
    if (![15, 60].includes(volatilityReturns)) throw Error('Unsupported experimental volatility window');
    this.volatilityReturns = volatilityReturns;
  }
  getForecast(market, strike, now, options) {
    const original = super.getForecast(market, strike, now, options);
    if (!original.ready || this.volatilityReturns === 15) return original;
    const index = this.indices.get(now);
    const sigma = minuteVolatility(this.spot.slice(Math.max(0, index - this.volatilityReturns), index + 1), 900, this.volatilityReturns);
    if (sigma === null) return { ready: false, reason: 'experimental_volatility_warmup' };
    return { ...original, ...averageForecast({ now, closeTime: market.closeTime, strike, currentPrice: original.referencePrice,
      sigma, errorBps: original.errorBps }) };
  }
}
module.exports = { CandidateReference };
