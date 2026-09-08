const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const axios = require('axios');
const TradingSafety = require('#src/risk/trading-safety');
const RiskManager = require('#src/agents/skills/trading/risk-manager');
const KalshiClient = require('#src/exchange/kalshi-client');
const OrderExecutor = require('#src/agents/skills/trading/order-executor');
const MasterAgent = require('#src/agents/core/master-agent');

function setup(config = {}, now = Date.now) {
  const state = new EventEmitter();
  Object.assign(state, { stats: { totalPnL: 200 }, balance: { total: 100, available: 100 },
    openPositions: [], pendingOrders: [], activeMarkets: [] });
  state.updateIntent = v => { state.intent = v; };
  state.updateKalshiConnection = () => {};
  state.updateBalance = v => { state.balance = v; state.emit('balance', v); };
  state.safety = new TradingSafety(state, config, now);
  state.safety.entriesEnabled = true;
  state.updateBalance(state.balance);
  return state;
}

const signal = { ticker: 'BTC', contracts: 10, priceCents: 50, priceDecimal: 0.5, side: 'yes', type: 'DIRECTIONAL_YES' };

test('session baseline excludes persisted historical PnL; drawdown halves once and pauses', () => {
  let now = 1000;
  const state = setup({}, () => now);
  const risk = new RiskManager();
  risk.maxRiskFraction = 1; // Isolate session multiplier from the separately tested equity cap.
  risk.maxPositionSize = 25; // Isolate the multiplier from the fee-inclusive $5 default.
  assert.equal(risk._checkSignal(signal, state).contracts, 10);
  state.stats.totalPnL = 189;
  assert.equal(risk._checkSignal(signal, state).contracts, 5);
  assert.equal(risk._checkSignal(signal, state).contracts, 5);
  assert.equal(risk._checkSignal({ ...signal, contracts: 1 }, state).approved, false);
  state.stats.totalPnL = 179;
  const paused = state.safety.check();
  assert.equal(paused.reason, 'session_drawdown');
  assert.equal(paused.pauseUntil, 901000);
  now = 901000;
  assert.equal(state.safety.check().approved, true);
  assert.equal(state.safety.check().sizeMultiplier, 0.5);
  state.stats.totalPnL = 178;
  assert.equal(state.safety.check().reason, 'session_drawdown');
});

test('minimum balance distinguishes unknown startup from funded account and latches', () => {
  const state = setup();
  state.updateBalance({ total: 5, available: 0 }); // Reserved capital alone does not trip it.
  assert.equal(state.safety.check().approved, true);
  state.updateBalance({ total: 4.99, available: 4.99 });
  assert.equal(state.safety.check().reason, 'minimum_balance');
  state.updateBalance({ total: 100, available: 100 });
  assert.equal(state.safety.check().approved, false);
});

test('all safety thresholds accept configuration overrides', () => {
  const state = setup({ SESSION_DRAWDOWN_REDUCE_PCT: 0.05,
    SESSION_DRAWDOWN_PAUSE_PCT: 0.08, SESSION_DRAWDOWN_PAUSE_MS: 100,
    MAX_EXECUTION_FAILURES: 2, MIN_TRADING_BALANCE: 10 }, () => 1000);
  state.stats.totalPnL = 194;
  assert.equal(state.safety.check().sizeMultiplier, 0.5);
  state.stats.totalPnL = 191;
  assert.equal(state.safety.check().pauseUntil, 1100);
  state.safety.executionFailed();
  state.safety.executionFailed();
  assert.equal(state.safety.haltReason, 'execution_failures');
  assert.equal(setup({ MIN_TRADING_BALANCE: 101 }).safety.haltReason, 'minimum_balance');
});

