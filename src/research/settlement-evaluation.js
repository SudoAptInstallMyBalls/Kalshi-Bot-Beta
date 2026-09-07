const ProbabilityModel = require('../agents/skills/analysis/probability-model');
const { minuteVolatility } = require('../strategy/volatility');
const { ProxyReference } = require('./proxy-reference');
const OFFSETS = [1, 2, 3, 4, 8, 12, 13, 14];

function score(rows, key) {
  const eligible = rows.filter(r => Number.isFinite(r[key]));
  const mean = f => eligible.length ? eligible.reduce((sum, r) => sum + f(r), 0) / eligible.length : null;
  return { forecasts: eligible.length, markets: new Set(eligible.map(r => r.ticker)).size,
    brier: mean(r => (r[key] - r.y) ** 2),
    logLoss: mean(r => { const p = Math.max(1e-9, Math.min(1 - 1e-9, r[key])); return -r.y * Math.log(p) - (1 - r.y) * Math.log(1 - p); }),
    meanProbability: mean(r => r[key]), hitRate: mean(r => r.y),
    calibration: Array.from({ length: 10 }, (_, i) => {
      const group = eligible.filter(r => Math.min(9, Math.floor(r[key] * 10)) === i);
      return { from: i / 10, to: (i + 1) / 10, count: group.length,
        probability: group.length ? group.reduce((s, r) => s + r[key], 0) / group.length : null,
        outcome: group.length ? group.reduce((s, r) => s + r.y, 0) / group.length : null };
    }) };
}
function comparison(rows, keys) {
  const common = rows.filter(r => keys.every(key => Number.isFinite(r[key])));
  return { commonForecasts: common.length, commonMarkets: new Set(common.map(r => r.ticker)).size,
    models: Object.fromEntries(keys.map(key => [key, score(common, key)])) };
}

// Forecasts do not depend on positions, fills, balance, exits, or the account risk latch.
function evaluateForecasts(history, spot, { indexReference, forwardAfter = null } = {}) {
  if (forwardAfter !== null && !Number.isFinite(forwardAfter)) throw Error('Invalid forward cutoff');
  const markets = history.prepare("SELECT * FROM markets WHERE result IN ('yes','no') ORDER BY open_time,ticker").all();
  const proxy = new ProxyReference(markets, spot), model = new ProbabilityModel();
  const indices = new Map(spot.map((r, i) => [r.available_ms, i]));
  const candles = history.prepare('SELECT * FROM candles WHERE ticker=? AND period_minutes=1 ORDER BY end_period_ts');
  const rows = [], skipped = {}, indexUnavailable = {};
  const reject = reason => { skipped[reason] = (skipped[reason] || 0) + 1; };
  for (const [marketIndex, m] of markets.entries()) {
    const openTime = Date.parse(m.open_time), closeTime = Date.parse(m.close_time);
    let raw; try { raw = JSON.parse(m.raw_json); } catch { reject('invalid_metadata'); continue; }
    if (!m.ticker.startsWith('KXBTC15M-') || raw.strike_type !== 'greater_or_equal' || closeTime - openTime !== 900000 ||
        !Number.isFinite(m.floor_strike) || m.floor_strike <= 0) { reject('unsupported_market'); continue; }
    const qs = new Map(candles.all(m.ticker).map(c => [c.end_period_ts * 1000, c]));
    for (const minute of OFFSETS) {
      const ts = openTime + minute * 60000, index = indices.get(ts), current = spot[index], opening = spot[indices.get(openTime)], q = qs.get(ts);
      if (!current || !opening) { reject('missing_spot'); continue; }
      if (!q || ![q.yes_bid_close, q.yes_ask_close].every(p => Number.isFinite(p) && p > 0 && p < 1) || q.yes_bid_close > q.yes_ask_close) {
        reject('missing_or_invalid_quote'); continue;
      }
      const sigma = minuteVolatility(spot.slice(Math.max(0, index - 15), index + 1), 900);
      if (sigma === null) { reject('volatility_warmup'); continue; }
      const feed = { getRecentVolatility: () => sigma }, market = { ticker: m.ticker, openTime, closeTime, strikeSource: 'kalshi', strikeType: raw.strike_type };
      const baseline = model.calculateImpliedProbability(current.close, m.floor_strike, closeTime - ts, 900000, feed);
      const terminal = model.calculateImpliedProbability(current.close, opening.close, closeTime - ts, 900000, feed);
      const average = proxy.getForecast(market, m.floor_strike, ts, { requireCalibration: false });
      const indexForecast = indexReference?.getForecast(market, m.floor_strike, ts);
      if (indexForecast && !indexForecast.ready) indexUnavailable[indexForecast.reason] = (indexUnavailable[indexForecast.reason] || 0) + 1;
      rows.push({ ticker: m.ticker, ts, closeTime, minute, y: Number(m.result === 'yes'),
        openTime,
        block: marketIndex < Math.floor(markets.length * .6) ? 'train' : marketIndex < Math.floor(markets.length * .8) ? 'validation' : 'test',
        rawTerminal: baseline.probUp, proxyTerminal: terminal.probUp, proxyAverage: average.ready ? average.probUp : null,
        marketMidpoint: (q.yes_bid_close + q.yes_ask_close) / 2,
        officialIndexAverage: indexForecast?.ready ? indexForecast.probUp : null,
        lowerProbUp: average.ready && average.calibration.ready ? average.lowerProbUp : null,
        upperProbUp: average.ready && average.calibration.ready ? average.upperProbUp : null,
        basisErrorBps: average.calibration?.errorBps ?? null,
        calibrationSamples: average.calibration?.samples ?? 0,
        latestCalibrationAvailableMs: average.calibration?.latestOutcomeAvailableMs ?? null,
        proxyUnavailable: average.ready ? null : average.reason });
    }
  }
  const keys = ['rawTerminal', 'proxyTerminal', 'proxyAverage', 'marketMidpoint'];
  return { rows, markets: markets.length, eligibleForecasts: rows.length, skipped,
    offsetsMinutes: OFFSETS, calibrationSettings: proxy.settings, skippedCalibrationMarkets: proxy.skippedCalibrationMarkets,
    all: comparison(rows, keys), byBlock: Object.fromEntries(['train', 'validation', 'test'].map(block => [block, comparison(rows.filter(r => r.block === block), keys)])),
    byMinute: Object.fromEntries(OFFSETS.map(minute => [minute, comparison(rows.filter(r => r.minute === minute), keys)])),
    terminalIncludingFinalMinute: comparison(rows, ['rawTerminal', 'proxyTerminal', 'marketMidpoint']),
    officialIndex: { configured: Boolean(indexReference), unavailable: indexUnavailable,
      comparison: comparison(rows, ['rawTerminal', 'proxyTerminal', 'officialIndexAverage', 'marketMidpoint']) },
    forward: forwardAfter === null ? null : { after: new Date(forwardAfter).toISOString(),
      comparison: comparison(rows.filter(r => r.openTime >= forwardAfter), keys) },
    freshDataAfter: markets.at(-1)?.close_time ?? null };
}
module.exports = { evaluateForecasts, score, comparison, OFFSETS };
