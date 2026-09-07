// Shared live/replay estimator: 15 completed one-minute log returns, scaled to the requested horizon.
function minuteVolatility(rows, horizonSeconds = 900, returnCount = 15) {
  if (!Number.isFinite(horizonSeconds) || horizonSeconds <= 0) return null;
  const window = rows.slice(-(returnCount + 1));
  if (window.length !== returnCount + 1 || window.some((r, i) =>
    !Number.isFinite(r.close) || r.close <= 0 || !Number.isSafeInteger(r.available_ms) ||
    (i && r.available_ms - window[i - 1].available_ms !== 60000))) return null;
  const returns = window.slice(1).map((r, i) => Math.log(r.close / window[i].close));
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  // Same floor at the same reference horizon for every caller.
  return Math.max(.0001, Math.sqrt(variance * 15)) * Math.sqrt(horizonSeconds / 900);
}

function completedMinutes(ticks, now, maxAgeMs = 5000) {
  const end = Math.floor(now / 60000) * 60000, byMinute = new Map();
  for (const tick of ticks) {
    if (!Number.isSafeInteger(tick.timestamp) || !Number.isFinite(tick.price) || tick.price <= 0 ||
        tick.timestamp >= end || (tick.received_ms ?? tick.timestamp) > now) continue;
    const available = Math.floor(tick.timestamp / 60000) * 60000 + 60000;
    if (available - tick.timestamp > maxAgeMs) continue;
    if (!byMinute.has(available) || tick.timestamp > byMinute.get(available).timestamp) byMinute.set(available, tick);
  }
  const rows = [...byMinute].sort((a, b) => a[0] - b[0]).map(([available_ms, tick]) => ({ available_ms, close: tick.price }));
  // Never return a volatility estimate from an old disconnected feed.
  return rows.at(-1)?.available_ms === end ? rows : [];
}
module.exports = { minuteVolatility, completedMinutes };
