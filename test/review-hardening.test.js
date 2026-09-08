const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Book } = require('#src/execution/book-execution');
const AnalyticsDB = require('#src/storage/analytics-db');
const KalshiClient = require('#src/exchange/kalshi-client');
const { executionTotals, ExecutionDataError } = require('#src/execution/kalshi-order');
const ScheduledTask = require('#src/agents/core/scheduled-task');
const tasks = require('#src/agents/core/periodic-tasks');
const SignalGenerator = require('#src/agents/skills/analysis/signal-generator');
const ProbabilityModel = require('#src/agents/skills/analysis/probability-model');
const { createReplayRegistry, assertReplayRegistry } = require('#src/research/replay-registry');
const DEFAULTS = require('#src/config/defaults');

test('book deltas validate only the touched level and require a fresh snapshot after rejection', () => {
  const book = new Book();
  const snapshot = { type: 'orderbook_snapshot', msg: { yes_dollars_fp: [['.5', '2']], no_dollars_fp: [] } };
  book.apply(snapshot, 1);
  book.yes[Symbol.iterator] = () => { throw Error('full book scan'); };
  book.apply({ type: 'orderbook_delta', msg: { side: 'yes', price_dollars: '.5', delta_fp: '1' } }, 2);
  assert.equal(book.yes.get(.5), 3);
  book.apply({ type: 'orderbook_delta', msg: { side: 'yes', price_dollars: '1', delta_fp: '0' } }, 3);
  assert.equal(book.valid, false);
  book.apply({ type: 'heartbeat' }, 4);
  assert.equal(book.valid, false);
  book.apply(snapshot, 5);
  assert.equal(book.valid, true);
  book.apply({ type: 'orderbook_snapshot', msg: { yes_dollars_fp: [null], no_dollars_fp: [] } }, 6);
  assert.equal(book.valid, false);
});

test('book rejects quantity overflow and negative deltas, but accepts deletion', () => {
  for (const [quantity, delta, valid] of [[2, -2, true], [2, -3, false], [Number.MAX_VALUE, Number.MAX_VALUE, false]]) {
    const book = new Book();
    book.apply({ type: 'orderbook_snapshot', msg: { yes_dollars_fp: [[.5, quantity]], no_dollars_fp: [] } }, 1);
    book.apply({ type: 'orderbook_delta', msg: { side: 'yes', price_dollars: .5, delta_fp: delta } }, 2);
    assert.equal(book.valid, valid);
    if (valid) assert.equal(book.yes.size, 0);
  }
});

test('analytics audit rows normalize legacy strings and fixed-point units on insert and update', () => {
  const db = new AnalyticsDB(':memory:');
  try {
    db.logOrder({ order_id: 'id', ticker: 'BTC', side: 'yes', price_cents: '50', initial_count_fp: '2.50',
      fill_count_fp: '2.50', taker_fill_cost_dollars: '1.25', taker_fees_dollars: '.03' });
    let row = db.db.prepare('SELECT * FROM orders WHERE order_id=?').get('id');
    assert.equal(row.fill_count, 2.5);
    assert.equal(row.taker_fill_cost, 125);
    assert.equal(row.taker_fees, 3);
    db.updateOrder('id', 'canceled', '0.00', '0.00', '0.00');
    row = db.db.prepare('SELECT * FROM orders WHERE order_id=?').get('id');
    assert.equal(row.fill_count, 0);
    assert.equal(row.taker_fill_cost, 0);
  } finally { db.close(); }
});

test('training storage errors propagate and transactional batch failure rolls back all rows', () => {
  const db = new AnalyticsDB(':memory:');
  try {
    const feature = { ts: 1, signalUuid: 'ok', ticker: 'BTC', signalType: 'DIRECTIONAL', features: [1] };
    assert.throws(() => db.writeMLBatch([feature, { ...feature, signalUuid: Symbol('invalid') }], []));
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM ml_features').get().n, 0);
    db.db.exec('DROP TABLE ml_features');
    assert.throws(() => db.updateFeatureLabel('ok', 1));
    assert.throws(() => db.getTrainingData());
  } finally { db.close(); }
});

