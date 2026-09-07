const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSettlementBasis: analyze, settlementNumber } = require('../src/research/settlement-basis');
function fixture(distances = [5, 10, 20, 50, 100, 101]) {
  const markets = [], spot = [];
  for (const [i, bp] of distances.entries()) {
    const t = (i + 1) * 900000, price = 10000 + bp;
    const m = { ticker: `KXBTC15M-TEST-${i}`, open_time: new Date(t - 900000).toISOString(),
      close_time: new Date(t).toISOString(), floor_strike: 10000, expiration_value: '9,999.00', result: 'no' };
    markets.push({ ...m, raw_json: JSON.stringify({ ...m, strike_type: 'greater_or_equal' }) });
    spot.push({ open_ms: t - 60000, available_ms: t, close: price, source: 'binance:BTCUSDT:1m',
      raw_json: JSON.stringify([t - 60000, price, price, price, price, 1, t - 1]) });
  }
  return { markets, spot };
}
test('far-from-strike disagreements are counted, boundaries are disjoint, cumulative buckets are cumulative', () => {
  const { markets, spot } = fixture();
  const r = analyze(markets, spot);
  assert.deepEqual(r.byProximityToStrike_bps.map(b => b.disagree), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(r.cumulativeWithinBps.map(b => b.disagree), [1, 2, 3, 4, 5]);
  assert.equal(r.byProximityToStrike_bps.at(-1).upperBps, 'Infinity');
  assert.equal(r.disagree, 6);
  assert.equal(r.dataQuality.official.checked, 6);
  assert.deepEqual(r.dataQuality.official.disagree, []);
  assert.deepEqual(analyze(markets, spot), r);
});
test('official numbers allow valid thousands separators and reject missing or malformed values', () => {
  assert.equal(settlementNumber('77,362.10'), 77362.10);
  for (const value of [null, '', '77,36.10', 'NaN', '123oops', Infinity, 0]) assert.equal(settlementNumber(value), null);
});
test('as-of excludes future data and reports stale, missing, invalid and unsupported markets', () => {
  const { markets, spot } = fixture([1]);
  assert.equal(analyze(markets, []).noSpot, 1);
  const future = fixture([1]).spot[0];
  future.open_ms += 60000; future.available_ms += 60000;
  future.raw_json = JSON.stringify([future.open_ms, 1, 10001, 1, 10001, 1, future.available_ms - 1]);
  assert.equal(analyze(markets, [future]).noSpot, 1);
  const later = { ...markets[0], open_time: new Date(180000).toISOString(), close_time: new Date(1080000).toISOString() };
  assert.equal(analyze([later], spot).dataQuality.skipped.staleSpot.length, 1);
  assert.equal(analyze([{ ...markets[0], close_time: 'invalid' }], spot).dataQuality.skipped.invalidMarket.length, 1);
  assert.equal(analyze([{ ...markets[0], ticker: 'OTHER' }], spot).dataQuality.skipped.unsupportedMarket.length, 1);
});
test('mixed feeds, duplicate timestamps and corrupted normalized candles fail closed', () => {
  const { markets, spot } = fixture([1]);
  assert.throws(() => analyze(markets, [spot[0], spot[0]]), /Invalid or mixed/);
  assert.throws(() => analyze(markets, [{ ...spot[0], source: 'other' }]), /Invalid or mixed/);
  assert.throws(() => analyze(markets, [{ ...spot[0], close: 3 }]), /differs from raw/);
});
test('official equality resolves yes and missing values cannot silently resolve no', () => {
  const { markets, spot } = fixture([0]);
  const m = { ...markets[0], result: 'yes', expiration_value: '10,000.00' };
  assert.deepEqual(analyze([m], spot).dataQuality.official.disagree, []);
  const r = analyze([{ ...m, expiration_value: 'bad' }], spot);
  assert.equal(r.dataQuality.official.checked, 0);
  assert.equal(r.dataQuality.official.missing.length, 1);
  assert.equal(r.signedSpotMinusOfficialBps.count, 0);
});
