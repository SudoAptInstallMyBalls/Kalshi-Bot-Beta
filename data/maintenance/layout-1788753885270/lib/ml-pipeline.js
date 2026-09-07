/**
 * ML Pipeline — Feature extraction, model training, and prediction
 * for signal quality scoring.
 *
 * Storage: local SQLite (bot/db.js), same file the rest of the analytics
 * ledger already uses. Everything needed to close the training feedback loop lives
 * on disk, keyed by signal.signalId (a UUID set at signal-generation time).
 */

const AnalyticsDB = require('../bot/db');
const fs = require('fs');
const path = require('path');
const MLWriteBuffer = require('./ml-write-buffer');
const chronologicalSplit = require('./training-split');

// Single shared connection for this module. better-sqlite3 supports
// multiple connections to the same WAL-mode file, so this is safe even
// though AnalyticsRecorder also opens its own connection to the same DB.
// Open lazily, so inspecting the module or running isolated tests never touches
// the production ledger. Each pipeline can also receive an isolated test DB.

class MLPipeline {
  constructor({ db = null, config = {}, modelPath = path.join(
    process.env.BOT_DATA_DIR ? path.resolve(process.env.BOT_DATA_DIR) : path.join(__dirname, '../data'),
    'models/current-model.json') } = {}) {
    this._db = db;
    this.modelPath = modelPath;
    this.modelVersion = 'v1.0';
    this.trees = [];          // Trained decision stumps
    this.featureNames = [];
    this.trained = false;
    this.trainingSize = 0;

    // Feature normalization params (learned during training)
    this.featureMeans = [];
    this.featureStds = [];
    this.validationMetrics = null;
    this.testMetrics = null;
    this.configure(config);
    this.loadModel();
  }

  get db() { return this._db || (this._db = new AnalyticsDB()); }

  configure(config = {}) {
    if (this.buffer) this.buffer.stop();
    this.config = {
      ML_FLUSH_INTERVAL_MS: 500, ML_BUFFER_THRESHOLD: 50,
      ML_CONTEXT_TTL_MS: 20000, ML_MIN_TRAINING_SAMPLES: 300,
      ML_UPSIZE_MIN_TRAINING_SAMPLES: 1000, ML_BASELINE_BRIER: 0.25,
      ...config,
    };
    this.buffer = null;
    this.recentCache = new Map();
    this.performanceCache = null;
  }

  getBuffer() {
    if (!this.buffer) this.buffer = new MLWriteBuffer(this.db, {
      intervalMs: this.config.ML_FLUSH_INTERVAL_MS,
      threshold: this.config.ML_BUFFER_THRESHOLD,
    });
    return this.buffer;
  }

  stop() {
    if (this.buffer) this.buffer.stop();
    this.buffer = null;
  }

  loadModel() {
    try {
      const model = JSON.parse(fs.readFileSync(this.modelPath, 'utf8'));
      if (model.validationScheme !== 'market-outcome-v2') throw new Error('Model requires retraining with grouped outcome-time validation');
      if (model.usage === 'research' && !this.config.ML_RESEARCH_ONLY) {
        throw new Error('Research replay models cannot be loaded for live scoring');
      }
      const n = 27;
      if (!Number.isInteger(model.trainingSize) || model.trainingSize < 1 ||
          typeof model.modelVersion !== 'string' || !Number.isFinite(model.trainedAt) ||
          !Array.isArray(model.featureNames) || model.featureNames.length !== n ||
          !model.featureNames.every(v => typeof v === 'string') ||
          !Array.isArray(model.featureMeans) || model.featureMeans.length !== n ||
          !model.featureMeans.every(Number.isFinite) ||
          !Array.isArray(model.featureStds) || model.featureStds.length !== n ||
          !model.featureStds.every(v => Number.isFinite(v) && v > 0) ||
          !Array.isArray(model.trees) || !model.trees.length ||
          !model.trees.every(t => Number.isInteger(t.feature) && t.feature >= 0 && t.feature < n &&
            ['threshold', 'leftPred', 'rightPred', 'weight'].every(k => Number.isFinite(t[k])))) {
        throw new Error('Invalid model schema');
      }
      for (const key of ['validationMetrics', 'testMetrics']) {
        const m = model[key];
        if (m != null && (!Number.isInteger(m.size) || m.size < 1 ||
          !['accuracy', 'brierScore'].every(k => Number.isFinite(m[k]) && m[k] >= 0 && m[k] <= 1))) {
          throw new Error('Invalid evaluation metrics');
        }
      }
      for (const key of ['modelVersion', 'trainingSize', 'featureMeans', 'featureStds',
        'trees', 'featureNames', 'trainedAt', 'validationMetrics', 'testMetrics']) {
        this[key] = model[key] ?? null;
      }
      this.trained = true;
      return true;
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[ML] Model load skipped:', err.message);
      return false;
    }
  }

