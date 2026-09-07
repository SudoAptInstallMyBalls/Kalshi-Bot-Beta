const { minuteVolatility } = require('../strategy/volatility');
const { averageForecast } = require('../strategy/settlement-forecast');
const { settlementNumber } = require('../strategy/settlement-number');

// Research only. A point-in-time opening-return proxy; no fitted global correction or live promotion.
class ProxyReference {
  constructor(markets, spot, { minimumSamples = 100, windowSamples = 256, maxAgeMs = 7 * 86400000, quantile = .95 } = {}) {
    if (!Number.isInteger(minimumSamples) || minimumSamples < 1 || !Number.isInteger(windowSamples) ||
        windowSamples < minimumSamples || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || !(quantile > 0 && quantile <= 1)) throw Error('Invalid basis calibration settings');
    this.settings = { minimumSamples, windowSamples, maxAgeMs, quantile };
    this.spot = spot;
    this.indices = new Map(spot.map((r, i) => [r.available_ms, i]));
    if (this.indices.size !== spot.length || spot.some((r, i) => !Number.isSafeInteger(r.available_ms) ||
        !Number.isFinite(r.close) || r.close <= 0 || (i && r.available_ms <= spot[i - 1].available_ms))) throw Error('Invalid spot series');
    this.residuals = [];
    this.skippedCalibrationMarkets = 0;
    for (const m of markets) {
      let raw; try { raw = JSON.parse(m.raw_json); } catch { this.skippedCalibrationMarkets++; continue; }
      const open = Date.parse(m.open_time), close = Date.parse(m.close_time), available = Date.parse(raw.settlement_ts);
      const a = spot[this.indices.get(open)], b = spot[this.indices.get(close)], official = settlementNumber(m.expiration_value);
      if (!m.ticker.startsWith('KXBTC15M-') || raw.strike_type !== 'greater_or_equal' || close - open !== 900000 ||
          !Number.isFinite(available) || available < close || !a || !b || official === null ||
          !Number.isFinite(m.floor_strike) || m.floor_strike <= 0 || !['yes', 'no'].includes(m.result)) {
        this.skippedCalibrationMarkets++; continue;
      }
      this.residuals.push({ ticker: m.ticker, available_ms: available,
        errorBps: Math.abs(official - m.floor_strike * b.close / a.close) / m.floor_strike * 10000 });
    }
    this.residuals.sort((a, b) => a.available_ms - b.available_ms || a.ticker.localeCompare(b.ticker));
  }
  uncertainty(now, ticker) {
    const { minimumSamples, windowSamples, maxAgeMs, quantile } = this.settings;
    const rows = this.residuals.filter(r => r.ticker !== ticker && r.available_ms <= now && r.available_ms >= now - maxAgeMs).slice(-windowSamples);
    const errors = rows.map(r => r.errorBps).sort((a, b) => a - b);
    return { ready: rows.length >= minimumSamples, samples: rows.length,
      errorBps: rows.length >= minimumSamples ? errors[Math.ceil(errors.length * quantile) - 1] : null,
      latestOutcomeAvailableMs: rows.at(-1)?.available_ms ?? null };
  }
  getForecast(market, strike, now, { requireCalibration = true } = {}) {
    if (now >= market.closeTime - 60000) return { ready: false, reason: 'proxy_cannot_observe_settlement_window' };
    const opening = this.spot[this.indices.get(market.openTime)], index = this.indices.get(now), current = this.spot[index];
    if (!opening || !current || now < market.openTime || market.closeTime - market.openTime !== 900000) return { ready: false, reason: 'proxy_reference_missing' };
    const sigma = minuteVolatility(this.spot.slice(Math.max(0, index - 15), index + 1), 900);
    if (sigma === null) return { ready: false, reason: 'volatility_unavailable' };
    const calibration = this.uncertainty(now, market.ticker);
    if (requireCalibration && !calibration.ready) return { ready: false, reason: 'basis_calibration_warmup', calibration };
    const referencePrice = strike * current.close / opening.close;
    return { ...averageForecast({ now, closeTime: market.closeTime, strike, currentPrice: referencePrice,
      sigma, errorBps: calibration.errorBps ?? 0 }), referencePrice, referenceSource: 'binance_opening_return_proxy',
      referenceTimestamp: now, calibration, researchOnly: true };
  }
}
module.exports = { ProxyReference };
