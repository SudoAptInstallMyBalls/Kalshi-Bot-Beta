import { state } from './state.js';
import { el } from './dom.js';
import { getApiToken, authenticatedFetch } from './api.js';
import { updateChart } from './chart.js';
import { updateConnections, updateBtcPrice, updatePnL, updateBalance, updateIntent, updateModel, updatePositions, updateMarkets, updateTradeLog, updateStats } from './views.js';

const socket = io({ auth: { token: getApiToken() } });
let startTime = null; // Set from server's persistent startTime

// ========== Restore from localStorage ==========
try {
  const savedPnl = localStorage.getItem('kalshibot_pnlHistory');
  if (savedPnl) {
    const parsed = JSON.parse(savedPnl);
    if (Array.isArray(parsed) && parsed.length > 0) {
      state.pnlHistory = parsed;
    }
  }
  const savedStart = localStorage.getItem('kalshibot_startTime');
  if (savedStart) startTime = parseInt(savedStart, 10);
} catch (e) {
  // Ignore localStorage errors
}

// Render chart from restored localStorage data on load
if (state.pnlHistory.length > 0) {
  updateChart(state.pnlHistory);
}

// ========== Uptime Timer ==========
setInterval(() => {
  if (!startTime) {
    el('uptime').textContent = '00:00:00';
    return;
  }
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  el('uptime').textContent = `${h}:${m}:${s}`;
}, 1000);

// ========== Bot Toggle ==========
let botRunning = false;
const toggleBtn = el('bot-toggle');
const toggleIcon = el('toggle-icon');
const toggleLabel = el('toggle-label');

function updateToggleUI(running) {
  botRunning = running;
  if (running) {
    toggleBtn.classList.add('running');
    toggleBtn.classList.remove('stopped');
    toggleIcon.textContent = '■'; // stop square
    toggleLabel.textContent = 'STOP';
  } else {
    toggleBtn.classList.remove('running');
    toggleBtn.classList.add('stopped');
    toggleIcon.textContent = '▶'; // play triangle
    toggleLabel.textContent = 'START';
  }
}

toggleBtn.addEventListener('click', async () => {
  toggleBtn.disabled = true;
  toggleLabel.textContent = botRunning ? 'STOPPING...' : 'STARTING...';
  try {
    const endpoint = botRunning ? '/api/bot/stop' : '/api/bot/start';
    const res = await authenticatedFetch(endpoint, { method: 'POST' });
    const data = await res.json();
    if (data.status === 'error') {
      console.error('Bot toggle error:', data.message);
    }
  } catch (err) {
    console.error('Bot toggle failed:', err);
  } finally {
    toggleBtn.disabled = false;
  }
});

// ========== Socket.io Handlers ==========
socket.on('connect', () => {
  console.log('Connected to Kalshibot server');
});

