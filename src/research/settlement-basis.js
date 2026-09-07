// Offline diagnostics. Official expiration values must never become forecast inputs.
const crypto = require('crypto');
const { asOf } = require('./history-replay');
const { normalizeKline } = require('./research-data');
const LIMITS = [5, 10, 20, 50, 100, Infinity];
const { settlementNumber } = require('../strategy/settlement-number');
function stats(values) {
  const a = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!a.length) return { count: 0, min: null, median: null, mean: null, p95: null, max: null };
  return { count: a.length, min: a[0], median: (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2,
    mean: a.reduce((s, n) => s + n, 0) / a.length, p95: a[Math.ceil(a.length * .95) - 1], max: a.at(-1) };
}
function counts(rows) {
  const disagree = rows.filter(r => r.disagree).length;
  return { total: rows.length, agree: rows.length - disagree, disagree, disagreementRate: rows.length ? disagree / rows.length : null };
}
function hash(rows) { return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }
function analyzeSettlementBasis(markets, spot, { maxAgeMs = 120000 } = {}) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw Error('Invalid maximum spot age');
  for (let i = 0; i < spot.length; i++) {
    const p = spot[i];
    if (p.source !== 'binance:BTCUSDT:1m' || !Number.isSafeInteger(p.available_ms) ||
        !Number.isFinite(p.close) || p.close <= 0 || (i && p.available_ms <= spot[i - 1].available_ms)) {
      throw Error(`Invalid or mixed spot series at row ${i}`);
    }
    const raw = normalizeKline(JSON.parse(p.raw_json));
    if (raw.open !== p.open_ms || raw.available !== p.available_ms || raw.close !== p.close) throw Error(`Stored spot differs from raw candle at row ${i}`);
  }
  const rows = [], skipped = { invalidMarket: [], unsupportedMarket: [], missingSpot: [], staleSpot: [] };
  const official = { checked: 0, missing: [], disagree: [], rawFieldMismatches: [] }, seen = new Set();
  for (const m of markets) {
    if (seen.has(m.ticker)) throw Error(`Duplicate market ${m.ticker}`);
    seen.add(m.ticker);
    const raw = JSON.parse(m.raw_json), t = Date.parse(m.close_time), open = Date.parse(m.open_time);
    if (!Number.isFinite(t) || !Number.isFinite(open) || !Number.isFinite(m.floor_strike) || m.floor_strike <= 0 ||
        !['yes', 'no'].includes(m.result)) { skipped.invalidMarket.push(m.ticker); continue; }
    if (!m.ticker.startsWith('KXBTC15M-') || t - open !== 900000 || raw.strike_type !== 'greater_or_equal') {
      skipped.unsupportedMarket.push(m.ticker); continue;
    }
    if (['ticker', 'open_time', 'close_time', 'floor_strike', 'result', 'expiration_value'].some(k => raw[k] !== m[k])) official.rawFieldMismatches.push(m.ticker);
    const expiration = settlementNumber(m.expiration_value);
    if (expiration === null) official.missing.push(m.ticker);
    else {
      official.checked++;
      if ((expiration >= m.floor_strike ? 'yes' : 'no') !== m.result) official.disagree.push(m.ticker);
    }
    const index = asOf(spot, t);
    if (index < 0) { skipped.missingSpot.push(m.ticker); continue; }
    const p = spot[index], ageMs = t - p.available_ms;
    if (ageMs > maxAgeMs) { skipped.staleSpot.push(m.ticker); continue; }
    const implied = p.close >= m.floor_strike ? 'yes' : 'no', candle = JSON.parse(p.raw_json);
    const low = settlementNumber(candle[3]), high = settlementNumber(candle[2]);
    rows.push({ ticker: m.ticker, closeTime: m.close_time, strike: m.floor_strike, spot: p.close,
      official: expiration, result: m.result, impliedResult: implied, disagree: implied !== m.result,
      distanceBps: Math.abs(p.close - m.floor_strike) / m.floor_strike * 10000,
      signedDifferenceBps: expiration === null ? null : (p.close - expiration) / m.floor_strike * 10000,
      ageMs, candleOpenMs: p.open_ms, candleAvailableMs: p.available_ms,
      officialOutsideBinanceRange: expiration === null || low === null || high === null ? null : expiration < low || expiration > high });
  }
  const mismatches = rows.filter(r => r.disagree), summary = counts(rows);
  return {
    totalMarkets: markets.length, agree: summary.agree, disagree: summary.disagree,
    noSpot: skipped.missingSpot.length + skipped.staleSpot.length,
    agreementRate: rows.length ? summary.agree / rows.length : null,
    methodology: 'Disjoint distance buckets; Binance BTCUSDT completed-minute close versus stored Kalshi settlement average. Differences combine index, currency, and averaging effects. Official values are not forecast inputs.',
    fingerprint: { marketsSha256: hash(markets), spotSha256: hash(spot), spotRows: spot.length,
      firstClose: rows[0]?.closeTime ?? null, lastClose: rows.at(-1)?.closeTime ?? null },
    directionality: { spotAboveStrikeButKalshiSaidNo: mismatches.filter(r => r.impliedResult === 'yes').length,
      spotBelowStrikeButKalshiSaidYes: mismatches.filter(r => r.impliedResult === 'no').length },
    byProximityToStrike_bps: LIMITS.map((upper, i) => ({
      range: i === 0 ? '[0, 5]' : `(${LIMITS[i - 1]}, ${upper}]`,
      lowerBps: i ? LIMITS[i - 1] : 0, upperBps: Number.isFinite(upper) ? upper : 'Infinity',
      ...counts(rows.filter(r => r.distanceBps <= upper && (!i || r.distanceBps > LIMITS[i - 1]))) })),
    cumulativeWithinBps: LIMITS.filter(Number.isFinite).map(upper => ({ withinBps: upper, ...counts(rows.filter(r => r.distanceBps <= upper)) })),
    dataQuality: { skipped, official, spotAgeMs: stats(rows.map(r => r.ageMs)),
      exactBoundaryMatches: rows.filter(r => r.ageMs === 0).length,
      spotGaps: spot.slice(1).filter((p, i) => p.available_ms - spot[i].available_ms !== 60000).length },
    mismatchDistanceBps: stats(mismatches.map(r => r.distanceBps)),
    signedSpotMinusOfficialBps: stats(rows.map(r => r.signedDifferenceBps)),
    absoluteSpotMinusOfficialBps: stats(rows.map(r => r.signedDifferenceBps === null ? null : Math.abs(r.signedDifferenceBps))),
    officialOutsideBinanceMinuteRange: rows.filter(r => r.officialOutsideBinanceRange === true).length,
    mismatchesOutsideBinanceMinuteRange: mismatches.filter(r => r.officialOutsideBinanceRange === true).length,
    byDay: [...new Set(rows.map(r => r.closeTime.slice(0, 10)))].map(day => {
      const group = rows.filter(r => r.closeTime.startsWith(day));
      return { day, ...counts(group), signedSpotMinusOfficialBps: stats(group.map(r => r.signedDifferenceBps)) };
    }),
    // Positive offsets intentionally use future data for diagnosis, never a replay correction.
    timingSensitivity: [-120000, -60000, 0, 60000, 120000].map(offsetMs => {
      const eligible = [];
      for (const r of rows) {
        const target = Date.parse(r.closeTime) + offsetMs, index = asOf(spot, target);
        if (index < 0 || target - spot[index].available_ms > maxAgeMs) continue;
        eligible.push({ disagree: (spot[index].close >= r.strike ? 'yes' : 'no') !== r.result });
      }
      return { offsetMs, diagnosticOnly: true, ...counts(eligible) };
    }),
    largestMismatches: [...mismatches].sort((a, b) => b.distanceBps - a.distanceBps).slice(0, 20), mismatches,
  };
}
module.exports = { analyzeSettlementBasis, settlementNumber };
