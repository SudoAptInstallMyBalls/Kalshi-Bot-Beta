const { test } = require('node:test');
const assert = require('node:assert/strict');
const BotState = require('#src/storage/bot-state');
const PositionManager = require('#src/agents/skills/trading/position-manager');
const KalshiMarketData = require('#src/agents/skills/market-data/kalshi-market-data');
const KalshiClient = require('#src/exchange/kalshi-client');
const RiskManager = require('#src/agents/skills/trading/risk-manager');
const { normalizeOrder, executionTotals } = require('#src/execution/kalshi-order');

function setup(t, client) {
  for (const name of ['_loadState', '_scheduleSave', 'saveNow']) t.mock.method(BotState.prototype, name, () => {});
  const state = new BotState();
  state.safety = { check: () => ({ approved: true, sizeMultiplier: 1 }), halt: reason => { state.halted = reason; } };
  state.openPositions = [{ orderId: 'entry', ticker: 'BTC', side: 'yes', contracts: 10, filledContracts: 10,
    priceDecimal: 0.5, totalCost: 5 }];
  const pm = new PositionManager();
  t.after(() => pm.stop());
  pm.normalFillCheckDelayMs = 0;
  pm.context = { registry: { get: name => name === 'state-manager' ? { botState: state } : { getClient: () => client } } };
  return { pm, state, tp: { orderId: 'entry', ticker: 'BTC', side: 'yes', contracts: 10, sellPriceCents: 70, reason: 'test' } };
}
const entry = { fill_count: 10, taker_fill_cost: 500, taker_fees: 10 };
const filled = (count, status = 'executed') => ({ status, fill_count: count, taker_fill_cost: count * 70, taker_fees: count });

test('fixed-point order fields preserve fractional counts and convert dollars exactly once', () => {
  const order = normalizeOrder({ fill_count_fp: '2.50', taker_fill_cost_dollars: '1.25', taker_fees_dollars: '0.03' });
  assert.equal(order.fill_count, 2.5);
  assert.deepEqual(executionTotals(order), { filled: 2.5, gross: 125, fees: 3 });
  assert.throws(() => executionTotals({ fill_count: 1 }), /costs unavailable/);
});

test('timed-out exit persists client identity and scheduled requery accounts partial fills once without reselling', async t => {
  let submissions = 0, identity, found = false;
  const client = { getOrder: async id => id === 'entry' ? entry : filled(4, 'canceled'),
    sellPosition: async (...args) => { submissions++; identity = args[4]; throw Error('ECONNRESET'); },
    findOrderByClientId: async (ticker, id) => {
      assert.equal(id, identity);
      return found ? { ticker, client_order_id: id, order_id: 'exit' } : null;
    } };
  const { pm, state, tp } = setup(t, client);
  await pm._executeTakeProfit(tp);
  assert.ok(identity);
  assert.equal(state.openPositions[0].exitClientOrderId, identity);
  assert.equal(pm._exitTimers.size, 1);
  await pm.reconcileExitById('entry');
  assert.equal(state.openPositions[0].exitSubmissionUnknown, true);
  found = true;
  await Promise.all([pm.reconcileExitById('entry'), pm.reconcileExitById('entry')]);
  assert.equal(submissions, 1);
  assert.equal(state.openPositions[0].filledContracts, 6);
  assert.equal(state.openPositions[0].exitSubmissionUnknown, undefined);
  assert.equal(pm._exitTimers.size, 0);
  await pm.reconcileExitById('entry');
  assert.equal(state.openPositions[0].filledContracts, 6);
});

test('exit retries resume persisted markers, remain bounded, and drain on shutdown', async t => {
  let release, lookups = 0;
  const { pm, state } = setup(t, { findOrderByClientId: () => { lookups++; return new Promise(r => { release = r; }); } });
  pm.context.config = { EXIT_RECONCILIATION_MAX_ATTEMPTS: 1 };
  Object.assign(state.openPositions[0], { exitSubmissionUnknown: true, exitClientOrderId: 'saved', exitRequested: 10 });
  await pm.start();
  pm.scheduleExitReconciliation('entry');
  assert.equal(pm._exitTimers.size, 1);
  const work = pm.reconcileExitById('entry');
  let stopped = false;
  const stopping = pm.stop().then(() => { stopped = true; });
  await new Promise(setImmediate);
  assert.equal(stopped, false);
  release(null);
  await work; await stopping;
  assert.equal(lookups, 1);
  assert.equal(pm._exitTimers.size, 0);
  assert.equal(state.openPositions[0].exitSubmissionUnknown, true);
  await pm.start();
  assert.equal(state.halted, 'exit_reconciliation_retries_exhausted');
  assert.equal(pm._exitTimers.size, 0);
});

