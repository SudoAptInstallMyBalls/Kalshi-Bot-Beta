const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { minuteVolatility, completedMinutes } = require('../src/strategy/volatility');
const BinanceFeed = require('../src/market-data/binance-ws');
const { averageForecast } = require('../src/strategy/settlement-forecast');
const { IndexRecorder, SettlementReference } = require('../src/market-data/settlement-reference');
const { ProxyReference } = require('../src/research/proxy-reference');
const { HistoryStore } = require('../src/research/market-history');
const { evaluateForecasts } = require('../src/research/settlement-evaluation');
const { replay } = require('../src/research/history-replay');
const SignalGenerator = require('../src/agents/skills/analysis/signal-generator');
const ProbabilityModel = require('../src/agents/skills/analysis/probability-model');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-test-'));
  // Register cleanup after closing handles in each test for Windows.
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function fixture(count = 12) {
  const start = 180 * 60000;
  const spot = Array.from({ length: 180 + count * 15 }, (_, i) => ({ available_ms: (i + 1) * 60000,
    close: 10000 * (1 + .0003 * Math.sin(i)) }));
  const markets = Array.from({ length: count }, (_, i) => {
    const open = start + i * 900000, close = open + 900000, strike = 10000;
    const raw = { ticker: `KXBTC15M-TEST-${i}`, open_time: new Date(open).toISOString(), close_time: new Date(close).toISOString(),
      floor_strike: strike, expiration_value: String(10000 + (i % 2 ? -10 : 10)), result: i % 2 ? 'no' : 'yes',
      strike_type: 'greater_or_equal', settlement_ts: new Date(close + 10000).toISOString() };
    return { ...raw, raw_json: JSON.stringify(raw) };
  });
  return { markets, spot };
}

test('live and replay use identical completed-minute volatility and exclude future ticks', t => {
  const now = 20 * 60000;
  const ticks = Array.from({ length: 17 }, (_, i) => ({ timestamp: (i + 4) * 60000 - 1000, price: 10000 + Math.sin(i) * 10 }));
  const rows = completedMinutes(ticks, now);
  const feed = new BinanceFeed({}); feed.priceHistory = [...ticks, { timestamp: now + 1000, price: 1e9 }];
  t.mock.method(Date, 'now', () => now);
  assert.equal(feed.getRecentVolatility(900), minuteVolatility(rows, 900));
  assert.equal(minuteVolatility(rows, 225), minuteVolatility(rows, 900) / 2);
  assert.equal(minuteVolatility(rows.slice(-15)), null);
  assert.equal(minuteVolatility(rows.filter((r, i) => i !== 8)), null);
  assert.deepEqual(completedMinutes(ticks, now + 60000), []);
});

test('averaging model incorporates observed samples, shrinks future variance, and respects rounding', () => {
  const closeTime = 900000, window = closeTime - 60000;
  const before = averageForecast({ now: window - 1000, closeTime, strike: 10000, currentPrice: 10000, sigma: .002 });
  const observed = Array.from({ length: 60 }, (_, i) => ({ timestamp: window + i * 1000, received_ms: window + i * 1000, price: 10000 }));
  const partial = averageForecast({ now: window + 29500, closeTime, strike: 10000, currentPrice: 10000, sigma: .002, observed });
  assert.equal(partial.knownCount, 30); assert.equal(partial.futureCount, 30);
  assert.ok(partial.remainingSigma < before.remainingSigma);
  const final = averageForecast({ now: closeTime, closeTime, strike: 10000, currentPrice: 9000, sigma: .002, observed });
  assert.equal(final.probUp, 1); assert.equal(final.remainingSigma, 0);
  const below = observed.map(r => ({ ...r, price: 9999.99 }));
  assert.equal(averageForecast({ now: closeTime, closeTime, strike: 10000, currentPrice: 12000, sigma: .002, observed: below }).probUp, 0);
  const uncertain = averageForecast({ now: window - 1000, closeTime, strike: 10000, currentPrice: 10000, sigma: .002, errorBps: 10 });
  assert.ok(uncertain.lowerProbUp < uncertain.probUp && uncertain.upperProbUp > uncertain.probUp);
});

test('averaging never treats missing or not-yet-received samples as observed', () => {
  const context = { now: 840500, closeTime: 900000, strike: 100, currentPrice: 100, sigma: .002 };
  assert.equal(averageForecast(context).reason, 'missing_index_samples');
  assert.equal(averageForecast({ ...context, observed: [{ timestamp: 840000, received_ms: 841000, price: 200 }] }).reason, 'missing_index_samples');
  const sample = { timestamp: 840000, received_ms: 840000, price: 100 };
  assert.equal(averageForecast({ ...context, observed: [sample, sample] }).reason, 'duplicate_index_sample');
});

