const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CoinbaseRecorder } = require('../scripts/multi-asset/coinbase-recorder');
const { assets, options } = require('../scripts/multi-asset/run');
const { normalize } = require('../scripts/multi-asset/coinbase-spot');
test('asset recorders isolate products and preserve sub-dollar precision', () => {
  for (const asset of assets) {
    const r = new CoinbaseRecorder(':memory:', asset + '-USD');
    try {
      const m = { type: 'ticker', product_id: asset + '-USD', price: '0.123456', best_bid: '0.123455', best_ask: '0.123457', time: new Date(10134).toISOString() };
      assert.equal(r.record({ ...m, product_id: 'BTC-USD' }, 10000), false);
      assert.equal(r.record(m, 10000), true);
      const row = r.db.prepare('SELECT * FROM proxy_ticks').get();
      assert.equal(row.source, `coinbase:${asset}-USD:ticker`);
      assert.equal(row.price, 0.123456);
      assert.equal(row.event_ms, 10134);
      r.recordBook({type:'snapshot',product_id:asset+'-USD',bids:[['0.123455','10']],asks:[['0.123457','10']]},10000);
      assert.equal(r.db.prepare('SELECT source FROM proxy_quotes').get().source,`coinbase:${asset}-USD:book-midpoint`);
    } finally { r.db.close(); }
  }
});
test('collection CLI rejects accidental unbounded downloads and unknown arguments', () => {
  assert.equal(options(['download']).days, 7);
  for (const args of [['download','--days','0'],['download','--days','1000'],['record','--days','7'],['trade']]) assert.throws(()=>options(args));
});
test('Coinbase candle normalization keeps one-minute availability semantics', () => {
  const row=normalize([1788800040,100,101,100.5,100.8,12]);
  assert.equal(row.open_ms,1788800040000);
  assert.equal(row.available_ms,1788800100000);
  assert.equal(row.close,100.8);
});