test('known exit cancellation recovers on scheduled query without an exit signal', async t => {
  let terminal = false, submissions = 0;
  const { pm, state, tp } = setup(t, { getOrder: async id => id === 'entry' ? entry : filled(10, terminal ? 'executed' : 'resting'),
    sellPosition: async () => { submissions++; return { order_id: 'exit' }; }, cancelOrder: async () => { throw Error('TLS'); } });
  await pm._executeTakeProfit(tp);
  terminal = true;
  await pm.reconcileExitById('entry');
  assert.equal(submissions, 1);
  assert.equal(state.openPositions.length, 0);
});

test('order identity lookup follows pages, rejects incomplete/ambiguous data and never infers rejection from absence', async () => {
  const client = new KalshiClient({}, {});
  let reads = 0;
  client.get = async () => ({ data: ++reads === 1 ? { orders: [], cursor: 'next' } : {
    orders: [{ order_id: 'exit', ticker: 'BTC', client_order_id: 'id', fill_count_fp: '2.00' }], cursor: '' } });
  assert.equal((await client.findOrderByClientId('BTC', 'id')).fill_count, 2);
  assert.equal(reads, 2);
  client.get = async () => ({ data: { orders: [] } });
  assert.equal(await client.findOrderByClientId('BTC', 'id'), null);
  client.get = async () => ({ data: {} });
  await assert.rejects(client.findOrderByClientId('BTC', 'id'), /Missing orders/);
  client.get = async () => ({ data: { orders: [], cursor: 'loop' } });
  await assert.rejects(client.findOrderByClientId('BTC', 'id'), /Repeated orders cursor/);
  client.get = async () => ({ data: { orders: ['a', 'b'].map(order_id => ({ order_id, ticker: 'BTC', client_order_id: 'id' })) } });
  await assert.rejects(client.findOrderByClientId('BTC', 'id'), /Ambiguous/);
});

test('quote retry delay grows per ticker, recovers independently, and prunes inactive markets', async t => {
  let now = 10000, healthy = false;
  t.mock.method(Date, 'now', () => now);
  const { state } = setup(t, {});
  state.openPositions = [];
  state.activeMarkets = [{ ticker: 'bad' }, { ticker: 'good' }];
  const calls = { bad: 0, good: 0 }, skill = new KalshiMarketData();
  skill.client = { fetchMarket: async ticker => {
    calls[ticker]++;
    if (ticker === 'bad' && !healthy) throw Error('offline');
    return { yesBid: .5 };
  } };
  await skill._refreshMarkets(state);
  now += 1000; await skill._refreshMarkets(state);
  assert.deepEqual(calls, { bad: 1, good: 2 });
  now += 1000; await skill._refreshMarkets(state);
  assert.equal(skill._quoteRetries.get('bad').nextAttempt, now + 4000);
  healthy = true; now += 4000; await skill._refreshMarkets(state);
  assert.equal(state.activeMarkets[0].quoteStale, false);
  assert.equal(skill._quoteRetries.size, 0);
  healthy = false; await skill._refreshMarkets(state);
  state.activeMarkets = []; await skill._refreshMarkets(state);
  assert.equal(skill._quoteRetries.size, 0);
});

test('late cancel fill is counted before repricing; costs and fees include all partial exits', async t => {
  const submitted = []; let reads = 0;
  const client = { sellPosition: async (ticker, side, count) => { submitted.push(count); return { order_id: `exit${submitted.length}` }; },
    getOrder: async id => id === 'entry' ? entry : id === 'exit2' ? filled(6) : ++reads === 1 ? filled(2, 'resting') : filled(4, 'canceled'),
    cancelOrder: async () => { throw new Error('raced fill'); } };
  const { pm, state, tp } = setup(t, client);
  await pm._executeTakeProfit(tp);
  assert.deepEqual(submitted, [10, 6]);
  assert.equal(state.openPositions.length, 0);
  assert.ok(Math.abs(state.stats.totalPnL - 1.8) < 1e-10);
});

test('unconfirmed cancellation preserves order identity and resumes it without duplicate sell', async t => {
  let submissions = 0, terminal = false;
  const client = { sellPosition: async () => { submissions++; return { order_id: 'exit' }; },
    getOrder: async id => id === 'entry' ? entry : terminal ? filled(10) : filled(2, 'resting'), cancelOrder: async () => {} };
  const { pm, state, tp } = setup(t, client);
  await pm._executeTakeProfit(tp);
  assert.equal(submissions, 1);
  assert.equal(state.openPositions[0].exitOrder.id, 'exit');
  assert.equal(state.openPositions[0].filledContracts, 10);
  terminal = true;
  await pm._executeTakeProfit(tp);
  assert.equal(submissions, 1);
  assert.equal(state.openPositions.length, 0);
});