socket.on('snapshot', (data) => {
  // Merge P&L history: keep whichever is longer/more complete
  if (state.pnlHistory && state.pnlHistory.length > 0 && data.pnlHistory) {
    if (data.pnlHistory.length >= state.pnlHistory.length) {
      state.pnlHistory = data.pnlHistory;
    }
    // else: keep client's existing pnlHistory (accumulated during session)
  } else {
    state.pnlHistory = data.pnlHistory || [];
  }

  // Always take authoritative data from server
  state.connections = data.connections;
  state.btcPrice = data.btcPrice;
  state.balance = data.balance;
  state.activeMarkets = data.activeMarkets || [];
  state.openPositions = data.openPositions || [];
  state.tradeLog = data.tradeLog || [];
  state.intent = data.intent || {};
  state.stats = data.stats || {};
  state.model = data.model || {};

  // Reconcile: if server stats show $0 P&L but pnlHistory has data, use pnlHistory's cumulative
  if ((!state.stats.totalPnL || state.stats.totalPnL === 0) && state.pnlHistory.length > 0) {
    const lastEntry = state.pnlHistory[state.pnlHistory.length - 1];
    if (lastEntry && lastEntry.cumulative && lastEntry.cumulative !== 0) {
      state.stats.totalPnL = lastEntry.cumulative;
      // Also reconstruct win/loss counts from pnlHistory if stats are stale
      if (!state.stats.totalTrades || state.stats.totalTrades === 0) {
        let wins = 0, losses = 0;
        for (const entry of state.pnlHistory) {
          if (entry.pnl > 0) wins++;
          else if (entry.pnl < 0) losses++;
        }
        state.stats.totalTrades = state.pnlHistory.length;
        state.stats.wins = wins;
        state.stats.losses = losses;
      }
    }
  }

  // Use persistent startTime from server (original session start)
  startTime = data.startTime || data.stats?.startTime || startTime;
  if (startTime) {
    try { localStorage.setItem('kalshibot_startTime', String(startTime)); } catch(e) {}
  }

  const environmentMode = document.getElementById('environment-mode');
  if (environmentMode) environmentMode.textContent = data.environment === 'demo' ? 'DEMO' : data.environment === 'production' ? 'LIVE' : 'UNKNOWN';
  updateConnections(data.connections);
  updateBtcPrice(data.btcPrice);
  updatePnL(state.stats);
  updateBalance(data.balance);
  updateIntent(data.intent);
  updateModel(data.model);
  updatePositions(state.openPositions);
  updateMarkets(state.activeMarkets);
  updateTradeLog(state.tradeLog);
  updateStats(state.stats);
  updateChart(state.pnlHistory);
});

socket.on('price:binance', (data) => {
  state.btcPrice = { ...state.btcPrice, binance: data.mid, binanceBid: data.bid, binanceAsk: data.ask };
  state.connections.binance = true;
  updateBtcPrice(state.btcPrice);
  updateConnections(state.connections);
});

socket.on('price:redstone', (data) => {
  state.btcPrice = { ...state.btcPrice, redstone: data.price };
  updateBtcPrice(state.btcPrice);
  updateConnections({ ...state.connections, redstone: true });
});

socket.on('balance', (data) => {
  state.balance = data;
  updateBalance(data);
});

socket.on('markets', (data) => {
  state.activeMarkets = data;
  updateMarkets(data);
  // Markets refreshed = Kalshi connection alive
  if (data && data.length > 0) {
    state.connections.kalshi = true;
    updateConnections(state.connections);
  }
});

socket.on('intent', (data) => {
  state.intent = data;
  updateIntent(data);
});

socket.on('model', (data) => {
  state.model = data;
  updateModel(data);
});

socket.on('trade', (data) => {
  state.tradeLog.unshift(data);
  if (state.tradeLog.length > 50) state.tradeLog.pop();
  updateTradeLog(state.tradeLog);
});

socket.on('position:open', (data) => {
  state.openPositions.push(data);
  updatePositions(state.openPositions);
});

socket.on('position:close', (data) => {
  state.openPositions = state.openPositions.filter(p => p.orderId !== data.orderId);
  updatePositions(state.openPositions);
  state.pnlHistory.push({ timestamp: Date.now(), pnl: data.pnl, cumulative: (state.stats?.totalPnL || 0) });
  updateChart(state.pnlHistory);
});

socket.on('stats', (data) => {
  state.stats = data;
  updatePnL(data);
  updateStats(data);
});

socket.on('connection:kalshi', (connected) => {
  state.connections = { ...state.connections, kalshi: connected };
  updateConnections(state.connections);
});

socket.on('connection:polymarket', (connected) => {
  state.connections = { ...state.connections, polymarket: connected };
  updateConnections(state.connections);
});

socket.on('connection:binance', (connected) => {
  state.connections = { ...state.connections, binance: connected };
  updateConnections(state.connections);
});

socket.on('bot:status', (data) => {
  updateToggleUI(data.running);
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
  updateToggleUI(false);
  updateConnections({ binance: false, polymarket: false, kalshi: false, redstone: false });
});
