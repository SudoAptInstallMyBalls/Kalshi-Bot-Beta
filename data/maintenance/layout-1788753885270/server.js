#!/usr/bin/env node

/**
 * Kalshibot Server — Agentic Architecture
 *
 * Entry point that creates the MasterAgent (which owns the Orchestrator,
 * SkillRegistry, and all sub-agent skills), wires up the Express/Socket.io
 * UI layer, and manages the bot lifecycle.
 *
 * Architecture:
 *   server.js → MasterAgent → Orchestrator → Skills
 *
 * The persistent MasterAgent is the only supported trading entry point.
 */

require('dotenv').config({ path: process.env.BOT_ENV_FILE || '.env' });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { MasterAgent } = require('./agents');

const PORT = Number.parseInt(process.env.PORT ?? '3333', 10);
const HOST = process.env.HOST || '127.0.0.1';

function envNumber(name, fallback, { integer = false, min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    throw new Error(`Invalid ${name}=${raw}; expected ${integer ? 'integer' : 'number'} in [${min}, ${max}]`);
  }
  return value;
}

const CONTROL_TOKEN = process.env.BOT_CONTROL_TOKEN || process.env.DASHBOARD_API_TOKEN || '';
const configuredOrigins = (process.env.DASHBOARD_ORIGINS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const defaultOrigins = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
const allowedOrigins = new Set(configuredOrigins.length ? configuredOrigins : defaultOrigins);

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function extractToken(req) {
  const auth = req.get('authorization') || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return (req.get('x-kalshibot-token') || '').trim();
}

function requireControlAuth(req, res, next) {
  if (!CONTROL_TOKEN) {
    return res.status(503).json({ error: 'Control API disabled: set BOT_CONTROL_TOKEN' });
  }
  if (!safeEqual(extractToken(req), CONTROL_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function isAllowedOrigin(origin) {
  // Non-browser clients may omit Origin; bearer auth still applies.
  return !origin || allowedOrigins.has(origin);
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

// Express + Socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      callback(isAllowedOrigin(origin) ? null : new Error('Origin not allowed'), isAllowedOrigin(origin));
    },
    methods: ['GET', 'POST'],
  },
});

io.use((socket, next) => {
  if (!CONTROL_TOKEN) return next(new Error('Socket API disabled: set BOT_CONTROL_TOKEN'));
  const token = socket.handshake.auth?.token || socket.handshake.headers['x-kalshibot-token'];
  if (!safeEqual(token, CONTROL_TOKEN)) return next(new Error('Unauthorized'));
  if (!isAllowedOrigin(socket.handshake.headers.origin)) return next(new Error('Origin not allowed'));
  next();
});

// Serve static UI
app.use(express.static(path.join(__dirname, 'public')));

// Create the MasterAgent
const agent = new MasterAgent(config);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), botRunning: agent.running });
});

// Protect all bot/control-plane data; health remains public.
app.use('/api', (req, res, next) => req.path === '/health' ? next() : requireControlAuth(req, res, next));

// Bot control: start/stop
app.post('/api/bot/start', (req, res) => {
  if (agent.running) {
    return res.json({ status: 'already_running' });
  }
  // Respond immediately — start() is long-running (connects to feeds, waits for prices)
  res.json({ status: 'starting' });
  agent.start()
    .then(() => {
      io.emit('bot:status', { running: true });
    })
    .catch((err) => {
      console.error('[Server] Bot start failed:', err.message);
      io.emit('bot:status', { running: false, error: err.message });
    });
});

app.post('/api/bot/stop', async (req, res) => {
  if (!agent.running) {
    return res.json({ status: 'already_stopped' });
  }
  await agent.stop();
  io.emit('bot:status', { running: false });
  res.json({ status: 'stopped' });
});

app.get('/api/bot/status', (req, res) => {
  res.json({ running: agent.running });
});

// API: get current state
app.get('/api/state', (req, res) => {
  if (agent && agent.state) {
    res.json({ ...agent.state.getSnapshot(), environment: new URL(config.KALSHI_API_BASE).hostname === 'external-api.demo.kalshi.co' ? 'demo' : 'production' });
  } else {
    res.json({ error: 'Agent not started' });
  }
});

// API: force save state to disk
app.post('/api/save', async (req, res) => {
  if (!agent || !agent.state) {
    return res.status(409).json({ error: 'Agent not started' });
  }
  try {
    await Promise.resolve(agent.state.saveNow());
    res.json({ status: 'saved' });
  } catch (err) {
    console.error('[Server] State save failed:', err);
    res.status(500).json({ error: 'State save failed' });
  }
});

// API: ML pipeline status
app.get('/api/ml', (req, res) => {
  const mlScorer = agent.registry.get('ml-signal-scorer');
  if (mlScorer) {
    const mlPipeline = require('./lib/ml-pipeline');
    res.json(mlPipeline.describe());
  } else {
    res.json({ trained: false, note: 'ML scorer not initialized' });
  }
});

// API: get agent skill registry status
app.get('/api/skills', (req, res) => {
  res.json({
    skills: agent.registry.describeAll(),
    orchestrator: agent.orchestrator.describe(),
  });
});

// Socket.io: push updates to UI
io.on('connection', (socket) => {
  console.log(`[Server] UI connected: ${socket.id}`);

  // Send full snapshot on connect
  socket.emit('bot:status', { running: agent.running });
  if (agent.state) {
    socket.emit('snapshot', { ...agent.state.getSnapshot(), environment: new URL(config.KALSHI_API_BASE).hostname === 'external-api.demo.kalshi.co' ? 'demo' : 'production' });
  }

  // Forward state events to this socket
  const events = [
    'price:binance', 'price:redstone', 'balance', 'markets',
    'intent', 'model', 'trade',
    'order:pending', 'order:removed',
    'position:open', 'position:close', 'position:updated',
    'stats', 'connection:kalshi', 'connection:polymarket', 'connection:binance',
  ];

  const handlers = {};
  for (const event of events) {
    handlers[event] = (data) => socket.emit(event, data);
    if (agent.state) {
      agent.state.on(event, handlers[event]);
    }
  }

  socket.on('disconnect', () => {
    console.log(`[Server] UI disconnected: ${socket.id}`);
    for (const event of events) {
      try {
        if (agent.state) {
          agent.state.removeListener(event, handlers[event]);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });
});

// Start server, then agent
server.listen(PORT, HOST, () => {
  console.log(`\n  KALSHIBOT MISSION CONTROL (Agentic Architecture)`);
  console.log(`  Dashboard:  http://${HOST}:${PORT}`);
  console.log(`  Skills API: http://localhost:${PORT}/api/skills`);
  console.log(`  Kalshi API: ${config.KALSHI_API_BASE}`);
  console.log(`  Config: ${config.SERIES_TICKER} | MinEdge=${config.MIN_EDGE}% | MinDiv=${config.MIN_DIVERGENCE}% | MaxPos=$${config.MAX_POSITION_SIZE}\n`);

  // Bot does NOT auto-start — user controls via dashboard toggle
  console.log('  Bot is IDLE. Use the dashboard toggle to start trading.\n');
});

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Server] Shutting down (${signal})...`);
  try {
    if (agent.state) await Promise.resolve(agent.state.saveNow());
    await agent.stop();
    await new Promise((resolve) => server.close(resolve));
  } catch (err) {
    console.error('[Server] Shutdown error:', err);
    process.exitCode = 1;
  } finally {
    process.exit();
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
