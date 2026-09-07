import { el } from './dom.js';

const ctx = document.getElementById('pnl-chart').getContext('2d');

let currentMode = 'pnl'; // 'pnl' or 'btc'
let spotHistory = []; // [{ time, price, strike }]

const chart = new Chart(ctx, {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      {
        label: 'Cumulative P&L',
        data: [],
        borderColor: '#38ef7d',
        backgroundColor: 'rgba(56, 239, 125, 0.08)',
        borderWidth: 2,
        fill: true,
        tension: 0.2,
        pointRadius: 2,
      },
      {
        label: 'Kalshi Active Strike',
        data: [],
        borderColor: '#facc15',
        borderDash: [5, 5],
        borderWidth: 1.5,
        fill: false,
        pointRadius: 0,
      }
    ],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#181c18',
        borderColor: '#282f28',
        borderWidth: 1,
        bodyFont: { family: 'JetBrains Mono' },
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(255, 255, 255, 0.05)' },
        ticks: { color: '#6e7568', font: { size: 9 }, maxTicksLimit: 8 },
      },
      y: {
        grid: { color: 'rgba(255, 255, 255, 0.05)' },
        ticks: {
          color: '#6e7568',
          font: { size: 9 },
          callback: v => currentMode === 'pnl' ? '$' + v.toFixed(2) : '$' + v.toLocaleString(),
        },
      },
    },
  },
});

function setChartMode(mode, pnlHistory) {
  currentMode = mode;
  el('btn-chart-pnl')?.classList.toggle('active', mode === 'pnl');
  el('btn-chart-btc')?.classList.toggle('active', mode === 'btc');

  if (mode === 'pnl') {
    chart.data.datasets[0].label = 'Cumulative P&L';
    chart.data.datasets[1].data = [];
    updateChart(pnlHistory);
  } else {
    chart.data.datasets[0].label = 'Coinbase BTC Spot';
    chart.data.datasets[0].borderColor = '#38bdf8';
    chart.data.datasets[0].backgroundColor = 'rgba(56, 189, 248, 0.08)';
    renderBtcChart();
  }
}

function updateChart(pnlHistory) {
  if (currentMode !== 'pnl' || !pnlHistory || pnlHistory.length === 0) return;

  const labels = pnlHistory.map(p =>
    new Date(p.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
  );
  const data = pnlHistory.map(p => p.cumulative);

  chart.data.labels = labels;
  chart.data.datasets[0].data = data;
  chart.data.datasets[1].data = [];

  const lastPnl = data[data.length - 1] || 0;
  const color = lastPnl >= 0 ? '#38ef7d' : '#f87171';
  chart.data.datasets[0].borderColor = color;
  chart.data.datasets[0].backgroundColor = lastPnl >= 0 ? 'rgba(56, 239, 125, 0.08)' : 'rgba(248, 113, 113, 0.08)';

  chart.update('none');
}

function addSpotTick(price, strike = null) {
  if (!price) return;
  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, minute: '2-digit', second: '2-digit' });
  spotHistory.push({ time: timeStr, price, strike });
  if (spotHistory.length > 60) spotHistory.shift();

  if (currentMode === 'btc') {
    renderBtcChart();
  }
}

function renderBtcChart() {
  if (spotHistory.length === 0) return;
  chart.data.labels = spotHistory.map(s => s.time);
  chart.data.datasets[0].data = spotHistory.map(s => s.price);
  chart.data.datasets[1].data = spotHistory.map(s => s.strike);
  chart.update('none');
}

export { updateChart, setChartMode, addSpotTick };