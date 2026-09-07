import { el, escapeHtml, safeClass, cents, shortTicker, formatTime } from './dom.js';
function updateConnections(conns) {
  const dots = {
    binance: 'dot-binance',
    polymarket: 'dot-polymarket',
    kalshi: 'dot-kalshi',
    redstone: 'dot-redstone',
  };
  for (const [key, dotId] of Object.entries(dots)) {
    const dot = el(dotId);
    if (dot) {
      dot.classList.toggle('active', !!conns[key]);
    }
  }
}

function updateBtcPrice(price) {
  const btcEl = el('btc-price');
  const srcEl = el('btc-source');
  if (!price) return;

  if (price.binance) {
    btcEl.textContent = '$' + Number(price.binance).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    srcEl.textContent = price.redstone
      ? `Binance | RS: $${Number(price.redstone).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : 'Binance Live';
  } else if (price.redstone) {
    btcEl.textContent = '$' + Number(price.redstone).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    srcEl.textContent = 'RedStone Oracle';
  }
}

function updatePnL(stats) {
  const pnlEl = el('total-pnl');
  const pnl = stats.totalPnL || 0;
  pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
  pnlEl.className = 'metric-value ' + (pnl >= 0 ? 'positive' : 'negative');

  el('win-loss').textContent = `${stats.wins || 0}W / ${stats.losses || 0}L`;

  // ROI
  const volume = stats.volumeTraded || 1;
  const roi = (pnl / volume) * 100;
  const roiEl = el('roi-value');
  roiEl.textContent = (roi >= 0 ? '+' : '') + roi.toFixed(1) + '%';
  roiEl.className = 'metric-value ' + (roi >= 0 ? 'positive' : 'negative');

  el('trades-per-hour').textContent = (stats.tradesPerHour || 0).toFixed(1) + ' trades/hr';
}

function updateBalance(bal) {
  if (!bal) return;
  el('balance-value').textContent = '$' + (bal.total || 0).toFixed(2);
  el('balance-available').textContent = '$' + (bal.available || 0).toFixed(2) + ' available';
}

function updateIntent(intent) {
  if (!intent) return;

  el('intent-message').textContent = intent.message || '--';
  el('intent-action').textContent = intent.action || '--';
  el('intent-prob').textContent = intent.modelProbability != null
    ? (intent.modelProbability * 100).toFixed(1) + '%'
    : '--';
  el('intent-edge').textContent = intent.currentEdge != null
    ? intent.currentEdge.toFixed(1) + '%'
    : '--';

  const badge = el('bot-status');
  badge.textContent = (intent.status || 'unknown').toUpperCase().replace(/_/g, ' ');
  badge.className = 'status-badge ' + (intent.status || '');
}

function updateModel(model) {
  if (!model) return;

  el('intent-move').textContent = model.spotMovePct != null
    ? (model.spotMovePct >= 0 ? '+' : '') + model.spotMovePct.toFixed(4) + '%'
    : '--';
  el('intent-vol').textContent = model.volatility != null
    ? (model.volatility * 100).toFixed(3) + '%'
    : '--';
  el('intent-time').textContent = model.timeRemaining != null
    ? Math.floor(model.timeRemaining) + 's'
    : '--';

  // Color the move
  const moveEl = el('intent-move');
  if (model.spotMovePct > 0) moveEl.classList.add('positive');
  else if (model.spotMovePct < 0) moveEl.classList.add('negative');

  // 1H Trend indicator
  const trendEl = el('intent-trend');
  if (trendEl) {
    if (!model.trendWarmup) {
      trendEl.textContent = 'WARMING UP';
      trendEl.className = 'detail-value trend-warmup';
    } else {
      const arrow = model.trend === 'BULLISH' ? '\u2191' : model.trend === 'BEARISH' ? '\u2193' : '\u2194';
      const rocStr = model.trendROC != null ? ' (' + (model.trendROC >= 0 ? '+' : '') + model.trendROC.toFixed(3) + '%)' : '';
      trendEl.textContent = arrow + ' ' + model.trend + rocStr;
      trendEl.className = 'detail-value trend-' + model.trend.toLowerCase();
    }
  }
}

function updatePositions(positions) {
  const list = el('positions-list');
  el('pos-count').textContent = positions.length;
  el('stat-open').textContent = positions.length;

  if (positions.length === 0) {
    list.innerHTML = '<div class="empty-state">No open positions</div>';
    return;
  }

  list.innerHTML = positions.map(p => `
    <div class="position-card">
      <span class="pos-ticker" title="${escapeHtml(p.ticker)}">${escapeHtml(String(p.ticker || '').split('-').slice(-2).join('-'))}</span>
      <span class="pos-side ${safeClass(p.side, 'unknown')}">${escapeHtml(String(p.side || '').toUpperCase())}</span>
      <span class="pos-info">x${escapeHtml(p.filledContracts ?? p.contracts ?? 0)} @ ${escapeHtml(p.priceCents ?? 0)}¢</span>
      <span class="pos-info">$${(p.totalCost || 0).toFixed(2)}</span>
      <span class="pos-edge">${p.edge ? p.edge.toFixed(1) + '%' : '--'}</span>
      <span class="pos-info">${escapeHtml(p.type || '')}</span>
    </div>
  `).join('');
}

function updateMarkets(markets) {
  const body = el('markets-body');
  el('market-count').textContent = markets.length;

  if (markets.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty-state">No active markets</td></tr>';
    return;
  }

  body.innerHTML = markets.map(m => {
    const combined = (m.yesAsk || 0) + (m.noAsk || 0);
    const combinedClass = combined < 0.98 ? 'combined-good' : 'combined-bad';
    const timeStr = m.secondsUntilClose != null
      ? formatTime(m.secondsUntilClose)
      : (m.minutesUntilClose || '?') + 'm';

    return `
      <tr>
        <td style="color: var(--accent)">${escapeHtml(String(m.ticker || '').split('-').slice(-2).join('-'))}</td>
        <td>${cents(m.yesBid)} / ${cents(m.yesAsk)}</td>
        <td>${cents(m.noBid)} / ${cents(m.noAsk)}</td>
        <td class="${combinedClass}">${(combined * 100).toFixed(0)}¢</td>
        <td>${escapeHtml(timeStr)}</td>
        <td style="color: var(--green)">${escapeHtml(m.status || 'open')}</td>
      </tr>
    `;
  }).join('');
}

function updateTradeLog(log) {
  const logEl = el('trade-log');
  el('log-count').textContent = log.length;

  if (log.length === 0) {
    logEl.innerHTML = '<div class="empty-state">No trades yet</div>';
    return;
  }

  // Show only last 30 entries for performance
  const recent = log.slice(0, 30);

  logEl.innerHTML = recent.map(entry => {
    const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
    let typeClass = entry.type || 'LOG';
    let msg = '';

    if (entry.type === 'TRADE') {
      typeClass = entry.action || 'BUY';
      msg = `${entry.side?.toUpperCase() || ''} ${shortTicker(entry.ticker)} x${entry.contracts || 0} @ ${entry.price || 0}¢`;
      if (entry.pnl != null) msg += ` | P&L: ${entry.pnl >= 0 ? '+' : ''}$${entry.pnl.toFixed(2)}`;
      if (entry.edge) msg += ` | Edge: ${entry.edge.toFixed(1)}%`;
    } else if (entry.type === 'SETTLEMENT') {
      typeClass = entry.action || 'WIN';
      msg = `${shortTicker(entry.ticker)} ${entry.side?.toUpperCase()} x${entry.contracts} | P&L: ${entry.pnl >= 0 ? '+' : ''}$${entry.pnl.toFixed(2)}`;
    } else {
      msg = entry.message || '';
    }

    return `
      <div class="log-entry">
        <span class="log-time">${time}</span>
        <span class="log-type ${safeClass(typeClass, 'LOG')}">${escapeHtml(typeClass)}</span>
        <span class="log-msg">${escapeHtml(msg)}</span>
      </div>
    `;
  }).join('');
}

function updateStats(stats) {
  el('stat-trades').textContent = stats.totalTrades || 0;

  const total = (stats.wins || 0) + (stats.losses || 0);
  const winRate = total > 0 ? ((stats.wins / total) * 100).toFixed(1) : '0';
  el('stat-winrate').textContent = winRate + '%';

  el('stat-avgedge').textContent = (stats.avgEdge || 0).toFixed(1) + '%';

  const bestEl = el('stat-best');
  bestEl.textContent = '+$' + (stats.bestTrade || 0).toFixed(2);
  bestEl.className = 'stat-value positive';

  const worstEl = el('stat-worst');
  worstEl.textContent = (stats.worstTrade < 0 ? '-' : '') + '$' + Math.abs(stats.worstTrade || 0).toFixed(2);
  worstEl.className = 'stat-value ' + (stats.worstTrade < 0 ? 'negative' : 'neutral');

  el('stat-volume').textContent = '$' + (stats.volumeTraded || 0).toFixed(2);
  el('stat-tph').textContent = (stats.tradesPerHour || 0).toFixed(1);

  // Profit factor
  const pfEl = el('stat-profitfactor');
  if (pfEl) {
    const pf = (stats.grossLosses || 0) > 0
      ? (stats.grossWins / stats.grossLosses)
      : (stats.grossWins > 0 ? Infinity : 0);
    pfEl.textContent = pf === Infinity ? 'INF' : pf.toFixed(2);
    pfEl.className = 'stat-value ' + (pf >= 1 ? 'positive' : 'negative');
  }

  // Avg win / avg loss
  const avgWinEl = el('stat-avgwin');
  if (avgWinEl) {
    const avgWin = (stats.wins || 0) > 0 ? (stats.grossWins || 0) / stats.wins : 0;
    avgWinEl.textContent = '+$' + avgWin.toFixed(2);
  }
  const avgLossEl = el('stat-avgloss');
  if (avgLossEl) {
    const avgLoss = (stats.losses || 0) > 0 ? (stats.grossLosses || 0) / stats.losses : 0;
    avgLossEl.textContent = '-$' + avgLoss.toFixed(2);
  }

  // Streak
  const streakEl = el('stat-streak');
  if (streakEl) {
    const streak = stats.streak || 0;
    streakEl.textContent = (streak > 0 ? '+' : '') + streak;
    streakEl.className = 'stat-value ' + (streak > 0 ? 'positive' : streak < 0 ? 'negative' : 'neutral');
  }

  // Unrealized P&L
  const unrealizedEl = el('stat-unrealized');
  if (unrealizedEl) {
    const uPnl = stats.unrealizedPnL || 0;
    unrealizedEl.textContent = (uPnl >= 0 ? '+' : '') + '$' + uPnl.toFixed(2);
    unrealizedEl.className = 'stat-value ' + (uPnl >= 0 ? 'positive' : 'negative');
  }

  // Strategy breakdown
  const stratEl = el('stat-strategy');
  if (stratEl && stats.strategyStats) {
    const parts = Object.entries(stats.strategyStats).map(([k, v]) => {
      const short = k.replace('DIRECTIONAL', 'DIR').replace('POLY_ARB', 'POLY').replace('DUAL_SIDE', 'DUAL');
      return `${short}: ${v.wins}W/${v.losses}L`;
    });
    stratEl.textContent = parts.length > 0 ? parts.join(' | ') : '--';
  }
}


export { updateConnections, updateBtcPrice, updatePnL, updateBalance, updateIntent, updateModel, updatePositions, updateMarkets, updateTradeLog, updateStats };
