// Offline benchmark against an isolated WAL database; never reads credentials.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const AnalyticsDB = require('#src/storage/analytics-db');
const { MLPipeline } = require('#src/ml/ml-pipeline');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kalshibot-benchmark-'));
const db = new AnalyticsDB(path.join(dir, 'analytics.db'));
const p = new MLPipeline({ db, modelPath: path.join(dir, 'model.json') });
try {
  const signal = { signalId: 'benchmark', ticker: 'BTC', type: 'DIRECTIONAL_YES', side: 'yes',
    priceCents: 50, edge: 15, modelProb: 0.65, contracts: 4 };
  p.extractFeatures(signal, {});
  p.trained = true;
  p.featureMeans = Array(27).fill(0);
  p.featureStds = Array(27).fill(1);
  p.trees = Array.from({ length: 100 }, (_, i) => ({ feature: i % 27, threshold: 0,
    leftPred: -0.01, rightPred: 0.01, weight: 0.1 }));
  p.scoreSignal(signal, {}); // Warm caches and allocate timer before measurement.
  p.buffer.flush();
  let reads = 0;
  db.getRecentSignals = db.getStrategyPerformance = () => { reads++; throw new Error('Unexpected DB read'); };
  const timings = [];
  const begin = performance.now();
  for (let i = 0; i < 1000; i++) {
    const start = performance.now();
    p.scoreSignal({ ...signal, signalId: `benchmark-${i}` }, {});
    timings.push(performance.now() - start);
  }
  const totalMs = performance.now() - begin;
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ signals: 1000, trees: 100, totalMs,
    meanMs: totalMs / 1000, p99Ms: timings[989], maxMs: timings[999],
    synchronousDBReads: reads, bufferedFeatures: p.buffer.features.length,
    bufferedPredictions: p.buffer.predictions.length }, null, 2));
} finally {
  p.stop();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
