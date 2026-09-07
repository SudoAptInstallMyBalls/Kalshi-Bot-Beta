function envNumber(name, fallback, { integer = false, min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    throw new Error(`Invalid ${name}=${raw}; expected ${integer ? 'integer' : 'number'} in [${min}, ${max}]`);
  }
  return value;
}

// Build config from env
const config = {
  KALSHI_API_KEY: process.env.KALSHI_API_KEY,
  KALSHI_PRIVATE_KEY_PATH: process.env.KALSHI_PRIVATE_KEY_PATH || './kalshi_private_key.pem',
  KALSHI_API_BASE: process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com',

  POLYMARKET_GAMMA_API: 'https://gamma-api.polymarket.com',
  POLYMARKET_CLOB_API: 'https://clob.polymarket.com',

  SERIES_TICKER: process.env.SERIES_TICKER || 'KXBTC15M',
  SLOT_DURATION: envNumber('SLOT_DURATION', 900, { integer: true, min: 1 }), // 15 min

  // Strategy thresholds
  MIN_EDGE: envNumber('MIN_EDGE', 10.0, { min: 0 }),
  // Backtest-optimized: higher threshold to filter overconfident signals
  MIN_DIVERGENCE: envNumber('MIN_DIVERGENCE', 15.0, { min: 0 }),
  TRADING_WINDOW: envNumber('TRADING_WINDOW', 4, { integer: true, min: 0 }), // minutes
  ENTRY_START_MINUTES: envNumber('ENTRY_START_MINUTES', 0, { min: 0, max: 14 }),
  ENTRY_CLOSE_BUFFER_SECONDS: envNumber('ENTRY_CLOSE_BUFFER_SECONDS', 30, { min: 30, max: 900 }),
  // Frozen research baseline; these bounds have not established profitability.
  MIN_CONTRACT_PRICE: envNumber('MIN_CONTRACT_PRICE', 35, { integer: true, min: 0, max: 100 }), // cents
  MAX_CONTRACT_PRICE: envNumber('MAX_CONTRACT_PRICE', 65, { integer: true, min: 0, max: 100 }), // cents

  // 1H Trend indicator
  TREND_ENABLED: process.env.TREND_ENABLED !== 'false',
  TREND_FAST_PERIOD: envNumber('TREND_FAST_PERIOD', 720, { integer: true, min: 1 }),     // 12 min
  TREND_SLOW_PERIOD: envNumber('TREND_SLOW_PERIOD', 2700, { integer: true, min: 1 }),    // 45 min
  TREND_ROC_WINDOW: envNumber('TREND_ROC_WINDOW', 1800, { integer: true, min: 1 }),      // 30 min
  TREND_ROC_THRESHOLD: envNumber('TREND_ROC_THRESHOLD', 0.02, { min: 0 }),
  TREND_BOOST: envNumber('TREND_BOOST', 0.25, { min: 0 }),
  TREND_PENALTY: envNumber('TREND_PENALTY', 0.40, { min: 0 }),

  // Position sizing
  // Conservative sizing baseline; independent equity caps also apply.
  USE_KELLY_SIZING: process.env.USE_KELLY_SIZING !== 'false',
  KELLY_FRACTION: envNumber('KELLY_FRACTION', 0.08, { min: 0, max: 1 }),
  TAKER_FEE_RATE: envNumber('TAKER_FEE_RATE', 0.07, { min: 0, max: 1 }),
  MODEL_PROBABILITY_WEIGHT: envNumber('MODEL_PROBABILITY_WEIGHT', 1, { min: 0, max: 1 }),
  // Live entries require the actual settlement index by default. No proxy is promoted here.
  SETTLEMENT_AWARE: process.env.SETTLEMENT_AWARE !== 'false',
  SETTLEMENT_INDEX_DB: process.env.SETTLEMENT_INDEX_DB || require('path').join(process.env.BOT_DATA_DIR || require('./paths').dataDir, 'settlement-index.sqlite'),
  MIN_NET_EDGE: envNumber('MIN_NET_EDGE', 0, { min: 0, max: 100 }),
  MAX_POSITION_SIZE: envNumber('MAX_POSITION_SIZE', 5, { min: 0 }),
  ENABLE_TELEMETRY: true,
  ML_ALLOW_UPSIZE: false,
  ROUND_TRIP_SLIPPAGE_CENTS: envNumber('ROUND_TRIP_SLIPPAGE_CENTS', 1, { min: 0, max: 25 }),
  MAX_TRADE_RISK_PCT: envNumber('MAX_TRADE_RISK_PCT', 0.01, { min: 0.001, max: 0.01 }),
  MAX_EQUITY_DRAWDOWN_PCT: envNumber('MAX_EQUITY_DRAWDOWN_PCT', 0.10, { min: 0.01, max: 0.50 }),
  EQUITY_MAX_AGE_MS: envNumber('EQUITY_MAX_AGE_MS', 30000, { min: 1000, max: 60000 }),
  MAX_POSITIONS_PER_CONTRACT: envNumber('MAX_POSITIONS_PER_CONTRACT', 1, { integer: true, min: 0 }),
  MAX_TOTAL_OPEN_POSITIONS: envNumber('MAX_TOTAL_OPEN_POSITIONS', 10, { integer: true, min: 0 }),
  SESSION_DRAWDOWN_REDUCE_PCT: envNumber('SESSION_DRAWDOWN_REDUCE_PCT', 0.10, { min: 0, max: 1 }),
  SESSION_DRAWDOWN_PAUSE_PCT: envNumber('SESSION_DRAWDOWN_PAUSE_PCT', 0.20, { min: 0, max: 1 }),
  SESSION_DRAWDOWN_PAUSE_MS: envNumber('SESSION_DRAWDOWN_PAUSE_MS', 900000, { integer: true, min: 1 }),
  MAX_EXECUTION_FAILURES: envNumber('MAX_EXECUTION_FAILURES', 5, { integer: true, min: 1 }),
  MIN_TRADING_BALANCE: envNumber('MIN_TRADING_BALANCE', 5, { min: 0 }),
  ML_FLUSH_INTERVAL_MS: envNumber('ML_FLUSH_INTERVAL_MS', 500, { integer: true, min: 1 }),
  ML_BUFFER_THRESHOLD: envNumber('ML_BUFFER_THRESHOLD', 50, { integer: true, min: 1 }),
  ML_CONTEXT_TTL_MS: envNumber('ML_CONTEXT_TTL_MS', 20000, { integer: true, min: 0 }),
  ML_MIN_TRAINING_SAMPLES: envNumber('ML_MIN_TRAINING_SAMPLES', 300, { integer: true, min: 10 }),
  ML_UPSIZE_MIN_TRAINING_SAMPLES: envNumber('ML_UPSIZE_MIN_TRAINING_SAMPLES', 1000, { integer: true, min: 1 }),
  ML_BASELINE_BRIER: envNumber('ML_BASELINE_BRIER', 0.25, { min: 0, max: 1 }),
};
if (config.SESSION_DRAWDOWN_REDUCE_PCT >= config.SESSION_DRAWDOWN_PAUSE_PCT) {
  throw new Error('Drawdown reduction threshold must be lower than pause threshold');
}


module.exports = { config, envNumber };
