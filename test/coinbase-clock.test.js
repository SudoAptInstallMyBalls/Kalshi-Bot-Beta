const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CoinbaseRecorder } = require('../src/research/coinbase-recorder');
const { usableAt } = require('../src/research/coinbase-time');
const { latest } = require('../src/research/coinbase-shadow');

test('bounded clock skew preserves timestamps and cannot leak into earlier decisions', () => {
  const rec = new CoinbaseRecorder(':memory:');
  try {
    const tick = offset => ({ type: 'ticker', product_id: 'BTC-USD', price: '100',
      best_bid: '99', best_ask: '101', time: new Date(10000 + offset).toISOString() });
    assert.equal(rec.record(tick(134), 10000), true);
    const row = rec.db.prepare('SELECT * FROM proxy_ticks').get();
    assert.equal(row.received_ms, 10000);
    assert.equal(row.event_ms, 10134);
    assert.equal(latest([row], 10000), -1);
    assert.equal(usableAt(row, 10133), false);
    assert.equal(usableAt(row, 10134), true);
    assert.equal(usableAt(row, 15001), false);
    assert.equal(rec.record(tick(1501), 11000), false);
    assert.equal(rec.record(tick(1500), 11000), true);
    rec.recordBook({ type: 'snapshot', product_id: 'BTC-USD', bids: [['99','1']], asks: [['101','1']] }, 10000);
    rec.recordBook({ type: 'l2update', product_id: 'BTC-USD', time: new Date(11134).toISOString(), changes: [] }, 11000);
    assert.equal(rec.db.prepare('SELECT event_ms FROM proxy_quotes WHERE received_ms=11000').get().event_ms, 11134);
    rec.recordBook({ type: 'l2update', product_id: 'BTC-USD', time: new Date(12501).toISOString(), changes: [] }, 12000);
    assert.equal(rec.db.prepare('SELECT count(*) n FROM proxy_quotes').get().n, 2);
  } finally { rec.db.close(); }
});