test('telemetry follows resolved directories and can reopen closed instances', () => {
  const telemetry = require('#src/storage/research-telemetry');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-review-'));
  try {
    const a = telemetry.telemetry(path.join(directory, 'a'));
    const b = telemetry.telemetry(path.join(directory, 'b'));
    a.recordEvent('a', {});
    assert.equal(b.db.prepare('SELECT COUNT(*) AS n FROM execution_events').get().n, 0);
    a.close();
    const reopened = telemetry.telemetry(path.join(directory, 'a'));
    assert.notEqual(a, reopened);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM execution_events').get().n, 1);
  } finally { telemetry.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('credential source warning contains no key material and occurs once per load', t => {
  const old = process.env.KALSHI_PRIVATE_KEY_BASE64;
  t.after(() => { if (old === undefined) delete process.env.KALSHI_PRIVATE_KEY_BASE64; else process.env.KALSHI_PRIVATE_KEY_BASE64 = old; });
  process.env.KALSHI_PRIVATE_KEY_BASE64 = Buffer.from('test-secret-material').toString('base64');
  const warnings = [];
  t.mock.method(console, 'warn', line => warnings.push(line));
  const client = new KalshiClient({}, {});
  client.loadPrivateKey(); client.loadPrivateKey();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /overrides KALSHI_PRIVATE_KEY_PATH/);
  assert.ok(!warnings[0].includes('test-secret-material'));
  assert.ok(!warnings[0].includes(process.env.KALSHI_PRIVATE_KEY_BASE64));
});

test('execution data errors expose stable codes without confusing unfilled orders', () => {
  assert.deepEqual(executionTotals({ fill_count: '0.00' }), { filled: 0, gross: 0, fees: 0 });
  for (const [order, code] of [[{}, 'INVALID_FILL_COUNT'], [{ fill_count: 1 }, 'MISSING_FILL_COST'],
    [{ fill_count: 1, taker_fill_cost: 1 }, 'MISSING_FILL_FEES'],
    [{ fill_count: 1, taker_fill_cost: -1, taker_fees: 0 }, 'INVALID_EXECUTION_AMOUNTS']]) {
    assert.throws(() => executionTotals(order), e => e instanceof ExecutionDataError && e.code === code);
  }
});

test('scheduled tasks deduplicate overlapping invocations, drain and restart with injected timers', async () => {
  let finish, callback, calls = 0, cancelled = false;
  const task = new ScheduledTask(() => { calls++; return new Promise(r => { finish = r; }); }, 100,
    { setInterval: fn => { callback = fn; return 1; }, clearInterval: () => { cancelled = true; } });
  task.start(); callback(); callback();
  await Promise.resolve();
  assert.equal(calls, 1);
  let drained = false;
  const stopping = task.stop().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  assert.equal(cancelled, true);
  finish(); await stopping;
  await task.run(); assert.equal(calls, 1);
  task.start(); const work = task.run(); await Promise.resolve();
  finish(); await work; await task.stop();
  assert.equal(calls, 2);
});

test('four periodic bodies accept injected dependencies and obey shutdown/auth guards', async () => {
  const actions = [];
  const state = { openPositions: [], safety: { check: () => ({ approved: true }) }, updateIntent() {} };
  const owner = { running: true, state, config: {}, log() {}, orchestrator: { dispatch: async task => {
    actions.push(task.action); return { success: true, context: {} };
  } } };
  await tasks.runScan(owner); await tasks.runTakeProfit(owner);
  await tasks.runDiscovery(owner); await tasks.runBalanceRefresh(owner);
  assert.deepEqual(actions, ['scan-and-trade', 'discover-markets', 'fetch-balance']);
  owner.running = false;
  await Promise.all(Object.values(tasks).map(run => run(owner)));
  assert.equal(actions.length, 3);
});

test('replay registry covers declared and statically used live dependencies', () => {
  const generator = new SignalGenerator();
  const registry = createReplayRegistry({ generator, probability: new ProbabilityModel(), getSpot: () => ({ sigma: .01, trend: 'NEUTRAL' }), getState: () => ({}), strategy: {} });
  const source = fs.readFileSync(require.resolve('#src/agents/skills/analysis/signal-generator'), 'utf8');
  const references = [...source.matchAll(/registry\.get\('([^']+)'\)/g)].map(m => m[1]);
  for (const name of references) {
    assert.ok(generator.dependencies.includes(name), `Undeclared live dependency: ${name}`);
    assert.ok(registry.has(name), `Missing replay dependency: ${name}`);
  }
  generator.dependencies.push('new-dependency');
  assert.throws(() => assertReplayRegistry(generator, registry), /new-dependency/);
});

test('entry constructor and initialization share canonical numeric defaults', async () => {
  const generator = new SignalGenerator();
  assert.equal(generator.minDivergence, DEFAULTS.MIN_DIVERGENCE);
  assert.equal(generator.maxTradeRiskPct, DEFAULTS.MAX_TRADE_RISK_PCT);
  await generator.initialize({ config: {} });
  assert.equal(generator.minDivergence, DEFAULTS.MIN_DIVERGENCE);
  assert.equal(generator.tradingWindow, DEFAULTS.TRADING_WINDOW * 60000);
  await generator.initialize({ config: { MIN_DIVERGENCE: 10 } });
  assert.equal(generator.minDivergence, 10);
});
