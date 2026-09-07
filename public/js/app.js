import { state } from './state.js';
import { el } from './dom.js';
import { getApiToken, authenticatedFetch } from './api.js';
import { updateChart, setChartMode, addSpotTick } from './chart.js';
import {
  updateConnections,
  updateBtcPrice,
  updateWatchdog,
  updatePnL,
  updateBalance,
  updateIntent,
  updateModel,
  updatePositions,
  updateMarkets,
  updateTradeLog,
  updateStats
} from './views.js';

const socket = io({ auth: { token: getApiToken() } });
let startTime = null;

// Tab switcher between P&L and Coinbase Chart
el('btn-chart-pnl')?.addEventListener('click', () => setChartMode('pnl', state.pnlHistory));
el('btn-chart-btc')?.addEventListener('click', () => setChartMode('btc', state.pnlHistory));

// Restore PnL
try {
  const savedPnl = localStorage.getItem('kalshibot_pnlHistory');
  if (savedPnl) state.pnlHistory = JSON.parse(savedPnl);
} catch (_) {}

if (state.pnlHistory.length > 0) updateChart(state.pnlHistory);

// Bot Toggle
let botRunning = false;
const toggleBtn = el('bot-toggle');
const toggleIcon = el('toggle-icon');
const toggleLabel = el('toggle-label');

function updateToggleUI(running) {
  botRunning = running;
  if (running) {
    toggleBtn.classList.add('running');
    toggleIcon.textContent = '■';
    toggleLabel.textContent = 'STOP';
  } else {
    toggleBtn.classList.remove('running');
    toggleIcon.textContent = '▶';
    toggleLabel.textContent = 'START';
  }
}

toggleBtn?.addEventListener('click', async () => {
  toggleBtn.disabled = true;
  toggleLabel.textContent = botRunning ? 'STOPPING...' : 'STARTING...';
  try {
    const endpoint = botRunning ? '/api/bot/stop' : '/api/bot/start';
    await authenticatedFetch(endpoint, { method: 'POST' });
  } catch (err) {
    console.error('Toggle failed:', err);
  } finally {
    toggleBtn.disabled = false;
  }
});

// Socket.IO Handlers
socket.on('snapshot', (data) => {
  state.connections = data.connections || {};
  state.btcPrice = data.btcPrice || {};
  state.balance = data.balance || {};
  state.activeMarkets = data.activeMarkets || [];
  state.openPositions = data.openPositions || [];
  state.tradeLog = data.tradeLog || [];
  state.intent = data.intent || {};
  state.stats = data.stats || {};
  state.model = data.model || {};
  state.pnlHistory = data.pnlHistory || state.pnlHistory || [];

  updateConnections(state.connections);
  updateBtcPrice(state.btcPrice);
  updateWatchdog({
    ramMb: data.ramMb || Math.round(performance?.memory?.usedJSHeapSize / 1048576) || null,
    pendingOrders: data.pendingOrders || {},
    consecutiveFailures: data.consecutiveFailures || 0,
    indexSamples: data.indexSamples || 0,
  });
  updatePnL(state.stats);
  updateBalance(state.balance);
  updateIntent(state.intent);
  updateModel(state.model);
  updatePositions(state.openPositions);
  updateMarkets(state.activeMarkets, state.btcPrice.coinbase || state.btcPrice.binance);
  updateTradeLog(state.tradeLog);
  updateStats(state.stats);
  updateChart(state.pnlHistory);
});

socket.on('price:coinbase', (data) => {
  state.btcPrice = { ...state.btcPrice, coinbase: data.price, coinbaseBid: data.bid, coinbaseAsk: data.ask };
  state.connections.coinbase = true;
  updateBtcPrice(state.btcPrice);
  updateConnections(state.connections);
  addSpotTick(data.price, state.activeMarkets[0]?.floorStrike);
});

socket.on('price:binance', (data) => {
  state.btcPrice = { ...state.btcPrice, binance: data.mid, binanceBid: data.bid, binanceAsk: data.ask };
  state.connections.binance = true;
  updateBtcPrice(state.btcPrice);
  updateConnections(state.connections);
});

socket.on('system:health', (data) => {
  updateWatchdog(data);
});

socket.on('bot:status', (data) => updateToggleUI(data.running));