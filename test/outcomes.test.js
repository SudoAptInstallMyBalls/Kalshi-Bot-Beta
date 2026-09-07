const { test } = require('node:test');
const assert = require('node:assert/strict');
const BotState = require('#src/storage/bot-state');
const PositionManager = require('#src/agents/skills/trading/position-manager');
const MLSignalScorer = require('#src/agents/skills/analysis/ml-signal-scorer');
const ml = require('#src/ml/ml-pipeline');
const KalshiMarketData = require('#src/agents/skills/market-data/kalshi-market-data');

function setup(t) {
  t.mock.method(BotState.prototype, '_loadState', () => {});
  t.mock.method(BotState.prototype, '_scheduleSave', () => {});
  const state = new BotState();
  state.openPositions = [{ orderId: 'order', signalUuid: 'signal', ticker: 'BTC', side: 'yes',
    contracts: 10, filledContracts: 10, priceDecimal: 0.5, totalCost: 5 }];
  const outcomes = [];
  t.mock.method(ml, 'recordOutcome', async (...args) => { outcomes.push(args); });
  const pm = new PositionManager();
  const analytics = { updateOrderDirect() {}, logMarketSnapshotDirect() {} };
  const client = { getOrder: async () => ({ fill_count: '10.00', taker_fill_cost: '500', taker_fees: '0' }),
    fetchMarket: async () => ({ result: 'yes' }), fetchBalance: async () => {} };
  pm.context = { registry: { get: name => name === 'state-manager' ? { botState: state } :
    name === 'kalshi-market-data' ? { getClient: () => client } : analytics } };
  return { state, pm, outcomes };
}

test('partial exits cannot label ML or leak into closed-trade features; full close aggregates PnL', t => {
  const { state, pm, outcomes } = setup(t);
  const tp = { orderId: 'order', ticker: 'BTC', side: 'yes', contracts: 10, reason: 'test' };
  pm._reconcileExit(tp, 6, 60, 4, null); // -$2.40 partial loss
  assert.equal(state.stats.totalTrades, 0);
  assert.equal(outcomes.length, 0);
  const context = new MLSignalScorer()._buildMarketContext({ ticker: 'BTC' }, state);
  assert.equal(context.recentPnL, 0);
  assert.equal(context.recentWinRate, 0.5);
  pm._reconcileExit({ ...tp, contracts: 4 }, 4, 240, 0, null); // +$0.40 final portion
  assert.equal(state.stats.totalTrades, 1);
  assert.equal(state.stats.totalPnL, -2);
  assert.equal(state.stats.losses, 1);
  assert.deepEqual(outcomes, [['signal', false, -2]]);
});

test('settlement after partial exit uses numeric costs and the entire trade outcome', async t => {
  const { state, pm, outcomes } = setup(t);
  pm._reconcileExit({ orderId: 'order', ticker: 'BTC', side: 'yes', contracts: 10, reason: 'test' }, 6, 60, 4, null);
  await pm._settlePosition('order'); // Remaining wins $2, earlier exit lost $2.40.
  assert.ok(Math.abs(state.stats.totalPnL + 0.4) < 1e-10);
  assert.equal(state.stats.losses, 1);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0][1], false);
});

test('failed remote reconciliation leaves local pending orders and positions intact', async t => {
  const { state } = setup(t);
  state.pendingOrders = [{ orderId: 'pending' }];
  const skill = new KalshiMarketData();
  skill.client = { fetchPositions: async () => { throw new Error('401'); } };
  await skill._reconcilePositions(state);
  assert.equal(state.openPositions.length, 1);
  assert.equal(state.pendingOrders.length, 1);
});
