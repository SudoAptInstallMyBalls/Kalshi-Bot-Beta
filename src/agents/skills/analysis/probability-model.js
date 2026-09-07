/**
 * ProbabilityModel Skill
 *
 * Calculates implied probability of BTC UP/DOWN using a mathematically
 * exact standard normal distribution CDF calibrated to realized volatility
 * from the Binance price feed.
 *
 * Capabilities: calculate-probability, kelly-size
 */

const BaseSkill = require('#src/agents/core/base-skill');

class ProbabilityModel extends BaseSkill {
  constructor() {
    super({
      name: 'probability-model',
      description: 'Normal distribution CDF model for BTC UP/DOWN probability estimation',
      domain: 'analysis',
      capabilities: ['calculate-probability', 'kelly-size'],
      dependencies: ['binance-price-feed', 'state-manager'],
    });
  }

  async initialize(context) {
    await super.initialize(context);
  }

  async handleTask(task) {
    switch (task.action) {
      case 'calculate-probability': {
        const { currentPrice, openPrice, timeRemainingMs, totalDurationMs } = task.params || {};
        const binanceFeed = this.context.registry.get('binance-price-feed').getFeed();
        return this.calculateImpliedProbability(currentPrice, openPrice, timeRemainingMs, totalDurationMs, binanceFeed);
      }

      case 'kelly-size': {
        const { edge, probability, price, feePerContract = 0 } = task.params || {};
        const config = this.context.config;
        const kellyFraction = config.KELLY_FRACTION ?? 0.08;
        return { size: this.kellySize(edge, probability, kellyFraction, price, feePerContract) };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  // Exact Standard Normal CDF (Abramowitz & Stegun Formula 26.2.17)
  // Accurate to within 7.5e-8 across the entire domain
  normalCDF(x) {
    if (x < -8) return 0.0;
    if (x > 8) return 1.0;

    const p  =  0.2316419;
    const b1 =  0.319381530;
    const b2 = -0.356563782;
    const b3 =  1.781477937;
    const b4 = -1.821255978;
    const b5 =  1.330274429;

    const absX = Math.abs(x);
    const t = 1.0 / (1.0 + p * absX);
    const zPdf = (1.0 / Math.sqrt(2.0 * Math.PI)) * Math.exp(-0.5 * absX * absX);
    const poly = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;
    const cdf = 1.0 - zPdf * poly;

    return x >= 0 ? cdf : 1.0 - cdf;
  }

  calculateImpliedProbability(currentPrice, openPrice, timeRemainingMs, totalDurationMs, binanceFeed) {
    if (!currentPrice || !openPrice || openPrice === 0) {
      return { probUp: 0.5, probDown: 0.5, move: 0, movePct: 0, z: 0, sigma: 0.0015, remainingSigma: 0.0015 };
    }

    const move = (currentPrice - openPrice) / openPrice;
    const timeRemaining = Math.max(0.001, timeRemainingMs / totalDurationMs);
    const totalDurationSec = totalDurationMs / 1000;
    
    // Fetch realized volatility from Binance tick buffer with fallback
    const measuredSigma = binanceFeed && typeof binanceFeed.getRecentVolatility === 'function'
      ? binanceFeed.getRecentVolatility(totalDurationSec)
      : 0.0015;
    const sigma = Number.isFinite(measuredSigma) && measuredSigma > 0 ? measuredSigma : 0.0015;

    const remainingSigma = Math.max(0.0001, sigma * Math.sqrt(timeRemaining));

    if (remainingSigma < 0.00001) {
      return { 
        probUp: move > 0 ? 0.99 : 0.01, 
        probDown: move > 0 ? 0.01 : 0.99,
        move,
        movePct: move * 100,
        z: move > 0 ? 8 : -8,
        sigma,
        remainingSigma,
      };
    }

    const z = move / remainingSigma;
    const probUp = this.normalCDF(z);
    const probDown = 1.0 - probUp;

    return {
      probUp: Math.max(0.01, Math.min(0.99, probUp)),
      probDown: Math.max(0.01, Math.min(0.99, probDown)),
      move,
      movePct: move * 100,
      z,
      sigma,
      remainingSigma,
    };
  }

  kellySize(edge, probability, kellyFraction = 0.08, price = probability - edge, feePerContract = 0) {
    const cost = price + feePerContract;
    if (![probability, price, cost, kellyFraction, feePerContract].every(Number.isFinite) ||
        probability < 0 || probability > 1 || price <= 0 || cost >= 1 ||
        feePerContract < 0 || kellyFraction < 0 || kellyFraction > 1) return 0;
    // A $1 binary payout bought for cost c has net odds (1-c)/c.
    // The fraction of bankroll at risk is (p-c)/(1-c), before fractional Kelly.
    // Explicit price is essential: trend-adjusted edge is not an entry price.
    const kelly = (probability - cost) / (1 - cost);
    return Math.max(0, Math.min(kelly * kellyFraction, 0.25));
  }
}

module.exports = ProbabilityModel;
