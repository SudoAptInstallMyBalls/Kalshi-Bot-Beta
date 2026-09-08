const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HistoryStore } = require('../src/research/market-history');
const { complete } = require('../scripts/multi-asset/backfill');
test('backfill completeness requires exact minute timestamps, not just 15 rows', () => {
  const h = new HistoryStore(':memory:');
  const m = { ticker:'TEST', open_time:'2026-07-01T00:00:00Z' };
  const start=Date.parse(m.open_time)/1000;
  try {
    const candles=Array.from({length:15},(_,i)=>({end_period_ts:start+(i+1)*60}));
    h.candles(m.ticker,candles,'live');
    assert.equal(complete(h,m),true);
    h.db.prepare('UPDATE candles SET end_period_ts=? WHERE end_period_ts=?').run(start+960,start+900);
    assert.equal(complete(h,m),false);
  } finally {h.close();}
});