  saveModel() {
    const model = {};
    model.validationScheme = 'market-outcome-v2';
    model.usage = this.config.ML_RESEARCH_ONLY ? 'research' : 'execution';
    for (const key of ['modelVersion', 'trainingSize', 'featureMeans', 'featureStds',
      'trees', 'featureNames', 'trainedAt', 'validationMetrics', 'testMetrics']) model[key] = this[key];
    fs.mkdirSync(path.dirname(this.modelPath), { recursive: true });
    const temp = `${this.modelPath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(model), 'utf8');
    fs.renameSync(temp, this.modelPath);
  }

  evaluate(data) {
    let correct = 0, squaredError = 0;
    for (const row of data) {
      const p = this.predict(row.features).confidence;
      correct += Number(Number(p > 0.5) === row.label);
      squaredError += (p - row.label) ** 2;
    }
    return { size: data.length, accuracy: correct / data.length, brierScore: squaredError / data.length };
  }

  // ===== Feature Extraction =====

  extractFeatures(signal, marketContext) {
    const {
      btcPrice = 0, openPrice = 0, timeRemainingMs = 0, totalDurationMs = 900000,
      sigma = 0.0015, trend = 'NEUTRAL', trendStrength = 0, trendROC = 0,
      yesAsk = 0.5, noAsk = 0.5, yesBid = 0.5, noBid = 0.5,
      recentWinRate = 0.5, recentPnL = 0, streak = 0,
      balanceAvailable = 100,
    } = marketContext;

    const move = openPrice > 0 ? (btcPrice - openPrice) / openPrice : 0;
    const timeRemaining = totalDurationMs > 0 ? timeRemainingMs / totalDurationMs : 0;
    const spread = yesAsk - yesBid;
    const noSpread = noAsk - noBid;
    const combinedAsk = yesAsk + noAsk;
    const isDirectional = signal.type.startsWith('DIRECTIONAL');
    const isPolyArb = signal.type.startsWith('POLY_ARB');
    const isDualSide = signal.type.startsWith('DUAL_SIDE');
    const isBuyYes = signal.side === 'yes';

    const trendAligned = (isBuyYes && trend === 'BULLISH') || (!isBuyYes && trend === 'BEARISH');
    const trendCounter = (isBuyYes && trend === 'BEARISH') || (!isBuyYes && trend === 'BULLISH');

    const features = [
      move * 1000, Math.abs(move) * 1000, move > 0 ? 1 : 0,
      timeRemaining, Math.max(0, 1 - timeRemaining) * 100,
      sigma * 1000, sigma > 0.002 ? 1 : 0,
      signal.edge, signal.modelProb, signal.priceCents / 100, signal.contracts,
      spread * 100, noSpread * 100, combinedAsk * 100, (1 - combinedAsk) * 100,
      isDirectional ? 1 : 0, isPolyArb ? 1 : 0, isDualSide ? 1 : 0,
      isBuyYes ? 1 : 0,
      trendAligned ? 1 : 0, trendCounter ? 1 : 0, trendStrength, trendROC,
      recentWinRate, recentPnL, streak,
      balanceAvailable,
    ];

    this.featureNames = [
      'spot_move', 'abs_move', 'move_dir', 'time_remaining', 'time_elapsed',
      'volatility', 'high_vol', 'edge', 'model_prob', 'price', 'contracts',
      'yes_spread', 'no_spread', 'combined_ask', 'dual_margin',
      'is_directional', 'is_poly_arb', 'is_dual_side', 'is_buy_yes',
      'trend_aligned', 'trend_counter', 'trend_strength', 'trend_roc',
      'recent_wr', 'recent_pnl', 'streak', 'balance',
    ];

    return features;
  }

  // ===== Lightweight Gradient Boosted Stumps =====

  async train() {
    this.buffer?.flush();
    const data = this.db.getTrainingData(10000)
      .filter(d => Array.isArray(d.features) && d.features.length === 27 &&
        d.features.every(Number.isFinite) && (d.label === 0 || d.label === 1))
      .sort((a, b) => a.ts - b.ts);
    if (data.length < this.config.ML_MIN_TRAINING_SAMPLES) {
      console.log(`[ML] Not enough training data (${data.length} samples, need ${this.config.ML_MIN_TRAINING_SAMPLES}+)`);
      return false;
    }

    const { training, validation, test } = chronologicalSplit(data);
    if (!training.length || !validation.length || !test.length ||
        training.length + validation.length + test.length < this.config.ML_MIN_TRAINING_SAMPLES) {
      console.log('[ML] Too few independent, chronologically resolved samples after grouping/purging');
      return false;
    }
    // Normalization and stump fitting see only the oldest training slice.
    const X = training.map(d => d.features);
    const y = training.map(d => d.label); // 1 = won, 0 = lost
    if (!this.featureNames.length) this.extractFeatures({ type: '', side: '' }, {});

    const nFeatures = X[0].length;
    const variableFeatures = new Set(Array.from({length:nFeatures},(_,j)=>j)
      .filter(j=>X.some(row=>row[j]!==X[0][j])));
    this.featureMeans = new Array(nFeatures).fill(0);
    this.featureStds = new Array(nFeatures).fill(1);

    for (let j = 0; j < nFeatures; j++) {
      const col = X.map(row => row[j]);
      this.featureMeans[j] = col.reduce((a, b) => a + b, 0) / col.length;
      const variance = col.reduce((a, v) => a + (v - this.featureMeans[j]) ** 2, 0) / col.length;
      this.featureStds[j] = Math.sqrt(variance) || 1;
    }

    const Xn = X.map(row => row.map((v, j) => (v - this.featureMeans[j]) / this.featureStds[j]));

    const nTrees = Math.min(100, Math.floor(training.length / 5));
    const learningRate = 0.1;
    const residuals = y.map(yi => yi - 0.5);

    this.trees = [];

    for (let t = 0; t < nTrees; t++) {
      let bestStump = null;
      let bestLoss = Infinity;

      for (let j = 0; j < nFeatures; j++) {
        if (!variableFeatures.has(j)) continue;
        const sorted = Xn.map((row, i) => ({ val: row[j], res: residuals[i] }))
          .sort((a, b) => a.val - b.val);

        const mid = Math.floor(sorted.length / 2);
        const threshold = sorted[mid].val;
        // Identical feature values must take the same branch in fitting and
        // prediction. Splitting by array index leaks an arbitrary row ordering.
        const leftRes = sorted.filter(s => s.val < threshold).map(s => s.res);
        const rightRes = sorted.filter(s => s.val >= threshold).map(s => s.res);

        if (leftRes.length === 0 || rightRes.length === 0) continue;

        const leftPred = leftRes.reduce((a, b) => a + b, 0) / leftRes.length;
        const rightPred = rightRes.reduce((a, b) => a + b, 0) / rightRes.length;

        let loss = 0;
        for (let i = 0; i < Xn.length; i++) {
          const pred = Xn[i][j] < threshold ? leftPred : rightPred;
          loss += (residuals[i] - pred) ** 2;
        }

        if (loss < bestLoss) {
          bestLoss = loss;
          bestStump = { feature: j, threshold, leftPred, rightPred };
        }
      }

      if (!bestStump) {
        const bias = residuals.reduce((a, b) => a + b, 0) / residuals.length;
        bestStump = { feature: 0, threshold: 0, leftPred: bias, rightPred: bias };
      }

      for (let i = 0; i < Xn.length; i++) {
        const pred = Xn[i][bestStump.feature] < bestStump.threshold
          ? bestStump.leftPred : bestStump.rightPred;
        residuals[i] -= learningRate * pred;
      }

      this.trees.push({ ...bestStump, weight: learningRate });
    }

    this.trained = true;
    this.trainingSize = training.length;
    this.modelVersion = `v1.0-${Date.now()}`;
    this.trainedAt = Date.now();
    this.validationMetrics = this.evaluate(validation);
    this.testMetrics = this.evaluate(test);
    this.saveModel();

    console.log(`[ML] Trained ${this.trees.length} stumps on ${training.length} samples; validation=${validation.length}, test=${test.length}`);

    const importance = new Array(nFeatures).fill(0);
    for (const tree of this.trees) {
      importance[tree.feature] += Math.abs(tree.leftPred - tree.rightPred);
    }
    const topFeatures = importance
      .map((imp, i) => ({ name: this.featureNames[i] || `f${i}`, imp }))
      .sort((a, b) => b.imp - a.imp)
      .slice(0, 5);
    console.log('[ML] Top features:', topFeatures.map(f => `${f.name}(${f.imp.toFixed(3)})`).join(', '));

    return true;
  }

  predict(features) {
    if (!this.trained || this.trees.length === 0) {
      return { confidence: 0.5, modelVersion: 'untrained' };
    }

    const xn = features.map((v, j) => (v - (this.featureMeans[j] || 0)) / (this.featureStds[j] || 1));

    let score = 0.5;
    for (const tree of this.trees) {
      const pred = xn[tree.feature] < tree.threshold ? tree.leftPred : tree.rightPred;
      score += tree.weight * pred;
    }

    const confidence = 1 / (1 + Math.exp(-4 * (score - 0.5)));

    return {
      confidence: Math.max(0, Math.min(1, confidence)),
      modelVersion: this.modelVersion,
      rawScore: score,
    };
  }

  // ===== RAG-lite Context (recent-signal summary, not vector search) =====

  tradeToText(signal, outcome) {
    return [
      `Signal: ${signal.type} on ${signal.ticker}`,
      `Side: ${signal.side} at ${signal.priceCents}c`,
      `Edge: ${signal.edge.toFixed(1)}%, Model P: ${(signal.modelProb * 100).toFixed(0)}%`,
      `Reason: ${signal.reason}`,
      outcome ? `Outcome: ${outcome.won ? 'WON' : 'LOST'}, P&L: $${outcome.pnl.toFixed(2)}` : 'Pending',
    ].join(' | ');
  }

  getRAGContext(signal) {
    const now = Date.now();
    const ttl = this.config.ML_CONTEXT_TTL_MS;
    let cached = this.recentCache.get(signal.ticker);
    if (!cached || now - cached.ts >= ttl) {
      // Expired tickers cannot accumulate indefinitely over a long session.
      for (const [key, value] of this.recentCache) {
        if (now - value.ts >= ttl) this.recentCache.delete(key);
      }
      cached = { ts: now, value: this.db.getRecentSignals(signal.ticker, 48) };
      this.recentCache.set(signal.ticker, cached);
    }
    if (!this.performanceCache || now - this.performanceCache.ts >= ttl) {
      this.performanceCache = { ts: now, value: this.db.getStrategyPerformance(7) };
    }
    const recent = cached.value;
    const perfStats = this.performanceCache.value;

    if (recent.length === 0 && Object.keys(perfStats).length === 0) return null;

    const contextParts = [];

    if (perfStats[signal.type]) {
      const s = perfStats[signal.type];
      const wr = s.count > 0 ? ((s.wins / s.count) * 100).toFixed(0) : '?';
      contextParts.push(`7-day ${signal.type} performance: ${s.count} trades, ${wr}% WR, P&L: $${s.pnl.toFixed(2)}`);
    }

    const similar = recent
      .filter(r => r.type === signal.type && r.outcome_won !== null && r.outcome_won !== undefined)
      .slice(0, 5);

    if (similar.length > 0) {
      const wins = similar.filter(s => s.outcome_won).length;
      contextParts.push(`Recent ${signal.type} signals: ${wins}/${similar.length} won`);

      const avgEdge = similar.reduce((s, r) => s + (r.edge || 0), 0) / similar.length;
      contextParts.push(`Avg edge of recent signals: ${avgEdge.toFixed(1)}%`);
    }

    return contextParts.length > 0 ? contextParts.join('\n') : null;
  }

  // ===== Integration with Signal Generator =====

  /**
   * Score a signal. `signal.signalId` (a UUID set in signal-generator.js)
   * is what lets this feature row get labeled later, at settlement — see
   * recordOutcome() below.
   */
  scoreSignal(signal, marketContext) {
    const features = this.extractFeatures(signal, marketContext);
    const prediction = this.predict(features);
    const ragContext = this.getRAGContext(signal);
    const signalUuid = signal.signalId || null;

    if (!signalUuid) {
      console.warn(`[ML] Signal for ${signal.ticker} has no signalId — its outcome can never be linked back for training.`);
    }

    const ts = Date.now();
    const featureRow = {
      ts,
      signalUuid,
      ticker: signal.ticker,
      signalType: signal.type,
      features,
      label: null, // filled in by recordOutcome() once the position settles
    };

    const predictionRow = this.trained ? {
        ts,
        signalUuid,
        modelVersion: this.modelVersion,
        confidence: prediction.confidence,
        predictedOutcome: prediction.confidence > 0.5 ? 1 : 0,
        featuresHash: features.slice(0, 5).map(f => f.toFixed(2)).join(','),
      } : null;
    this.getBuffer().enqueue(featureRow, predictionRow);

    let adjustment = 1.0;
    if (this.trained) {
      adjustment = 0.5 + (prediction.confidence - 0.3) * (1.5 / 0.4);
      const validated = this.config.ML_ALLOW_UPSIZE === true && this.trainingSize >= this.config.ML_UPSIZE_MIN_TRAINING_SAMPLES &&
        this.validationMetrics != null &&
        this.validationMetrics.brierScore < this.config.ML_BASELINE_BRIER;
      adjustment = Math.max(0.3, Math.min(validated ? 2.0 : 1.0, adjustment));
    }

    return {
      adjustment,
      confidence: prediction.confidence,
      modelVersion: prediction.modelVersion,
      ragContext,
      shouldBlock: adjustment < 0.5,
      features,
    };
  }

  /**
   * Record the outcome of a trade for the feedback loop. Call this once,
   * when a position fully closes (take-profit fill, stop-loss fill, or
   * settlement) — NOT on partial exits. Writes the label back onto the
   * ml_features row AND the outcome onto the signals row, both keyed by
   * signalUuid. This is the piece that was previously missing entirely.
   */
  async recordOutcome(signalUuid, won, pnl) {
    if (!signalUuid) return false;
    // A fast close can arrive before the timer flush. Insert its feature first.
    this.buffer?.flush();
    const labeled = this.db.updateFeatureLabel(signalUuid, won ? 1 : 0);
    this.db.updateSignalOutcome(signalUuid, { won, pnl });
    return labeled;
  }

  describe() {
    return {
      trained: this.trained,
      modelVersion: this.modelVersion,
      trainingSize: this.trainingSize,
      trees: this.trees.length,
      features: this.featureNames.length,
      trainedAt: this.trainedAt || null,
      validationMetrics: this.validationMetrics,
      testMetrics: this.testMetrics,
    };
  }
}

// Singleton
const pipeline = new MLPipeline();
module.exports = pipeline;
module.exports.MLPipeline = MLPipeline;
