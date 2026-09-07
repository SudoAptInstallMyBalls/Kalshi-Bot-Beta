#!/usr/bin/env node

/**
 * Kalshibot Server — Agentic Architecture with Live Watchdog & Coinbase Bridge
 *
 * Entry point that creates the MasterAgent (which owns the Orchestrator,
 * SkillRegistry, and all sub-agent skills), wires up the Express/Socket.io
 * UI layer, and manages the bot lifecycle.
 */

require('dotenv').config({ path: process.env.BOT_ENV_FILE || require('path').join(require('#src/config/paths').root, '.env') });
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const { publicDir, dataDir } = require('#src/config/paths');
const { MasterAgent } = require('#src/agents/index');

const PORT = Number.parseInt(process.env.PORT ?? '3333', 10);
const HOST = process.env.HOST || '127.0.0.1';

const { config } = require('#src/config/runtime');
const { CONTROL_TOKEN, safeEqual, requireControlAuth, isAllowedOrigin } = require('#src/server/auth').createAuth(PORT);

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
app.use(express.static(publicDir));

// Create the MasterAgent
const agent = new MasterAgent(config);

// Helper to query live index SQLite sample count safely
function getIndexSampleCount() {
  try {
    const dbPath = path.join(process.env.BOT_DATA_DIR || dataDir, 'settlement-index.sqlite');
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const row = db.prepare('SELECT count(*) as c FROM index_samples').get();
      db.close();
      return row?.c || 0;
    }
  } catch (_) {}
  return 0;
}

// Health check
app.get('/api/health', (req, res) => {
  const ramMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    botRunning: agent.running,
    ramMb,
    indexSamples: getIndexSampleCount(),
  });
});

// Protect all bot/control-plane data; health remains public.
app.use('/api', (req, res, next) => req.path === '/health' ? next() : requireControlAuth(req, res, next));

// Bot control: start/stop
app.post('/api/bot/start', (req, res) => {
  if (agent.running) {
    return res.json({ status: 'already_running' });
  }
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
    res.json({
      ...agent.state.getSnapshot(),
      environment: new URL(config.KALSHI_API_BASE).hostname === 'external-api.demo.kalshi.co' ? 'demo' : 'production',
      ramMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      indexSamples: getIndexSampleCount(),
    });
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
    const mlPipeline = require('#src/ml/ml-pipeline');
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

  // Send full snapshot on connect, enriched with watchdog stats
  socket.emit('bot:status', { running: agent.running });
  if (agent.state) {
    const snap = agent.state.getSnapshot();
    const ramMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    socket.emit('snapshot', {
      ...snap,
      environment: new URL(config.KALSHI_API_BASE).hostname === 'external-api.demo.kalshi.co' ? 'demo' : 'production',
      ramMb,
      indexSamples: getIndexSampleCount(),
      pendingOrders: agent.state?.botState?.pendingOrders || snap.pendingOrders || {},
      consecutiveFailures: agent.state?.botState?.consecutiveFailures ?? snap.consecutiveFailures ?? 0,
    });
  }

  // Forward state events to this socket (including coinbase!)
  const events = [
    'price:coinbase', 'price:binance', 'price:redstone', 'balance', 'markets',
    'intent', 'model', 'trade',
    'order:pending', 'order:removed',
    'position:open', 'position:close', 'position:updated',
    'stats', 'connection:coinbase', 'connection:kalshi', 'connection:polymarket', 'connection:binance',
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

// Background Watchdog Broadcast (Streams RAM, pending orders, and DB samples every 2s)
const healthInterval = setInterval(() => {
  const ramMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  const snap = agent.state ? agent.state.getSnapshot() : {};
  const pendingOrders = agent.state?.botState?.pendingOrders || snap.pendingOrders || {};
  const consecutiveFailures = agent.state?.botState?.consecutiveFailures ?? snap.consecutiveFailures ?? 0;
  const indexSamples = getIndexSampleCount();

  io.emit('system:health', {
    ramMb,
    uptime: Math.floor(process.uptime()),
    pendingOrders,
    consecutiveFailures,
    indexSamples,
  });
}, 2000);

// Start server, then agent
server.listen(PORT, HOST, () => {
  console.log(`\n  KALSHIBOT MISSION CONTROL (Agentic Architecture)`);
  console.log(`  Dashboard:  http://${HOST}:${PORT}`);
  console.log(`  Skills API: http://localhost:${PORT}/api/skills`);
  console.log(`  Kalshi API: ${config.KALSHI_API_BASE}`);
  console.log(`  Config: ${config.SERIES_TICKER} | MinEdge=${config.MIN_EDGE}% | MinDiv=${config.MIN_DIVERGENCE}% | MaxPos=$${config.MAX_POSITION_SIZE}\n`);
  console.log('  Bot is IDLE. Use the dashboard toggle to start trading.\n');
});

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(healthInterval);
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