test('unknown POST outcome blocks duplicate exits and new entries', async t => {
  let calls = 0;
  const { pm, state, tp } = setup(t, { getOrder: async () => entry,
    sellPosition: async () => { calls++; throw new Error('timeout'); } });
  await pm._executeTakeProfit(tp);
  await pm._executeTakeProfit(tp);
  assert.equal(calls, 1);
  assert.equal(state.openPositions[0].exitSubmissionUnknown, true);
  assert.equal(new RiskManager()._checkSignal({}, state).reason, 'exit_reconciliation_pending');
  assert.equal((await pm._settlePosition('entry')).reason, 'exit_reconciliation_pending');
});

test('explicit invalid-order exit rejection clears only the submission marker and retains the position', async t => {
  const error = Object.assign(new Error('Request failed'), { response: { status: 400, data: { error: { code: 'invalid_order', message: 'validation failed' } } } });
  const { pm, state, tp } = setup(t, { getOrder: async () => entry, sellPosition: async () => { throw error; } });
  const result = await pm._executeTakeProfit(tp);
  assert.equal(state.openPositions.length, 1);
  assert.equal(state.openPositions[0].exitSubmissionUnknown, undefined);
  assert.equal(state.openPositions[0].filledContracts, 10);
  assert.match(result.error, /invalid_order.*validation failed/);
});

test('startup books verified finalized settlement before comparing open quantities', async t => {
  const {state}=setup(t,{});state.openPositions[0].closeTime=1;state.openPositions[0].reconciliationRequired=true;
  const skill=new KalshiMarketData();let closes=0;
  skill.context={registry:{get:()=>({_settlePosition:async()=>{closes++;state.openPositions=[];}})}};
  let count='9.00';
  skill.client={fetchPositions:async()=>[],fetchMarket:async()=>({status:'finalized',result:'yes'}),
    fetchSettlements:async()=>[{yes_count_fp:count,no_count_fp:'0.00',market_result:'yes',revenue:1000}]};
  const mismatch=await skill._reconcilePositions(state);assert.equal(mismatch.requiresReview,true);assert.equal(closes,0);
  count='10.00';const reconciled=await skill._reconcilePositions(state);
  assert.equal(closes,1);assert.equal(reconciled.requiresReview,false);assert.equal(state.openPositions.length,0);
});

test('failed quote refresh marks retained quotes stale and final risk check refuses them', async t => {
  const { state } = setup(t, {});
  state.activeMarkets = [{ ticker: 'BTC', yesBid: 0.5, yesAsk: 0.51 }];
  const skill = new KalshiMarketData();
  skill.client = { fetchMarket: async () => { throw new Error('offline'); } };
  await skill._refreshMarkets(state);
  assert.equal(state.activeMarkets[0].quoteStale, true);
  assert.equal(new RiskManager()._checkSignal({ ticker: 'BTC' }, state).reason, 'stale_market_quote');
});

test('portfolio mismatch preserves cost basis and pending identities instead of fabricating positions', async t => {
  const { state } = setup(t, {});
  state.pendingOrders = [{ orderId: 'pending' }];
  const skill = new KalshiMarketData();
  skill.client = { fetchPositions: async () => [{ ticker: 'BTC', position_fp: '-3.00' }] };
  const result = await skill._reconcilePositions(state);
  assert.equal(result.mismatches.length, 1);
  assert.equal(state.openPositions[0].orderId, 'entry');
  assert.equal(state.openPositions[0].totalCost, 5);
  assert.equal(state.pendingOrders[0].orderId, 'pending');
  assert.equal(state.halted, 'portfolio_reconciliation_required');
});

test('portfolio pagination follows cursors and rejects incomplete schemas', async () => {
  const client = new KalshiClient({}, {}); let calls = 0;
  client.get = async () => ({ data: { market_positions: [{ ticker: 'BTC', position_fp: '1' }], cursor: ++calls === 1 ? 'page2' : '' } });
  assert.equal((await client.fetchPositions('BTC')).length, 2);
  client.get = async () => ({ data: {} });
  await assert.rejects(client.fetchPositions('BTC'), /Missing portfolio/);
});

test('settlement retries are deduplicated, bounded, and cleared on stop', async t => {
  const { pm, state } = setup(t, {});
  pm.context.config = { SETTLEMENT_MAX_ATTEMPTS: 1 };
  t.mock.method(pm, '_settlePosition', async () => ({ settled: false, reason: 'not_settled_yet' }));
  await pm.settlePositionById('entry');
  pm.scheduleSettlement('entry');
  assert.equal(pm._settlementTimers.size, 1);
  await pm.settlePositionById('entry');
  assert.equal(state.halted, 'settlement_retries_exhausted');
  await pm.stop();
  assert.equal(pm._settlementTimers.size, 0);
});

test('settlement does not drop an entry that is still pending', async t => {
  const { pm, state } = setup(t, {});
  state.openPositions = [];
  state.pendingOrders = [{ orderId: 'entry' }];
  assert.equal((await pm._settlePosition('entry')).reason, 'entry_order_pending');
  assert.equal(state.pendingOrders.length, 1);
});