test('index recorder stamps live receipt, rejects conflicting edits and segregates historical data', t => {
  const { dir, cleanup } = temp(t), file = path.join(dir, 'index.sqlite'), recorder = new IndexRecorder(file);
  try {
    recorder.record({ timestamp: 1000, received_ms: 0, price: 100, source: 'CFB:BRTI' }, 1100);
    assert.equal(recorder.db.prepare('SELECT received_ms FROM index_samples').get().received_ms, 1100);
    assert.throws(() => recorder.record({ timestamp: 1000, price: 101, source: 'CFB:BRTI' }, 1200), /Conflicting/);
    assert.throws(() => recorder.record({ timestamp: 2000, price: 100, source: 'other' }, 2200), /Expected/);
    assert.throws(() => new IndexRecorder(file, { historical: true }), /Cannot mix/);
  } finally { recorder.close(); cleanup(); }
});

test('official reference requires live, fresh, contiguous history and official strike metadata', t => {
  const { dir, cleanup } = temp(t), file = path.join(dir, 'index.sqlite'), recorder = new IndexRecorder(file);
  const now = 20 * 60000, market = { ticker: 'KXBTC15M-TEST', openTime: now, closeTime: now + 900000, strikeSource: 'kalshi', strikeType: 'greater_or_equal' };
  const ref = new SettlementReference(file);
  try {
    recorder.db.transaction(() => {
      for (let ts = now - 17 * 60000; ts < now; ts += 1000) recorder.record({ timestamp: ts, price: 10000 + Math.sin(ts / 60000), source: 'CFB:BRTI' }, ts + 1);
    })();
    assert.equal(ref.getForecast(market, 10000, now).ready, true);
    assert.equal(ref.getForecast(market, 10000, now + 5000).reason, 'index_feed_stale');
    assert.equal(ref.getForecast({ ...market, strikeSource: null }, 10000, now).reason, 'official_strike_required');
    const before = ref.getForecast(market, 10000, now);
    recorder.record({ timestamp: now + 1000, price: 20000, source: 'CFB:BRTI' }, now + 1001);
    assert.deepEqual(ref.getForecast(market, 10000, now), before);
  } finally { ref.close(); recorder.close(); cleanup(); }
});

test('historical index observations cannot accidentally authorize live entries', t => {
  const { dir, cleanup } = temp(t), file = path.join(dir, 'index.sqlite'), recorder = new IndexRecorder(file, { historical: true });
  const ref = new SettlementReference(file);
  try { assert.equal(ref.getForecast({}, 100, 1000).reason, 'historical_index_not_live'); }
  finally { ref.close(); recorder.close(); cleanup(); }
});

test('proxy calibration includes only past published settlements, excludes own outcome, and expires', () => {
  const { markets, spot } = fixture(), proxy = new ProxyReference(markets, spot, { minimumSamples: 2, windowSamples: 3, maxAgeMs: 3600000 });
  const m = markets[4], market = { ticker: m.ticker, openTime: Date.parse(m.open_time), closeTime: Date.parse(m.close_time) }, now = market.openTime + 60000;
  const result = proxy.getForecast(market, m.floor_strike, now);
  assert.equal(result.ready, true); assert.equal(result.calibration.samples, 3);
  assert.ok(result.calibration.latestOutcomeAvailableMs < now);
  const changed = markets.map((r, i) => i >= 4 ? { ...r, expiration_value: '999999' } : r);
  assert.deepEqual(new ProxyReference(changed, spot, proxy.settings).getForecast(market, m.floor_strike, now), result);
  assert.equal(proxy.uncertainty(Date.parse(markets[0].close_time), 'other').samples, 0);
  assert.equal(proxy.uncertainty(Date.parse(markets.at(-1).close_time) + 2 * 3600000, 'other').ready, false);
  assert.equal(proxy.getForecast(market, m.floor_strike, market.closeTime - 60000).reason, 'proxy_cannot_observe_settlement_window');
});

async function signalFixture(forecast) {
  const generator = new SignalGenerator();
  const registry = new Map([
    ['probability-model', new ProbabilityModel()],
    ['binance-price-feed', { getFeed: () => ({ getRecentVolatility: () => .002 }) }],
    ['trend-analysis', { getIndicator: () => null, getTrendMultiplier: () => 1 }],
  ]);
  await generator.initialize({ registry, settlementReference: { getForecast: () => forecast }, config: {
    SETTLEMENT_AWARE: true, USE_KELLY_SIZING: false, MIN_DIVERGENCE: 0, MIN_NET_EDGE: 0, MIN_CONTRACT_PRICE: 30, MAX_CONTRACT_PRICE: 75,
  } });
  const state = { btcPrice: { binance: 100 }, marketOpenPrices: { BTC: 100 }, balance: { available: 100, total: 100 },
    openPositions: [], pendingOrders: [], updateModel() {} };
  const market = { ticker: 'BTC', openTime: 0, closeTime: 900000, yesBid: .49, yesAsk: .50, noBid: .50, noAsk: .51 };
  return { generator, state, market };
}

