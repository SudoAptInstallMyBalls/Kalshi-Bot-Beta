import { el, escapeHtml, safeClass, cents, shortTicker, formatTime } from './dom.js';

function updateConnections(conns = {}) {
  const dots = {
    coinbase: 'dot-coinbase',
    binance: 'dot-binance',
    kalshi: 'dot-kalshi',
    polymarket: 'dot-polymarket',
    redstone: 'dot-redstone',
  };

  const btcText = el('btc-price')?.textContent;
  const isCoinbaseLive = Boolean(conns.coinbase || (btcText && btcText !== '--'));

  for (const [key, dotId] of Object.entries(dots)) {
    const dot = el(dotId);
    if (!dot) continue;
    if (key === 'coinbase') {
      dot.classList.toggle('active', isCoinbaseLive);
    } else {
      dot.classList.toggle('active', !!conns[key]);
    }
  }
}

function updateBtcPrice(price) {
  const btcEl = el('btc-price');
  const srcEl = el('btc-source');
  const basisEl = el('watchdog-basis');
  if (!price) return;

  const cbPrice = price.coinbase ?? price.price ?? price.binance;
  const binPrice = price.binance;

  if (cbPrice) {
    btcEl.textContent = '$' + Number(cbPrice).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    const bid = price.coinbaseBid || price.binanceBid || cbPrice;
    const ask = price.coinbaseAsk || price.binanceAsk || cbPrice;
    srcEl.textContent = 'Bid: $' + Number(bid).toFixed(1) + ' | Ask: $' + Number(ask).toFixed(1);
    el('dot-coinbase')?.classList.add('active');
  }

  if (cbPrice && binPrice && basisEl) {
    const diff = cbPrice - binPrice;
    const bps = (diff / cbPrice) * 10000;
    basisEl.textContent = (bps >= 0 ? '+' : '') + bps.toFixed(1) + ' BPS ($' + (diff >= 0 ? '+' : '') + diff.toFixed(1) + ')';
    basisEl.className = 'watchdog-value ' + (Math.abs(bps) > 10 ? 'warning' : 'positive');
  }
}

function updateWatchdog(data) {
  const ramEl = el('watchdog-ram');
  if (ramEl && data?.ramMb != null) {
    const isHigh = data.ramMb > 400;
    ramEl.textContent = data.ramMb + ' MB (' + (isHigh ? 'ELEVATED' : 'STABLE') + ')';
    ramEl.className = 'watchdog-value ' + (isHigh ? 'warning' : 'positive');
  }

  const pendEl = el('watchdog-pending');
  const pendingCount = data?.pendingOrders ? Object.keys(data.pendingOrders).length : 0;
  if (pendEl) {
    pendEl.textContent = pendingCount + ' PENDING (' + (pendingCount > 0 ? 'ALERT' : 'CLEAN') + ')';
    pendEl.className = 'watchdog-value ' + (pendingCount > 0 ? 'alert' : 'positive');
  }

  const failEl = el('watchdog-failures');
  if (failEl) {
    const failures = data?.consecutiveFailures ?? 0;
    failEl.textContent = failures + ' / 5 (' + (failures >= 4 ? 'CRITICAL' : 'SAFE') + ')';
    failEl.className = 'watchdog-value ' + (failures > 0 ? 'warning' : 'positive');
  }

  const dbEl = el('watchdog-db');
  if (dbEl) {
    const samples = data?.indexSamples ?? 0;
    const isCalibrated = samples >= 120;
    dbEl.textContent = samples + ' SAMPLES (' + (isCalibrated ? 'CALIBRATED' : 'WARMING UP') + ')';
    dbEl.className = 'watchdog-value ' + (isCalibrated ? 'positive' : 'warning');
  }
}

function updatePnL(stats) {
  const pnlEl = el('total-pnl');
  const pnl = stats.totalPnL || 0;
  pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
  pnlEl.className = 'metric-value ' + (pnl >= 0 ? 'positive' : 'negative');

  el('win-loss').textContent = (stats.wins || 0) + 'W / ' + (stats.losses || 0) + 'L (' + (stats.winRate || 0).toFixed(1) + '%)';

  const volume = stats.volumeTraded || 1;
  const roi = (pnl / volume) * 100;
  const roiEl = el('roi-value');
  roiEl.textContent = (roi >= 0 ? '+' : '') + roi.toFixed(1) + '%';
  roiEl.className = 'metric-value ' + (roi >= 0 ? 'positive' : 'negative');

  el('trades-per-hour').textContent = (stats.tradesPerHour || 0).toFixed(1) + ' trades/hr';
}

