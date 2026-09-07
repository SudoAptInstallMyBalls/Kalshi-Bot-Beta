/**
 * MLSignalScorer Skill
 *
 * Integrates the ML pipeline into the agentic framework.
 * Scores signals with a trained gradient-boosted model and
 * retrieves recent-history context from local storage.
 *
 * Capabilities: score-signal, train-model, get-ml-status
 *
 * NOTE: training data lives in local SQLite (src/storage/analytics-db.js) —
 * see src/ml/ml-pipeline.js. No remote "enabled" flag is needed;
 * mlPipeline.train() already
 * handles the case where there isn't enough labeled data yet.
 */

const BaseSkill = require('#src/agents/core/base-skill');
const mlPipeline = require('#src/ml/ml-pipeline');

class MLSignalScorer extends BaseSkill {
  constructor() {
    super({
      name: 'ml-signal-scorer',
      description: 'ML-powered signal quality scoring with local historical-trade context',
      domain: 'analysis',
      capabilities: ['score-signal', 'score-signals', 'train-model', 'get-ml-status'],
      dependencies: ['state-manager'],
    });
  }

  async initialize(context) {
    await super.initialize(context);
    mlPipeline.configure(context.config);

    // Attempt to train from existing local data. This is a no-op (returns
    // false and logs a message) if there aren't enough labeled
    // ml_features rows yet — see src/ml/ml-pipeline.js train().
    try {
      if (!mlPipeline.trained) await mlPipeline.train();
    } catch (err) {
      console.log(`[MLSignalScorer] Initial training skipped: ${err.message}`);
    }
  }

  async handleTask(task) {
    const state = this.context.registry.get('state-manager').botState;

    switch (task.action) {
      case 'score-signal': {
        const signal = task.params?.signal;
        if (!signal) throw new Error('signal required');

        const marketContext = this._buildMarketContext(signal, state);
        const result = await mlPipeline.scoreSignal(signal, marketContext);
        return result;
      }

      case 'score-signals': {
        // Score an array of signals, returning adjusted signals
        const signals = task.params?.signals || [];
        const scored = [];

        for (const signal of signals) {
          const marketContext = this._buildMarketContext(signal, state);
          const score = await mlPipeline.scoreSignal(signal, marketContext);

          scored.push({
            ...signal,
            mlConfidence: score.confidence,
            mlAdjustment: score.adjustment,
            mlBlocked: score.shouldBlock,
            ragContext: score.ragContext,
            // Adjust edge by ML confidence
            adjustedEdge: signal.edge * score.adjustment,
          });
        }

        // Filter out ML-blocked signals
        const approved = scored.filter(s => !s.mlBlocked);
        const blocked = scored.filter(s => s.mlBlocked);

        return { scoredSignals: approved, mlBlocked: blocked };
      }

      case 'train-model': {
        const success = await mlPipeline.train();
        return { trained: success, ...mlPipeline.describe() };
      }

      case 'get-ml-status': {
        return mlPipeline.describe();
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  _buildMarketContext(signal, state) {
    const market = state.activeMarkets.find(m => m.ticker === signal.ticker);
    const trend = state.model || {};
    const stats = state.stats || {};
    // closePosition() synchronously updates these realized stats only after a
    // position fully closes; restored stats likewise describe prior closes.
    // Feature extraction is synchronous before execution, so this signal's own
    // unresolved outcome cannot enter its feature vector, even with fast fills.

    return {
      btcPrice: state.btcPrice.binance || 0,
      openPrice: state.marketOpenPrices[signal.ticker] || 0,
      timeRemainingMs: market ? market.closeTime - Date.now() : 0,
      totalDurationMs: 900000,
      sigma: trend.volatility || 0.0015,
      trend: trend.trend || 'NEUTRAL',
      trendStrength: trend.trendStrength || 0,
      trendROC: trend.trendROC || 0,
      yesAsk: market?.yesAsk ?? 0.5,
      noAsk: market?.noAsk ?? 0.5,
      yesBid: market?.yesBid ?? 0.5,
      noBid: market?.noBid ?? 0.5,
      recentWinRate: stats.totalTrades > 0 ? stats.wins / stats.totalTrades : 0.5,
      recentPnL: stats.totalPnL || 0,
      streak: stats.streak || 0,
      balanceAvailable: state.balance.available || 0,
    };
  }

  async stop() {
    mlPipeline.stop(); // Synchronous final batch before the analytics DB closes.
    await super.stop();
  }
}

module.exports = MLSignalScorer;