test('fifth failed placement stops sixth POST; a successful placement resets the streak', async t => {
  const state = setup();
  const client = new KalshiClient({}, state);
  client.generateAuth = () => ({});
  client.fetchMarket = async () => ({ exchangeIndex: 2 });
  client.get = async () => ({ data: { balance_dollars: '100.00' } });
  const entry = { ticker: 'BTC', side: 'bid', count: '1.00', price: '0.50' };
  let posts = 0, fail = true;
  t.mock.method(axios, 'post', async () => {
    posts++;
    if (fail) throw Object.assign(new Error('rejected'), { response: { status: 500 } });
    return { data: { order: { order_id: 'accepted' } } };
  });
  for (let i = 0; i < 4; i++) await assert.rejects(client.placeOrder(entry));
  fail = false;
  await client.placeOrder(entry);
  assert.equal(state.safety.failureStreak, 0);
  fail = true;
  for (let i = 0; i < 5; i++) await assert.rejects(client.placeOrder(entry));
  assert.equal(state.safety.haltReason, 'execution_failures');
  const before = posts;
  await assert.rejects(client.placeOrder({}), /Trading blocked/);
  assert.equal(posts, before);
  fail = false;
  await client.placeOrder({ ...entry, reduce_only: true }); // Existing positions can still exit.
  assert.equal(state.safety.haltReason, 'execution_failures');
});

test('401 on a balance GET blocks subsequent GET, POST and DELETE immediately', async t => {
  const state = setup();
  const client = new KalshiClient({}, state);
  client.generateAuth = () => ({});
  let calls = 0;
  t.mock.method(axios, 'get', async () => {
    calls++;
    throw Object.assign(new Error('unauthorized'), { response: { status: 401 } });
  });
  await assert.rejects(client.fetchBalance());
  assert.equal(state.safety.haltReason, 'authentication_failed');
  await assert.rejects(client.get('/test'), /latched/);
  await assert.rejects(client.post('/test', {}), /latched/);
  await assert.rejects(client.delete('/test'), /latched/);
  assert.equal(calls, 1);
});

test('scan runner refuses dispatch while halted and execution rechecks after a pause', async () => {
  const state = setup();
  state.safety.halt('execution_failures');
  let dispatches = 0;
  const master = Object.create(MasterAgent.prototype);
  master.running = true;
  master.registry = { get: () => ({ botState: state }) };
  master.orchestrator = { dispatch: () => { dispatches++; } };
  await master._runScan();
  assert.equal(dispatches, 0);
  const executor = new OrderExecutor();
  executor.context = { registry: { get: () => new RiskManager() } };
  const result = await executor._executeSignal(signal, state, null, null);
  assert.equal(result.status, 'blocked');
});

test('ML shrink and session halving are applied once; dollar cap is enforced', () => {
  const state = setup();
  const risk = new RiskManager();
  risk.maxRiskFraction = 1; // Isolate these multipliers; production defaults remain 1%.
  risk.maxPositionSize = 5;
  assert.equal(risk._checkSignal({ ...signal, mlAdjustment: 0.6 }, state).contracts, 6);
  state.stats.totalPnL = 189;
  assert.equal(risk._checkSignal({ ...signal, mlAdjustment: 0.6 }, state).contracts, 3);
  assert.equal(risk._checkSignal({ ...signal, mlAdjustment: 2 }, state).contracts, 4); // $2.50 cap includes fees.
});

test('MasterAgent shutdown waits for an in-flight scan before flushing skills', async () => {
  const state = setup();
  const master = Object.create(MasterAgent.prototype);
  master.running = true;
  master.log = () => {};
  let finishScan, flushed = false;
  master._scanDone = new Promise(resolve => { finishScan = resolve; });
  master.registry = {
    getInitOrder: () => ['ml-signal-scorer'],
    get: name => name === 'state-manager' ? { botState: state } : { stop: () => { flushed = true; } },
  };
  const stopping = master.stop();
  await new Promise(setImmediate);
  assert.equal(state.safety.entriesEnabled, false);
  assert.equal(flushed, false);
  finishScan();
  await stopping;
  assert.equal(flushed, true);
});

test('risk check preserves fractional-cent quotes and rejects stale spot input', () => {
  const state = setup();
  const risk = new RiskManager();
  const check = risk._checkSignal({ ...signal, priceDecimal: 0.3545, priceCents: 35 }, state);
  assert.equal(check.price, 0.3545);
  assert.ok(check.cost > check.price * check.contracts);
  state.btcPrice = { lastUpdate: Date.now() - 11000 };
  assert.equal(risk._checkSignal(signal, state).reason, 'stale_spot_price');
});