function updateBalance(bal) {
  if (bal == null) return;
  const total = typeof bal === 'number' ? bal : (bal.total ?? bal.balance ?? bal.cash ?? bal.portfolioBalance ?? 0);
  const available = typeof bal === 'number' ? bal : (bal.available ?? bal.available_balance ?? bal.availableBalance ?? total);
  const totalDollars = (total > 500 && Number.isInteger(total)) ? total / 100 : total;
  const availDollars = (available > 500 && Number.isInteger(available)) ? available / 100 : available;
  el('balance-value').textContent = '$' + Number(totalDollars).toFixed(2);
  el('balance-available').textContent = '$' + Number(availDollars).toFixed(2) + ' available';
}

function updateIntent(intent) {
  if (!intent) return;

  el('intent-action').textContent = intent.action || '--';
  el('intent-prob').textContent = intent.modelProbability != null
    ? (intent.modelProbability * 100).toFixed(1) + '%'
    : '--';
  el('intent-edge').textContent = intent.currentEdge != null
    ? (intent.currentEdge >= 0 ? '+' : '') + intent.currentEdge.toFixed(1) + '%'
    : '--';

  const badge = el('bot-status');
  badge.textContent = (intent.status || 'unknown').toUpperCase().replace(/_/g, ' ');
  badge.className = 'status-badge ' + (intent.status || '');
}

function updateModel(model) {
  if (!model) return;

  el('intent-move').textContent = model.spotMovePct != null
    ? (model.spotMovePct >= 0 ? '+' : '') + model.spotMovePct.toFixed(3) + '%'
    : '--';
  el('intent-vol').textContent = model.volatility != null
    ? (model.volatility * 100).toFixed(3) + '%'
    : '--';
  el('intent-time').textContent = model.timeRemaining != null
    ? Math.floor(model.timeRemaining) + 's'
    : '--';

  const trendEl = el('intent-trend');
  if (trendEl) {
    if (!model.trendWarmup) {
      trendEl.textContent = 'WARMING UP';
      trendEl.className = 'detail-value warning';
    } else {
      const arrow = model.trend === 'BULLISH' ? '↑' : model.trend === 'BEARISH' ? '↓' : '↔';
      trendEl.textContent = arrow + ' ' + model.trend;
      trendEl.className = 'detail-value ' + (model.trend === 'BULLISH' ? 'positive' : 'negative');
    }
  }
}

function updatePositions(positions) {
  const list = el('positions-list');
  el('pos-count').textContent = positions.length;

  if (positions.length === 0) {
    list.innerHTML = '<div style="text-align: center; padding: 16px; color: var(--text-muted);">No open positions</div>';
    return;
  }

  list.innerHTML = positions.map(p => [
    '<div style="display:flex; justify-content:space-between; padding: 4px 6px; border-bottom: 1px solid var(--border-subtle); font-size: 10px;">',
    '  <span class="mono" style="font-weight:700;">' + escapeHtml(shortTicker(p.ticker)) + '</span>',
    '  <span class="' + safeClass(p.side) + '">' + escapeHtml(String(p.side).toUpperCase()) + '</span>',
    '  <span>' + escapeHtml(p.filledContracts ?? p.contracts ?? 0) + 'x @ ' + escapeHtml(p.priceCents ?? 0) + '¢</span>',
    '  <span class="mono">' + (p.edge ? p.edge.toFixed(1) + '%' : '--') + '</span>',
    '</div>'
  ].join('')).join('');
}

