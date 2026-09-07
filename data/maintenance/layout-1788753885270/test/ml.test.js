const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AnalyticsDB = require('../bot/db');
const { MLPipeline } = require('../lib/ml-pipeline');
const Buffer = require('../lib/ml-write-buffer');

const signal = { signalId: 'test-id', ticker: 'BTC', type: 'DIRECTIONAL_YES',
  side: 'yes', priceCents: 50, edge: 15, modelProb: 0.65, contracts: 4 };

function fixture(t, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kalshibot-test-'));
  const db = new AnalyticsDB(path.join(dir, 'analytics.db'));
  const modelPath = path.join(dir, 'models/current-model.json');
  const pipeline = new MLPipeline({ db, config, modelPath });
  t.after(() => { pipeline.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { pipeline, db, modelPath };
}

test('scores defer writes, use ticker/global caches, and label before timer flush', async t => {
  const { pipeline: p, db } = fixture(t);
  let recentReads = 0, perfReads = 0;
  const recent = db.getRecentSignals.bind(db), perf = db.getStrategyPerformance.bind(db);
  db.getRecentSignals = (...args) => { recentReads++; return recent(...args); };
  db.getStrategyPerformance = (...args) => { perfReads++; return perf(...args); };
  const score = p.scoreSignal(signal, {});
  assert.equal(score.then, undefined); // Entire decision is synchronous.
  assert.equal(db.db.prepare('SELECT count(*) n FROM ml_features').get().n, 0);
  p.scoreSignal({ ...signal, signalId: 'other-id' }, {});
  assert.deepEqual([recentReads, perfReads], [1, 1]);
  p.scoreSignal({ ...signal, signalId: 'third-id', ticker: 'OTHER' }, {});
  assert.deepEqual([recentReads, perfReads], [2, 1]);
  p.recentCache.get('BTC').ts -= 20001;
  p.performanceCache.ts -= 20001;
  p.getRAGContext(signal);
  assert.deepEqual([recentReads, perfReads], [3, 2]);
  assert.equal(await p.recordOutcome(signal.signalId, true, 2), true);
  assert.equal(db.db.prepare('SELECT label FROM ml_features WHERE signal_uuid = ?').get(signal.signalId).label, 1);
});

test('batch failure rolls back both tables and retains every row for retry', t => {
  const { db } = fixture(t);
  const buffer = new Buffer(db);
  const feature = { ts: 123, signalUuid: 'f', ticker: 'BTC', signalType: 'DIRECTIONAL', features: [1] };
  buffer.enqueue(feature, { ts: null, signalUuid: 'f', modelVersion: 'x', confidence: 0.5,
    predictedOutcome: 0, featuresHash: '' });
  assert.throws(() => buffer.flush(), /NOT NULL/);
  assert.equal(db.db.prepare('SELECT count(*) n FROM ml_features').get().n, 0);
  assert.equal(buffer.features.length, 1);
  buffer.predictions[0].ts = 123;
  buffer.stop();
  assert.equal(db.db.prepare('SELECT count(*) n FROM ml_features').get().n, 1);
  assert.equal(db.db.prepare('SELECT count(*) n FROM ml_predictions').get().n, 1);
  assert.equal(db.db.prepare('SELECT ts FROM ml_features').get().ts, 123);
});

test('threshold, timer and shutdown all flush queued rows', async t => {
  const { pipeline: p, db } = fixture(t, { ML_BUFFER_THRESHOLD: 2, ML_FLUSH_INTERVAL_MS: 20 });
  p.scoreSignal(signal, {});
  p.scoreSignal({ ...signal, signalId: '2' }, {});
  assert.equal(db.db.prepare('SELECT count(*) n FROM ml_features').get().n, 0);
  await new Promise(setImmediate);
  assert.equal(db.db.prepare('SELECT count(*) n FROM ml_features').get().n, 2);
  p.scoreSignal({ ...signal, signalId: '3' }, {});
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(db.db.prepare('SELECT count(*) n FROM ml_features').get().n, 3);
  p.scoreSignal({ ...signal, signalId: '4' }, {});
  p.stop();
  assert.equal(db.db.prepare('SELECT count(*) n FROM ml_features').get().n, 4);
});

test('training floor, chronological split, train-only normalization and reload', async t => {
  const { pipeline: p, db, modelPath } = fixture(t);
  assert.equal(await p.train(), false);
  // Insert in reverse timestamp order to prove SQL/model ordering is chronological.
  const rows = Array.from({ length: 300 }, (_, i) => ({
    ts: i * 2 + 1, outcomeTs: i * 2 + 2, signalUuid: `train-${i}`, ticker: `BTC-${i}`, signalType: 'DIRECTIONAL_YES',
    features: Array(27).fill(i < 210 ? i % 2 : 100), label: i % 2,
  })).reverse();
  db.writeMLBatch(rows.slice(1), []);
  assert.equal(await p.train(), false);
  db.writeMLBatch(rows.slice(0, 1), []);
  assert.equal(await p.train(), true);
  assert.equal(p.trainingSize, 210);
  assert.equal(p.featureMeans[0], 0.5);
  assert.equal(p.validationMetrics.size, 45);
  assert.equal(p.testMetrics.size, 45);
  assert.ok(Number.isFinite(p.validationMetrics.brierScore));
  const reload = new MLPipeline({ db, modelPath });
  assert.equal(reload.trained, true);
  assert.deepEqual(reload.predict(Array(27).fill(1)), p.predict(Array(27).fill(1)));
  assert.deepEqual(reload.describe(), p.describe());
  fs.writeFileSync(modelPath, '{broken');
  assert.equal(new MLPipeline({ db, modelPath }).trained, false);
});

test('ML cannot enlarge until validation beats baseline AND sample gate passes', t => {
  const { pipeline: p } = fixture(t);
  p.trained = true;
  p.predict = () => ({ confidence: 0.9, modelVersion: 'test' });
  p.trainingSize = 2000;
  assert.equal(p.scoreSignal(signal, {}).adjustment, 1);
  p.validationMetrics = { size: 100, accuracy: 0.8, brierScore: 0.25 };
  assert.equal(p.scoreSignal(signal, {}).adjustment, 1);
  p.validationMetrics.brierScore = 0.2;
  p.trainingSize = 999;
  assert.equal(p.scoreSignal(signal, {}).adjustment, 1);
  p.trainingSize = 1000;
  assert.equal(p.scoreSignal(signal, {}).adjustment, 1); // Disabled even with old validation metrics.
  p.config.ML_ALLOW_UPSIZE = true; // Explicit research-only exercise of legacy gate.
  assert.equal(p.scoreSignal(signal, {}).adjustment, 2);
  p.predict = () => ({ confidence: 0.1, modelVersion: 'test' });
  assert.equal(p.scoreSignal(signal, {}).adjustment, 0.3);
});

test('held-out accuracy and Brier score match hand-calculated values', t => {
  const { pipeline: p } = fixture(t);
  p.predict = features => ({ confidence: features[0] });
  const metrics = p.evaluate([{ features: [0.8], label: 1 }, { features: [0.2], label: 0 }]);
  assert.equal(metrics.size, 2);
  assert.equal(metrics.accuracy, 1);
  assert.ok(Math.abs(metrics.brierScore - 0.04) < 1e-12);
});
