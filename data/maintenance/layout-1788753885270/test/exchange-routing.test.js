const { test } = require('node:test');
const assert = require('node:assert/strict');
const KalshiClient = require('../bot/kalshi');
const Executor = require('../agents/skills/trading/order-executor');
const { isDefiniteRejection } = require('../lib/order-rejection');
const { validateState } = require('../scripts/repair-demo-submission');

function fixture(balance = '0.00') {
  const state = { safety: { check: () => ({ approved: true }), executionSucceeded() {}, executionFailed() {} } };
  const client = new KalshiClient({}, state);
  client.fetchMarket = async () => ({ exchangeIndex: 2 });
  const calls = [];
  client.get = async url => { calls.push(url); return { data: { balance_dollars: balance } }; };
  client.post = async (url, body) => { calls.push(body); return { data: { order_id: 'accepted' } }; };
  const entry = { ticker: 'BTC', side: 'ask', count: '1.00', price: '0.36' };
  return { client, calls, entry };
}
test('aggregate cash cannot fund an order on an empty crypto shard', async () => {
  const { client, calls, entry } = fixture();
  await assert.rejects(client.placeOrder(entry), e => isDefiniteRejection(e) && e.haltReason === 'exchange_balance_insufficient');
  assert.deepEqual(calls, ['/trade-api/v2/portfolio/balance?exchange_index=2']);
});
test('entry uses authoritative shard and NO price plus fees', async () => {
  const { client, calls, entry } = fixture('0.65');
  await assert.rejects(client.placeOrder(entry), /needs \$0.66/);
  client.get = async () => ({ data: { balance_dollars: '0.66' } });
  await client.placeOrder({ ...entry, exchange_index: 0 });
  assert.equal(calls.at(-1).exchange_index, 2);
});
test('reduce-only exit routes without requiring free cash', async () => {
  const { client, calls, entry } = fixture();
  await client.placeOrder({ ...entry, reduce_only: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exchange_index, 2);
});
test('cancel routes using persisted ticker and refuses unknown order routing', async () => {
  const { client } = fixture();
  client.state.openPositions = [{ orderId: 'entry', ticker: 'BTC', exitOrder: { id: 'exit' } }];
  client.delete = async url => { assert.equal(url, '/trade-api/v2/portfolio/events/orders/exit?market_ticker=BTC'); return { data: {} }; };
  await client.cancelOrder('exit');
  await assert.rejects(client.cancelOrder('unknown'), /ticker required/);
});
test('executor removes explicit rejection marker but preserves timeout uncertainty', async () => {
  for (const definite of [true, false]) {
    const executor = new Executor();
    const state = { activeMarkets: [], pendingOrders: [], updateIntent() {}, saveNow() {},
      addPendingOrder(p) { this.pendingOrders.push(p); }, removePendingOrder(id) { this.pendingOrders = this.pendingOrders.filter(p => p.orderId !== id); },
      safety: { halt(reason) { state.halt = reason; } } };
    executor.context = { registry: { get: () => ({ _checkSignal: () => ({ approved: true, contracts: 1, price: 0.64, cost: 0.66 }) }) } };
    const error = definite ? Object.assign(new Error('user not found'), { response: { status: 404, data: { error: { code: 'user_not_found' } } } }) : new Error('timeout');
    await executor._executeSignal({ ticker: 'BTC', side: 'no', edge: 16 }, state,
      { getClient: () => ({ placeOrder: async () => { throw error; } }) }, {});
    assert.equal(state.pendingOrders.length, definite ? 0 : 1);
    assert.equal(state.halt, definite ? 'exchange_account_unavailable' : 'entry_submission_unknown');
  }
  assert.equal(isDefiniteRejection({ response: { status: 404, data: {} } }), false);
});
test('incident recovery refuses any unrelated or filled pending state', () => {
  assert.throws(() => validateState({ pendingOrders: [], openPositions: [], stats: { totalTrades: 0 } }));
  const state = { pendingOrders: [{ clientOrderId: '0b20ee95-d1d9-4b8c-98b0-651a94889701',
    orderId: 'unconfirmed-0b20ee95-d1d9-4b8c-98b0-651a94889701', ticker: 'KXBTC15M-26SEP060915-15', fillCount: 0, submissionUnknown: true }],
    openPositions: [], stats: { totalTrades: 0 } };
  validateState(state);
  state.pendingOrders[0].fillCount = 1;
  assert.throws(() => validateState(state));
});
