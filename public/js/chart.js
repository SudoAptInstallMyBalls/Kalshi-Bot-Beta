import { el } from './dom.js';
const ctx = document.getElementById('pnl-chart').getContext('2d');
const pnlChart = new Chart(ctx, {
  type: 'line',
  data: {
    labels: [],
    datasets: [{
      label: 'Cumulative P&L',
      data: [],
      borderColor: '#007373',
      backgroundColor: 'rgba(0, 115, 115, 0.08)',
      borderWidth: 2,
      fill: true,
      tension: 0.3,
      pointRadius: 3,
      pointBackgroundColor: '#007373',
      pointBorderColor: 'transparent',
    }],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#ffffff',
        borderColor: '#007373',
        borderWidth: 1,
        titleColor: '#5b5a52',
        bodyColor: '#1c1c1a',
        bodyFont: { family: 'monospace' },
      },
    },
    scales: {
      x: {
        display: true,
        grid: { color: 'rgba(156, 154, 142, 0.35)' },
        ticks: { color: '#5b5a52', font: { size: 9 }, maxTicksLimit: 8 },
      },
      y: {
        display: true,
        grid: { color: 'rgba(156, 154, 142, 0.35)' },
        ticks: {
          color: '#5b5a52',
          font: { size: 10 },
          callback: v => '$' + v.toFixed(2),
        },
      },
    },
  },
});

function updateChart(pnlHistory) {
  if (!pnlHistory || pnlHistory.length === 0) return;

  // Persist to localStorage for page refresh survival
  try {
    localStorage.setItem('kalshibot_pnlHistory', JSON.stringify(pnlHistory.slice(-500)));
  } catch (e) {
    // localStorage might be full or disabled
  }

  const labels = pnlHistory.map(p =>
    new Date(p.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
  );
  const data = pnlHistory.map(p => p.cumulative);

  pnlChart.data.labels = labels;
  pnlChart.data.datasets[0].data = data;

  // Color based on P&L
  const lastPnl = data[data.length - 1] || 0;
  const color = lastPnl >= 0 ? '#1f7a3d' : '#a11d1d';
  const bgColor = lastPnl >= 0 ? 'rgba(31, 122, 61, 0.08)' : 'rgba(161, 29, 29, 0.08)';

  pnlChart.data.datasets[0].borderColor = color;
  pnlChart.data.datasets[0].backgroundColor = bgColor;
  pnlChart.data.datasets[0].pointBackgroundColor = color;

  pnlChart.update('none');

  el('chart-total').textContent = (lastPnl >= 0 ? '+' : '') + '$' + lastPnl.toFixed(2);
}


export { updateChart };
