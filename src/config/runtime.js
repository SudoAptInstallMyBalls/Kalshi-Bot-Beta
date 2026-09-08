const DEFAULTS = require('./defaults');
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
  SLOT_DURATION: envNumber('SLOT_DURATION', DEFAULTS.SLOT_DURATION, { integer: true, min: 1 }), // 15 min

  // Strategy thresholds
  MIN_EDGE: envNumber('MIN_EDGE', DEFAULTS.MIN_EDGE, { min: 0 }),
  // Frozen baseline threshold; this has not established profitability.
  MIN_DIVERGENCE: envNumber('MIN_DIVERGENCE', DEFAULTS.MIN_DIVERGENCE, { min: 0 }),
  TRADING_WINDOW: envNumber('TRADING_WINDOW', DEFAULTS.TRADING_WINDOW, { integer: true, min: 0 }), // minutes
  ENTRY_START_MINUTES: envNumber('ENTRY_START_MINUTES', DEFAULTS.ENTRY_START_MINUTES, { min: 0, max: 14 }),
  ENTRY_CLOSE_BUFFER_SECONDS: envNumber('ENTRY_CLOSE_BUFFER_SECONDS', DEFAULTS.ENTRY_CLOSE_BUFFER_SECONDS, { min: 30, max: 900 }),
  // Frozen research baseline; these bounds have not established profitability.
  MIN_CONTRACT_PRICE: envNumber('MIN_CONTRACT_PRICE', DEFAULTS.MIN_CONTRACT_PRICE, { integer: true, min: 0, max: 100 }), // cents
  MAX_CONTRACT_PRICE: envNumber('MAX_CONTRACT_PRICE', DEFAULTS.MAX_CONTRACT_PRICE, { integer: true, min: 0, max: 100 }), // cents

  // 1H Trend indicator
  TREND_ENABLED: process.env.TREND_ENABLED !== 'false',
  TREND_FAST_PERIOD: envNumber('TREND_FAST_PERIOD', DEFAULTS.TREND_FAST_PERIOD, { integer: true, min: 1 }),     // 12 min
  TREND_SLOW_PERIOD: envNumber('TREND_SLOW_PERIOD', DEFAULTS.TREND_SLOW_PERIOD, { integer: true, min: 1 }),    // 45 min
  TREND_ROC_WINDOW: envNumber('TREND_ROC_WINDOW', DEFAULTS.TREND_ROC_WINDOW, { integer: true, min: 1 }),      // 30 min
  TREND_ROC_THRESHOLD: envNumber('TREND_ROC_THRESHOLD', DEFAULTS.TREND_ROC_THRESHOLD, { min: 0 }),
  TREND_BOOST: envNumber('TREND_BOOST', DEFAULTS.TREND_BOOST, { min: 0 }),
  TREND_PENALTY: envNumber('TREND_PENALTY', DEFAULTS.TREND_PENALTY, { min: 0 }),

  // Position sizing
  // Conservative sizing baseline; independent equity caps also apply.
  USE_KELLY_SIZING: process.env.USE_KELLY_SIZING !== 'false',
  KELLY_FRACTION: envNumber('KELLY_FRACTION', DEFAULTS.KELLY_FRACTION, { min: 0, max: 1 }),
  TAKER_FEE_RATE: envNumber('TAKER_FEE_RATE', DEFAULTS.TAKER_FEE_RATE, { min: 0, max: 1 }),
  MODEL_PROBABILITY_WEIGHT: envNumber('MODEL_PROBABILITY_WEIGHT', DEFAULTS.MODEL_PROBABILITY_WEIGHT, { min: 0, max: 1 }),
  // Live entries require the actual settlement index by default. No proxy is promoted here.
  SETTLEMENT_AWARE: process.env.SETTLEMENT_AWARE !== 'false',
  SETTLEMENT_INDEX_DB: process.env.SETTLEMENT_INDEX_DB || require('path').join(process.env.BOT_DATA_DIR || require('./paths').dataDir, 'settlement-index.sqlite'),
  MIN_NET_EDGE: envNumber('MIN_NET_EDGE', DEFAULTS.MIN_NET_EDGE, { min: 0, max: 100 }),
  MAX_POSITION_SIZE: envNumber('MAX_POSITION_SIZE', DEFAULTS.MAX_POSITION_SIZE, { min: 0 }),
  ENABLE_TELEMETRY: true,
  ML_ALLOW_UPSIZE: false,
  ROUND_TRIP_SLIPPAGE_CENTS: envNumber('ROUND_TRIP_SLIPPAGE_CENTS', DEFAULTS.ROUND_TRIP_SLIPPAGE_CENTS, { min: 0, max: 25 }),
  MAX_TRADE_RISK_PCT: envNumber('MAX_TRADE_RISK_PCT', DEFAULTS.MAX_TRADE_RISK_PCT, { min: 0.001, max: 0.01 }),
  MAX_EQUITY_DRAWDOWN_PCT: envNumber('MAX_EQUITY_DRAWDOWN_PCT', DEFAULTS.MAX_EQUITY_DRAWDOWN_PCT, { min: 0.01, max: 0.50 }),
  EQUITY_MAX_AGE_MS: envNumber('EQUITY_MAX_AGE_MS', DEFAULTS.EQUITY_MAX_AGE_MS, { min: 1000, max: 60000 }),
  MAX_POSITIONS_PER_CONTRACT: envNumber('MAX_POSITIONS_PER_CONTRACT', DEFAULTS.MAX_POSITIONS_PER_CONTRACT, { integer: true, min: 0 }),
  MAX_TOTAL_OPEN_POSITIONS: envNumber('MAX_TOTAL_OPEN_POSITIONS', DEFAULTS.MAX_TOTAL_OPEN_POSITIONS, { integer: true, min: 0 }),
  SESSION_DRAWDOWN_REDUCE_PCT: envNumber('SESSION_DRAWDOWN_REDUCE_PCT', DEFAULTS.SESSION_DRAWDOWN_REDUCE_PCT, { min: 0, max: 1 }),
  SESSION_DRAWDOWN_PAUSE_PCT: envNumber('SESSION_DRAWDOWN_PAUSE_PCT', DEFAULTS.SESSION_DRAWDOWN_PAUSE_PCT, { min: 0, max: 1 }),
  SESSION_DRAWDOWN_PAUSE_MS: envNumber('SESSION_DRAWDOWN_PAUSE_MS', DEFAULTS.SESSION_DRAWDOWN_PAUSE_MS, { integer: true, min: 1 }),
  MAX_EXECUTION_FAILURES: envNumber('MAX_EXECUTION_FAILURES', DEFAULTS.MAX_EXECUTION_FAILURES, { integer: true, min: 1 }),
  MIN_TRADING_BALANCE: envNumber('MIN_TRADING_BALANCE', DEFAULTS.MIN_TRADING_BALANCE, { min: 0 }),
  ML_FLUSH_INTERVAL_MS: envNumber('ML_FLUSH_INTERVAL_MS', DEFAULTS.ML_FLUSH_INTERVAL_MS, { integer: true, min: 1 }),
  ML_BUFFER_THRESHOLD: envNumber('ML_BUFFER_THRESHOLD', DEFAULTS.ML_BUFFER_THRESHOLD, { integer: true, min: 1 }),
  ML_CONTEXT_TTL_MS: envNumber('ML_CONTEXT_TTL_MS', DEFAULTS.ML_CONTEXT_TTL_MS, { integer: true, min: 0 }),
  ML_MIN_TRAINING_SAMPLES: envNumber('ML_MIN_TRAINING_SAMPLES', DEFAULTS.ML_MIN_TRAINING_SAMPLES, { integer: true, min: 10 }),
  ML_UPSIZE_MIN_TRAINING_SAMPLES: envNumber('ML_UPSIZE_MIN_TRAINING_SAMPLES', DEFAULTS.ML_UPSIZE_MIN_TRAINING_SAMPLES, { integer: true, min: 1 }),
  ML_BASELINE_BRIER: envNumber('ML_BASELINE_BRIER', DEFAULTS.ML_BASELINE_BRIER, { min: 0, max: 1 }),
};
if (config.SESSION_DRAWDOWN_REDUCE_PCT >= config.SESSION_DRAWDOWN_PAUSE_PCT) {
  throw new Error('Drawdown reduction threshold must be lower than pause threshold');
}


module.exports = { config, envNumber };
