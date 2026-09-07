const fs = require('fs'), path = require('path'), crypto = require('crypto'), D = require('better-sqlite3');
const { root } = require('../src/config/paths');
const { verify } = require('../src/research/forward-study');
const { replay } = require('../src/research/candidate-replay');
const { CandidateReference } = require('../src/research/candidate-reference');
const { evaluateForecasts, comparison } = require('../src/research/settlement-evaluation');
const variants = [
  ['robust_baseline', {}], ['edge_10', { MIN_DIVERGENCE: 10 }], ['edge_5', { MIN_DIVERGENCE: 5 }],
  ['window_8', { TRADING_WINDOW: 8 }], ['edge_5_window_8', { MIN_DIVERGENCE: 5, TRADING_WINDOW: 8 }],
  ['basis_p90', { RESEARCH_BASIS_QUANTILE: .90 }], ['volatility_60_returns', { RESEARCH_VOLATILITY_RETURNS: 60 }],
  ['combined', { MIN_DIVERGENCE: 10, TRADING_WINDOW: 8, RESEARCH_BASIS_QUANTILE: .90, RESEARCH_VOLATILITY_RETURNS: 60 }],
];
async function main() {
  const study = verify(), h = new D(path.join(root, 'data/market-history/history.sqlite'), { readonly: true }), s = new D(path.join(root, 'data/research/research.sqlite'), { readonly: true });
  try {
    h.exec('BEGIN'); s.exec('BEGIN');
    const markets = h.prepare("SELECT * FROM markets WHERE result IN ('yes','no') ORDER BY open_time,ticker").all();
    const spot = s.prepare('SELECT available_ms,close FROM spot_candles ORDER BY available_ms').all();
    const base = JSON.parse(fs.readFileSync(path.join(root, 'config/research/research-config.json')));
    const id = new Date().toISOString().replace(/[:.]/g, '-'), dir = path.join(root, 'data/research/candidate-evaluations', id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = { declaredAt: new Date().toISOString(), variants, base, frozenBaseline: study.id,
      limit: 'Exploratory on already-inspected data; not statistical evidence of alpha. No live promotion. Keep cost, sizing and drawdown safeguards.',
      hashes: Object.fromEntries(['src/research/candidate-reference.js', 'src/research/candidate-replay.js', 'scripts/evaluate-research-candidates.js'].map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')])) };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    const forecastRows = evaluateForecasts(h, spot).rows;
    const results = [];
    for (const [name, changes] of variants) {
      const config = { ...base, strategy: { ...base.strategy, SETTLEMENT_AWARE: true, ...changes } };
      const reference = new CandidateReference(markets, spot, { volatilityReturns: changes.RESEARCH_VOLATILITY_RETURNS ?? 15, quantile: changes.RESEARCH_BASIS_QUANTILE ?? .95 });
      const rows = forecastRows.map(r => ({ ...r, candidate: reference.getForecast({ ticker: r.ticker, openTime: r.openTime, closeTime: r.closeTime },
        markets.find(m => m.ticker === r.ticker).floor_strike, r.ts, { requireCalibration: false }).probUp ?? null }));
      const trading = {};
      for (const adverse of [false, true]) {
        const r = await replay(h, spot, config, { modelPath: path.join(dir, 'unused.json'), adverse });
        trading[adverse ? 'adverse' : 'normal'] = { trades: r.samples.length, pnl: r.pnl, drawdown: r.maxMarkedDrawdown,
          filters: r.audit.entryFilters, fills: r.audit.fillRejections, riskPausedMarkets: r.audit.riskPausedMarkets };
      }
      const result = { name, changes, trading, forecasts: comparison(rows, ['candidate', 'proxyAverage', 'marketMidpoint']),
        forward: comparison(rows.filter(r => r.openTime >= Date.parse(study.cutoff)), ['candidate', 'proxyAverage', 'marketMidpoint']) };
      results.push(result);
      console.log(JSON.stringify({ name, trades: trading.normal.trades, pnl: trading.normal.pnl, adverse: trading.adverse.pnl,
        brier: result.forecasts.models.candidate.brier }));
    }
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ manifest, results, livePromotion: false }, null, 2));
    fs.writeFileSync(path.join(dir, 'REPORT.md'), ['# Exploratory candidates', '', manifest.limit, '',
      '| Candidate | Trades | Normal P&L | Adverse P&L | Brier |', '|---|---:|---:|---:|---:|',
      ...results.map(r => `| ${r.name} | ${r.trading.normal.trades} | ${r.trading.normal.pnl.toFixed(3)} | ${r.trading.adverse.pnl.toFixed(3)} | ${r.forecasts.models.candidate.brier?.toFixed(6)} |`)].join('\n'));
    console.log(JSON.stringify({ directory: dir, livePromotion: false }));
    return { directory: dir, results };
  } finally { s.close(); h.close(); }
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
module.exports = { main, variants };
