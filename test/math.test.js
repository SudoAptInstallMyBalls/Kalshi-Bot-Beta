const { test } = require('node:test');
const assert = require('node:assert/strict');
const ProbabilityModel = require('#src/agents/skills/analysis/probability-model');
const SignalGenerator = require('#src/agents/skills/analysis/signal-generator');
const model = new ProbabilityModel();
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('normal CDF matches known quantiles, symmetry and tails', () => {
  close(model.normalCDF(0), 0.5);
  close(model.normalCDF(1), 0.841344746);
  close(model.normalCDF(-1), 0.158655254);
  close(model.normalCDF(1.96), 0.975002105);
  assert.equal(model.normalCDF(-9), 0);
  assert.equal(model.normalCDF(9), 1);
});

test('probability model scales volatility with remaining time and stays bounded', () => {
  const feed = { getRecentVolatility: () => 0.002 };
  const result = model.calculateImpliedProbability(100100, 100000, 225000, 900000, feed);
  close(result.remainingSigma, 0.001);
  close(result.probUp, 0.841344746);
  close(result.probUp + result.probDown, 1);
  assert.equal(model.calculateImpliedProbability(200000, 100000, 1, 900000, feed).probUp, 0.99);
  assert.equal(model.calculateImpliedProbability(null, 100000, 1, 900000, feed).probUp, 0.5);
});

test('Kelly uses entry odds, permits positive edge below 50% probability, and includes fees', () => {
  close(model.kellySize(0.1, 0.6, 0.08), 0.016);
  close(model.kellySize(0.2, 0.75, 0.25), 1 / 9);
  assert.ok(model.kellySize(0.1, 0.5) > 0);
  assert.ok(model.kellySize(0.1, 0.99) > 0);
  assert.equal(model.kellySize(0.1, 0.01), 0); // Implied price is invalid.
  assert.equal(model.kellySize(0.1, 0.9, 1), 0.25);
  assert.equal(model.kellySize(0.1, 0.6, 0), 0);
  close(model.kellySize(0.2, 0.6, 0.08, 0.5, 0.02), 0.08 * 0.08 / 0.48);
  assert.equal(model.kellySize(0.1, 0.4, 0.08, 0.5), 0);
});

test('risk budget includes open, pending and same-pass portfolio/ticker exposure', () => {
  const generator = new SignalGenerator();
  const state = { balance: { available: 80, total: 100 },
    openPositions: [{ ticker: 'BTC', filledContracts: 10, priceDecimal: 0.5 }],
    pendingOrders: [{ ticker: 'OTHER', contracts: 20, priceDecimal: 0.5 }] };
  const b = generator._getRiskBudget(state, 'BTC', 3, 2);
  assert.equal(b.reserve, 30);
  assert.equal(b.deployableCapital, 70);
  assert.equal(b.portfolioExposure, 18);
  assert.equal(b.marketExposure, 7);
  assert.equal(b.riskBudget, 10.5);
  assert.equal(generator._getRiskBudget(state, 'BTC', 40, 20).riskBudget, 0);
});

test('position sizing rounds down and respects remaining market capacity', () => {
  const generator = new SignalGenerator();
  generator.useKelly = false;
  const state = { balance: { available: 100, total: 100 },
    openPositions: [{ ticker: 'BTC', contracts: 30, priceDecimal: 0.5 }], pendingOrders: [] };
  const result = generator._calculatePositionSize({ state, ticker: 'BTC', price: 0.6 });
  assert.equal(result.contracts, 4);
  close(result.dollars, 2.47);
  assert.equal(generator._calculatePositionSize({ state, ticker: 'BTC', price: 0 }).contracts, 0);
});

test('unknown volatility reaches the signal generator guard instead of silently trading a fallback', () => {
  for (const sigma of [null, undefined, NaN, Infinity, 0, -1]) {
    assert.equal(model.calculateImpliedProbability(100, 100, 600000, 900000, { getRecentVolatility: () => sigma }).volatilityKnown, false);
  }
  assert.equal(model.calculateImpliedProbability(100, 100, 600000, 900000, { getRecentVolatility: () => .002 }).volatilityKnown, true);
  const generator = new SignalGenerator();
  generator.context = { registry: new Map([
    ['probability-model', model], ['binance-price-feed', { getFeed: () => ({ getRecentVolatility: () => null }) }],
  ]) };
  const diagnostics = {};
  const signals = generator._generateSignals([{ ticker: 'BTC', openTime: 0, closeTime: 900000, yesAsk: .5, noAsk: .5 }],
    { btcPrice: { binance: 100 }, marketOpenPrices: { BTC: 100 } }, 60000, diagnostics);
  assert.deepEqual(signals, []);
  assert.equal(diagnostics.volatility_unavailable, 1);
});