test('robust entry guard rejects disappearing edge and blending cannot bypass it', async () => {
  const point = { ready: true, volatilityKnown: true, probUp: .9, probDown: .1, lowerProbUp: .45, upperProbUp: .99, sigma: .002 };
  const { generator, state, market } = await signalFixture(point);
  assert.deepEqual(generator._generateSignals([market], state, 60000), []);
  generator.probabilityWeight = 0;
  assert.deepEqual(generator._generateSignals([market], state, 60000), []);
  generator.probabilityWeight = 1;
  generator.settlementReference.getForecast = () => ({ ...point, lowerProbUp: .8 });
  assert.equal(generator._generateSignals([market], state, 60000)[0].side, 'yes');
  generator.settlementReference.getForecast = () => ({ ready: false, reason: 'index_feed_missing' });
  const diagnostics = {};
  assert.deepEqual(generator._generateSignals([market], state, 60000, diagnostics), []);
  assert.equal(diagnostics.index_feed_missing, 1);
});

test('forecast evaluation spans later markets independently of trading drawdown and uses common cohorts', async t => {
  const { markets, spot } = fixture(), store = new HistoryStore(':memory:'), { dir, cleanup } = temp(t);
  try {
    for (const m of markets) {
      store.market(JSON.parse(m.raw_json), 'test');
      store.candles(m.ticker, Array.from({ length: 15 }, (_, i) => ({ end_period_ts: (Date.parse(m.open_time) + (i + 1) * 60000) / 1000,
        yes_bid: { close_dollars: '.49', low_dollars: '.49', high_dollars: '.49' },
        yes_ask: { close_dollars: '.50', low_dollars: '.50', high_dollars: '.50' }, volume_fp: '10000' })), 'live');
    }
    const score = evaluateForecasts(store.db, spot);
    assert.equal(score.all.commonMarkets, markets.length);
    assert.equal(score.all.commonForecasts, markets.length * 7);
    assert.equal(score.eligibleForecasts, markets.length * 8);
    assert.equal(score.byMinute[14].commonForecasts, 0);
    for (const m of Object.values(score.all.models)) assert.equal(m.forecasts, score.all.commonForecasts);
    const config = { ...require('../config/research/research-config.json'), strategy: { MAX_EQUITY_DRAWDOWN_PCT: .0001,
      USE_KELLY_SIZING: false, MIN_DIVERGENCE: 0, MIN_CONTRACT_PRICE: 30, MAX_CONTRACT_PRICE: 75 } };
    const trading = await replay(store.db, spot, config, { modelPath: path.join(dir, 'unused.json') });
    assert.equal(trading.riskLatched, true);
    assert.ok(trading.audit.riskPausedMarkets > 0);
    assert.deepEqual(evaluateForecasts(store.db, spot), score);
    const earlier = score.rows.filter(r => r.ts < Date.parse(markets.at(-1).open_time)).map(({ y, ...r }) => r);
    store.db.prepare('UPDATE markets SET expiration_value=?,result=? WHERE ticker=?').run('999999', 'yes', markets.at(-1).ticker);
    const after = evaluateForecasts(store.db, spot).rows.filter(r => r.ts < Date.parse(markets.at(-1).open_time)).map(({ y, ...r }) => r);
    assert.deepEqual(after, earlier);
  } finally { store.close(); cleanup(); }
});

test('execution risk check rejects stale and proxy references when settlement-aware trading is enabled', t => {
  const RiskManager = require('../src/agents/skills/trading/risk-manager');
  const risk = new RiskManager(); risk.context = { config: { SETTLEMENT_AWARE: true } };
  t.mock.method(Date, 'now', () => 10000);
  assert.equal(risk._checkSignal({}, {}).reason, 'settlement_reference_missing_or_stale');
  assert.equal(risk._checkSignal({ forecastContext: { referenceSource: 'binance_opening_return_proxy', referenceTimestamp: 10000 } }, {}).reason, 'settlement_reference_missing_or_stale');
  assert.equal(risk._checkSignal({ forecastContext: { referenceSource: 'CFB:BRTI', referenceTimestamp: 6000 } }, {}).reason, 'settlement_reference_missing_or_stale');
  assert.equal(risk._checkSignal({ forecastContext: { referenceSource: 'CFB:BRTI', referenceTimestamp: 11000 } }, {}).reason, 'settlement_reference_missing_or_stale');
  // A fresh index reference proceeds to the independent account-safety checks.
  assert.equal(risk._checkSignal({ forecastContext: { referenceSource: 'CFB:BRTI', referenceTimestamp: 9000 } }, {}).reason, 'safety_unavailable');
});
