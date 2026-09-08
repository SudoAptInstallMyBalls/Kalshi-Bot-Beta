const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const OrderManager = require('#src/execution/order-manager');
const { orderCost, affordableContracts } = require('#src/risk/trading-math');
const { eligible } = require('../scripts/evaluate-strategies.js');

function fixture(client = {}) {
  const state = new EventEmitter();
  Object.assign(state, { openPositions: [], pendingOrders: [], balance: { available: 50 },
    addPendingOrder(p) { this.pendingOrders.push(p); }, addPosition(p) { this.openPositions.push(p); },
    removePendingOrder(id) { this.pendingOrders = this.pendingOrders.filter(p => p.orderId !== id); },
    safety: { halt(reason) { state.halted = reason; } } });
  return { state, manager: new OrderManager(client, state, null, {}),
    pending: { orderId: 'a', ticker: 'BTC', side: 'yes', contracts: 10, fillCount: 4,
      priceDecimal: 0.5, priceCents: 50, placedAt: 0, signalUuid: 'signal' } };
}

test('placement fills become positions exactly once and later fills are incremental', () => {
  const { state, manager, pending } = fixture();
  manager.addPendingOrder(pending);
  assert.equal(state.openPositions[0].filledContracts, 4);
  manager._processFill(pending, 4, 'repeat');
  assert.equal(state.openPositions[0].filledContracts, 4);
  manager._processFill(pending, 7, 'poll');
  assert.equal(state.openPositions[0].filledContracts, 7);
  assert.equal(state.openPositions[0].totalCost, 3.5);
});

test('older persisted pending rows do not double existing positions after upgrade', () => {
  const { state, manager, pending } = fixture();
  state.openPositions = [{ orderId: 'a', filledContracts: 4, totalCost: 2 }];
  manager._processFill(pending, 6, 'poll');
  assert.equal(state.openPositions[0].filledContracts, 6);
});

test('restart restores legacy pending fills without a position exactly once', async () => {
  const { state, manager, pending } = fixture({ getOrder: async () => ({ status: 'resting', fill_count: '4.00' }) });
  pending.placedAt = Date.now();
  state.pendingOrders = [JSON.parse(JSON.stringify(pending))];
  await manager.poll();
  await manager.poll();
  assert.equal(state.openPositions.length, 1);
  assert.equal(state.openPositions[0].filledContracts, 4);
  assert.equal(state.openPositions[0].totalCost, 2);
  assert.equal(state.pendingOrders[0].processedFillCount, 4);
});

test('cancel race retains actual fills, fees and cost basis; balance comes from account', async () => {
  let balanceFetches = 0;
  const { state, manager, pending } = fixture({ cancelOrder: async () => {},
    getOrder: async () => ({ status: 'canceled', fill_count: 3, taker_fill_cost: 144, taker_fees: 6 }),
    fetchBalance: async () => { balanceFetches++; } });
  pending.fillCount = 0;
  manager.addPendingOrder(pending);
  await manager._cancelStaleOrder(pending);
  assert.equal(state.pendingOrders.length, 0);
  assert.equal(state.openPositions[0].filledContracts, 3);
  assert.equal(state.openPositions[0].priceDecimal, 0.48);
  assert.equal(state.openPositions[0].totalCost, 1.5);
  assert.equal(balanceFetches, 1);
  assert.equal(state.balance.available, 50);
});

test('uncertain cancel keeps entry tracked instead of issuing a guessed refund', async () => {
  const { state, manager, pending } = fixture({ cancelOrder: async () => { throw Error('timeout'); },
    getOrder: async () => ({ status: 'resting', fill_count: 0 }) });
  pending.fillCount = 0; manager.addPendingOrder(pending);
  await manager._cancelStaleOrder(pending);
  assert.equal(state.pendingOrders.length, 1);
  assert.equal(state.balance.available, 50);
});

test('an unresolved submission halts after restart but not during its in-flight request', async () => {
  const { state, manager, pending } = fixture();
  pending.submissionUnknown = true;
  state._entrySubmissionsInFlight = new Set(['a']);
  await manager._checkOrder(pending);
  assert.equal(state.halted, undefined);
  state._entrySubmissionsInFlight.clear();
  await manager._checkOrder(pending);
  assert.equal(state.halted, 'entry_submission_unknown');
});

test('fee-inclusive sizing cannot spend above its budget', () => {
  for (const price of [0.01, 0.35, 0.5, 0.65, 0.99]) {
    for (const budget of [0.02, 1, 2.5, 5, 25]) {
      const n = affordableContracts(budget, price);
      assert.ok(orderCost(n, price) <= budget + 1e-10);
      assert.ok(orderCost(n + 1, price) > budget);
    }
  }
});

test('strategy selection requires samples and positive normal and stressed validation', () => {
  const good = { train: { trades: 30, pnl: 1 }, validation: { trades: 30, pnl: 1 }, stressValidation: { pnl: 1 } };
  assert.equal(eligible(good), true);
  assert.equal(eligible({ ...good, validation: { trades: 29, pnl: 100 } }), false);
  assert.equal(eligible({ ...good, stressValidation: { pnl: -1 } }), false);
});