function updateMarkets(markets, currentSpotPrice) {
  const body = el('markets-body');
  el('market-count').textContent = markets.length + ' MARKETS';

  if (markets.length === 0) {
    body.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:16px;">No active 15-minute markets</td></tr>';
    return;
  }

  body.innerHTML = markets.map(m => {
    const combined = (m.yesAsk || 0) + (m.noAsk || 0);
    const strike = m.floorStrike || m.strikePrice || null;
    let distStr = '--';
    let distClass = '';

    if (strike && currentSpotPrice) {
      const diff = currentSpotPrice - strike;
      const bps = (diff / strike) * 10000;
      distStr = (diff >= 0 ? '+' : '') + '$' + diff.toFixed(1) + ' (' + (bps >= 0 ? '+' : '') + bps.toFixed(0) + 'bps)';
      distClass = diff >= 0 ? 'positive' : 'negative';
    }

    const timeStr = m.secondsUntilClose != null
      ? formatTime(m.secondsUntilClose)
      : (m.minutesUntilClose || '?') + 'm';

    const edge = m.edge ?? m.modelEdge ?? null;
    const edgeClass = edge && edge >= 5 ? 'positive' : '';

    return [
      '<tr>',
      '  <td style="color: var(--teal); font-weight:700;">' + escapeHtml(shortTicker(m.ticker)) + '</td>',
      '  <td class="mono" style="font-weight:700;">' + (strike ? '$' + Number(strike).toLocaleString() : '--') + '</td>',
      '  <td class="mono ' + distClass + '">' + distStr + '</td>',
      '  <td>' + cents(m.yesBid) + ' / ' + cents(m.yesAsk) + '</td>',
      '  <td>' + cents(m.noBid) + ' / ' + cents(m.noAsk) + '</td>',
      '  <td class="' + (combined < 0.98 ? 'positive' : '') + '">' + (combined * 100).toFixed(0) + '¢</td>',
      '  <td>' + escapeHtml(timeStr) + '</td>',
      '  <td>' + (m.modelProb ? (m.modelProb * 100).toFixed(1) + '%' : '--') + '</td>',
      '  <td class="mono ' + edgeClass + '">' + (edge ? (edge >= 0 ? '+' : '') + edge.toFixed(1) + '%' : '--') + '</td>',
      '  <td style="color: var(--green);">' + escapeHtml(m.status || 'open') + '</td>',
      '</tr>'
    ].join('');
  }).join('');
}

function updateTradeLog(log) {
  const logEl = el('trade-log');
  el('log-count').textContent = log.length;

  if (log.length === 0) {
    logEl.innerHTML = '<div style="text-align: center; padding: 16px; color: var(--text-muted);">No trades yet</div>';
    return;
  }

  logEl.innerHTML = log.slice(0, 25).map(entry => {
    const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const pnl = entry.pnl != null ? (entry.pnl >= 0 ? '+' : '') + '$' + Number(entry.pnl).toFixed(2) : '';
    const pnlClass = entry.pnl >= 0 ? 'positive' : 'negative';
    const msg = entry.message || (shortTicker(entry.ticker) + ' ' + (entry.side || '') + ' x' + (entry.contracts || 0));

    return [
      '<div class="log-entry">',
      '  <span class="mono" style="color: var(--text-muted);">' + time + '</span>',
      '  <span class="status-badge ' + safeClass(entry.type || 'LOG') + '">' + escapeHtml(entry.type || 'LOG') + '</span>',
      '  <span style="flex:1;">' + escapeHtml(msg) + '</span>',
      '  <span class="mono ' + pnlClass + '">' + pnl + '</span>',
      '</div>'
    ].join('');
  }).join('');
}

function updateStats(stats) {
  el('stat-winrate').textContent = (stats.winRate || 0).toFixed(1) + '% WIN';
  el('stat-profitfactor').textContent = stats.profitFactor != null ? stats.profitFactor.toFixed(2) : '--';
  el('stat-avgwin').textContent = '+$' + (stats.avgWin || 0).toFixed(2) + ' / -$' + Math.abs(stats.avgLoss || 0).toFixed(2);
  el('stat-volume').textContent = '$' + (stats.volumeTraded || 0).toFixed(2);
  el('stat-tph').textContent = (stats.tradesPerHour || 0).toFixed(1);
  el('stat-unrealized').textContent = ((stats.unrealizedPnL || 0) >= 0 ? '+' : '') + '$' + (stats.unrealizedPnL || 0).toFixed(2);
}

export {
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
  updateStats,
};
