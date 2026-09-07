const { minuteVolatility, completedMinutes } = require('../strategy/volatility');
const { averageForecast } = require('../strategy/settlement-forecast');
const { comparison } = require('./settlement-evaluation');
const { settlementNumber } = require('../strategy/settlement-number');
function latest(rows, now) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].received_ms <= now) lo = mid + 1; else hi = mid; }
  return lo - 1;
}
function evaluateCoinbaseShadow(history, db, baselineRows, cutoff) {
  const ticks = db.prepare('SELECT * FROM proxy_ticks ORDER BY received_ms').all();
  if (ticks.some(r => r.source !== 'coinbase:BTC-USD:ticker')) throw Error('Mixed Coinbase proxy sources');
  const markets = new Map(history.prepare('SELECT * FROM markets').all().map(m => [m.ticker, m]));
  const rows = [], missing = {};
  const skip = why => { missing[why] = (missing[why] || 0) + 1; };
  for (const row of baselineRows.filter(r => r.openTime >= cutoff)) {
    if (row.ts >= row.closeTime - 60000) { skip('settlement_window_unobserved'); continue; }
    const index = latest(ticks, row.ts), openingIndex = latest(ticks, row.openTime);
    const current = ticks[index], opening = ticks[openingIndex];
    if (!current || !opening || row.ts - current.event_ms > 5000 || row.openTime - opening.event_ms > 5000) { skip('missing_or_stale_coinbase'); continue; }
    const start = latest(ticks, row.ts - 20 * 60000);
    const prices = ticks.slice(Math.max(0, start), index + 1).map(r => ({ timestamp: r.received_ms, received_ms: r.received_ms, price: r.price }));
    const sigma = minuteVolatility(completedMinutes(prices, row.ts), 900), strike = markets.get(row.ticker).floor_strike;
    if (sigma === null) { skip('coinbase_volatility_gap'); continue; }
    const common = { now: row.ts, closeTime: row.closeTime, strike, sigma };
    const usd = averageForecast({ ...common, currentPrice: current.price });
    const adjusted = averageForecast({ ...common, currentPrice: strike * current.price / opening.price });
    if (!usd.ready || !adjusted.ready) { skip('forecast_unavailable'); continue; }
    rows.push({ ...row, coinbaseUsdAverage: usd.probUp, coinbaseOpeningAverage: adjusted.probUp });
  }
  const settlement = [];
  for (const m of markets.values()) {
    const close = Date.parse(m.close_time), official = settlementNumber(m.expiration_value);
    if (Date.parse(m.open_time) < cutoff || official === null || !(m.floor_strike > 0)) continue;
    const samples = [];
    for (let i = 0; i < 60; i++) {
      const t = close - 60000 + i * 1000, tick = ticks[latest(ticks, t)];
      if (!tick || t - tick.event_ms > 5000) break;
      samples.push(tick.price);
    }
    if (samples.length !== 60) continue;
    const average = samples.reduce((a, b) => a + b, 0) / 60;
    settlement.push({ ticker: m.ticker, coinbaseAverage: average, official, errorBps: (average - official) / m.floor_strike * 10000 });
  }
  return { source: 'coinbase:BTC-USD:ticker', shadowOnly: true, ticks: ticks.length,
    firstReceipt: ticks[0]?.received_ms ?? null, lastReceipt: ticks.at(-1)?.received_ms ?? null,
    comparison: comparison(rows, ['rawTerminal', 'proxyAverage', 'marketMidpoint', 'coinbaseUsdAverage', 'coinbaseOpeningAverage']),
    missing, rows, settlements: settlement,
    limitation: 'Observed first ticker per receipt second; 1-second as-of sampling with maximum 5-second event age. No BRTI equivalence or order submission. Coinbase variants are newly declared and have no pre-collection history.' };
}
module.exports = { evaluateCoinbaseShadow, latest };
