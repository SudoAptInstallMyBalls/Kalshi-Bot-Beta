const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore } = require('#src/research/market-history');
const { replay, asOf, fee, quote } = require('#src/research/history-replay');
const { openResearch, downloadSpot, normalizeKline } = require('#src/research/research-data');
const { MLPipeline } = require('#src/ml/ml-pipeline');
const { parseArgs } = require('../scripts/replay-history.js');

function fixture(t, count = 10) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kalshi-replay-'));
  const store = new HistoryStore(':memory:');
  const start = Date.parse('2026-01-01T03:00:00Z');
  for (let n = 0; n < count; n++) {
    const open = start + n * 900000, ticker = `KXBTC15M-TEST-${n}`;
    store.market({ ticker, open_time: new Date(open).toISOString(), close_time: new Date(open + 900000).toISOString(),
      floor_strike: 100, result: n % 2 ? 'no' : 'yes' }, 'test');
    store.candles(ticker, Array.from({ length: 15 }, (_, i) => ({ end_period_ts: (open + (i + 1) * 60000) / 1000,
      yes_bid: { open_dollars: '0.49', close_dollars: '0.49', low_dollars: '0.49', high_dollars: '0.49' },
      yes_ask: { open_dollars: '0.50', close_dollars: '0.50', low_dollars: '0.50', high_dollars: '0.50' },
      volume_fp: '10000' })), 'live');
  }
  const spot = Array.from({ length: 180 + count * 15 }, (_, i) => ({
    available_ms: start - 180 * 60000 + (i + 1) * 60000, close: 100.01,
  }));
  const config = { ...require('../config/research/research-config.json'), startingBalance: 1000,
    strategy: { USE_KELLY_SIZING: false, MIN_DIVERGENCE: 0, MIN_CONTRACT_PRICE: 30, MAX_CONTRACT_PRICE: 75 } };
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, spot, config, modelPath: path.join(dir, 'model.json'), dir };
}

test('as-of join excludes future closes and fees round to cents', () => {
  const rows = [{ available_ms: 60000 }, { available_ms: 120000 }];
  assert.equal(asOf(rows, 59999), -1);
  assert.equal(asOf(rows, 60000), 0);
  assert.equal(asOf(rows, 119999), 0);
  assert.equal(fee(10, 0.5, 0.07), 0.18);
  assert.equal(fee(1, 0.5, 0.07), 0.02);
  assert.equal(quote({ yes_bid_close: null, yes_ask_close: 0.5 }, {}), null);
});

test('reference downloads resume by complete chunk and reject malformed or missing minutes', async t => {
  const { dir } = fixture(t, 1);
  const db = openResearch(path.join(dir, 'research.sqlite'));
  // Close before the fixture cleanup hook removes the directory on Windows.
  const kline = open => [open, '100', '101', '99', '100.1', '10', open + 59999];
  let calls = 0;
  const request = async () => { calls++; return { data: [kline(0), kline(60000)] }; };
  await downloadSpot(db, 0, 120000, { request, pause: async () => {}, log() {} });
  await downloadSpot(db, 0, 120000, { request, pause: async () => {}, log() {} });
  assert.equal(calls, 1);
  assert.equal(normalizeKline(kline(0)).available, 60000);
  assert.throws(() => normalizeKline([0, '', '', '', 'NaN', '', 59999]), /Invalid/);
  await assert.rejects(downloadSpot(db, 120000, 180000, { request: async () => ({ data: [] }), pause: async () => {}, log() {} }), /Incomplete/);
  db.close();
});

test('real signal generator replay is deterministic, disjoint by market, and labels after entry', async t => {
  const { store, spot, config, modelPath } = fixture(t);
  const a = await replay(store.db, spot, config, { modelPath });
  const b = await replay(store.db, spot, config, { modelPath });
  assert.deepEqual(a, b);
  assert.equal(a.samples.length, 10);
  for (const [i, row] of a.samples.entries()) {
    assert.equal(row.features.length, 27);
    assert.ok(row.features.every(Number.isFinite));
    assert.ok(row.details.entryTime > row.ts);
    assert.ok(row.outcome_ms > row.details.entryTime);
    if (i) assert.ok(a.samples[i - 1].outcome_ms < row.ts);
  }
  assert.equal(new Set(a.samples.map(r => r.ticker)).size, a.samples.length);
});

test('changing future outcome and final quote cannot change the earlier feature vector', async t => {
  const { store, spot, config, modelPath } = fixture(t, 1);
  const before = await replay(store.db, spot, config, { modelPath });
  assert.equal(before.samples.length, 1);
  store.db.prepare("UPDATE markets SET result='no'").run();
  store.db.prepare('UPDATE candles SET yes_bid_close=0.1 WHERE end_period_ts=(SELECT max(end_period_ts) FROM candles)').run();
  const after = await replay(store.db, spot, config, { modelPath });
  assert.deepEqual(before.samples[0].features, after.samples[0].features);
  assert.notEqual(before.samples[0].label, after.samples[0].label);
});

test('missing candle or spot coverage rejects market; zero liquidity rejects simulated fill', async t => {
  const { store, spot, config, modelPath } = fixture(t, 1);
  const noLiquidity = await replay(store.db, spot, { ...config, volumeParticipation: 0 }, { modelPath });
  assert.equal(noLiquidity.samples.length, 0);
  assert.equal(noLiquidity.audit.rejectedEntries, 1);
  const gap = await replay(store.db, spot.slice(0, -1), config, { modelPath });
  assert.equal(gap.audit.missingSpot, 1);
  store.db.prepare('DELETE FROM candles WHERE end_period_ts=(SELECT max(end_period_ts) FROM candles)').run();
  const missing = await replay(store.db, spot, config, { modelPath });
  assert.equal(missing.audit.missingCandles, 1);
});

test('research outcomes train the existing model without permitting live model loading', async t => {
  const { store, spot, config, modelPath } = fixture(t);
  const run = await replay(store.db, spot, config, { modelPath });
  const model = new MLPipeline({ modelPath, db: { getTrainingData: () => run.samples },
    config: { ML_RESEARCH_ONLY: true, ML_MIN_TRAINING_SAMPLES: 10 } });
  assert.equal(await model.train(), true);
  assert.equal(model.trainingSize, 7);
  assert.equal(model.validationMetrics.size, 1);
  assert.equal(model.testMetrics.size, 2);
  assert.equal(JSON.parse(fs.readFileSync(modelPath)).usage, 'research');
  const live = new MLPipeline({ modelPath });
  assert.equal(live.trained, false);
  const research = new MLPipeline({ modelPath, config: { ML_RESEARCH_ONLY: true } });
  assert.equal(research.trained, true);
});

test('replay CLI rejects unknown flags and history/output collision', () => {
  assert.throws(() => parseArgs(['--live']), /Unknown/);
  assert.throws(() => parseArgs(['--out']), /Missing/);
  assert.throws(() => parseArgs(['--history', 'data/research/research.sqlite', '--out', 'data/research']), /overwrite/);
});
