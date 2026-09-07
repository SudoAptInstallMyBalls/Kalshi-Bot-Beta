const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { root } = require('../src/config/paths');
const { evaluateForecasts } = require('../src/research/settlement-evaluation');
const { replay } = require('../src/research/history-replay');
const { analyzeSettlementBasis } = require('../src/research/settlement-basis');
const { SettlementReference } = require('../src/market-data/settlement-reference');
function hashQuery(db, sql) {
  const hash = crypto.createHash('sha256');
  for (const row of db.prepare(sql).iterate()) hash.update(JSON.stringify(row) + '\n');
  return hash.digest('hex');
}

async function main(args = process.argv.slice(2)) {
  let indexFile, forwardAfter = null, coinbaseShadow = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--coinbase-shadow') coinbaseShadow = true;
    else if (args[i] === '--index-db' && args[i + 1]) indexFile = path.resolve(args[++i]);
    else if (args[i] === '--forward-after' && args[i + 1]) {
      forwardAfter = Date.parse(args[++i]);
      if (!Number.isFinite(forwardAfter)) throw Error('Invalid forward cutoff timestamp');
    } else throw Error('Usage: evaluate-settlement-models.js [--index-db authorized-history.sqlite] [--forward-after ISO-timestamp] [--coinbase-shadow]');
  }
  if (indexFile && !fs.existsSync(indexFile)) throw Error('Index database does not exist');
  const h = new Database(path.join(root, 'data/market-history/history.sqlite'), { readonly: true, fileMustExist: true });
  let s, reference, coinbase;
  try {
    s = new Database(path.join(root, 'data/research/research.sqlite'), { readonly: true, fileMustExist: true });
    // Pin read snapshots during the full comparison.
    h.exec('BEGIN'); s.exec('BEGIN');
    const spot = s.prepare('SELECT * FROM spot_candles ORDER BY available_ms').all();
    const markets = h.prepare('SELECT * FROM markets ORDER BY open_time,ticker').all();
    const audit = analyzeSettlementBasis([...markets].sort((a, b) => a.close_time.localeCompare(b.close_time)), spot);
    if (audit.dataQuality.official.disagree.length || audit.dataQuality.official.rawFieldMismatches.length) throw Error('Official settlement integrity check failed');
    reference = indexFile ? new SettlementReference(indexFile, { allowHistorical: true }) : null;
    const result = evaluateForecasts(h, spot, { indexReference: reference, forwardAfter });
    let shadow = null;
    if (coinbaseShadow) {
      const file = path.join(root, 'data/research/free-feed/coinbase.sqlite');
      if (fs.existsSync(file)) {
        coinbase = new Database(file, { readonly: true, fileMustExist: true }); coinbase.exec('BEGIN');
        shadow = require('../src/research/coinbase-shadow').evaluateCoinbaseShadow(h, coinbase, result.rows, forwardAfter ?? 0);
      } else shadow = { shadowOnly: true, unavailable: 'Coinbase recorder has not created a database' };
    }
    let bookShadow = null;
    if (coinbase && coinbase.prepare("SELECT name FROM sqlite_master WHERE name='proxy_quotes'").get()) {
      bookShadow = require('../src/research/coinbase-book-shadow').evaluateCoinbaseBookShadow(h, coinbase, result.rows, forwardAfter ?? 0);
    }
    const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8);
    const dir = path.join(root, 'data/research/settlement-evaluations', id);
    fs.mkdirSync(dir, { recursive: true });
    const base = JSON.parse(fs.readFileSync(path.join(root, 'config/research/research-config.json')));
    const tradeResults = {};
    for (const aware of [false, true]) {
      const name = aware ? 'proxyAverageRobust' : 'legacyBaseline';
      tradeResults[name] = {};
      for (const adverse of [false, true]) {
        const r = await replay(h, spot, { ...base, strategy: { ...base.strategy, SETTLEMENT_AWARE: aware } },
          { modelPath: path.join(dir, 'unused-model.json'), adverse });
        tradeResults[name][adverse ? 'adverse' : 'normal'] = { trades: r.samples.length, pnl: r.pnl,
          maxDrawdown: r.maxDrawdown, maxMarkedDrawdown: r.maxMarkedDrawdown, riskLatched: r.riskLatched, audit: r.audit };
      }
    }
    const sourceFiles = ['src/strategy/volatility.js', 'src/strategy/settlement-forecast.js', 'src/research/proxy-reference.js',
      'src/research/settlement-evaluation.js', 'src/research/history-replay.js', 'src/agents/skills/analysis/signal-generator.js',
      'src/agents/skills/analysis/probability-model.js', 'src/market-data/settlement-reference.js', 'scripts/evaluate-settlement-models.js'];
    sourceFiles.push('src/strategy/settlement-number.js','src/agents/skills/analysis/ml-signal-scorer.js',
	'src/agents/skills/trading/risk-manager.js','scripts/record-settlement-index.js','src/research/coinbase-shadow.js','src/research/coinbase-recorder.js');
    const manifest = { createdAt: new Date().toISOString(), base, fingerprint: audit.fingerprint,
	  basisErrorBps: audit.absoluteSpotMinusOfficialBps, // {count,min,median,mean,p95,max} — what's actually driving the entry guard
      quotesSha256: hashQuery(h, 'SELECT * FROM candles WHERE period_minutes=1 ORDER BY ticker,end_period_ts'),
      indexSha256: reference?.db ? hashQuery(reference.db, 'SELECT * FROM index_samples ORDER BY timestamp') : null,
      codeSha256: Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
      selection: 'No candidate selection or live promotion. Fixed variants, fixed minute offsets, chronological 60/20/20 report blocks.',
      limits: 'Retrospective data already inspected. Forecasts within markets are correlated. Proxy assumes opening basis persists, with trailing absolute residual stress; 95th percentile is empirical, not a guaranteed confidence bound. Historical settlement_ts is assumed public availability, not local historical receipt time. BRTI observations require both event and receipt timestamps. Proxy cannot observe the final settlement minute.',
      livePromotion: false, freshDataAfter: result.freshDataAfter };
    const { rows, ...summary } = result;
    fs.writeFileSync(path.join(dir, 'forecasts.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ manifest, ...summary, coinbaseShadow: shadow, coinbaseBookShadow: bookShadow, trading: tradeResults }, null, 2));
    fs.writeFileSync(path.join(dir, 'REPORT.md'), ['# Settlement model comparison', '', manifest.limits, '',
      '| Model | Common forecasts | Brier |', '|---|---:|---:|', ...Object.entries(summary.all.models).map(([name, m]) => `| ${name} | ${m.forecasts} | ${m.brier?.toFixed(6)} |`), '',
      'Trading simulation keeps the account risk latch. Forecast evaluation continues over all eligible markets independently.', '',
      ...Object.entries(tradeResults).map(([name, v]) => `${name}: ${v.normal.trades} trades, normal P&L ${v.normal.pnl.toFixed(3)}, adverse P&L ${v.adverse.pnl.toFixed(3)}.`), '',
      `Fresh data must be after ${result.freshDataAfter}. No live promotion.`, '', 'See report.json for fixed-time coverage, calibration bins, temporal blocks, source hashes and risk rejection counts.'].join('\n'));
    console.log(JSON.stringify({ directory: dir, forecasts: rows.length,
	  basisErrorBps: audit.absoluteSpotMinusOfficialBps,
      models: Object.fromEntries(Object.entries(summary.all.models).map(([k, v]) => [k, { brier: v.brier, markets: v.markets, forecasts: v.forecasts }])),
      forward: summary.forward ? { after: summary.forward.after, markets: summary.forward.comparison.commonMarkets,
        forecasts: summary.forward.comparison.commonForecasts, brier: Object.fromEntries(Object.entries(summary.forward.comparison.models).map(([k,v])=>[k,v.brier])) } : null,
      coinbaseShadow: shadow ? { ticks: shadow.ticks, comparison: shadow.comparison, missing: shadow.missing } : null,
      trading: tradeResults, livePromotion: false }, null, 2));
    return { directory: dir, summary };
  } finally { coinbase?.close(); reference?.close(); s?.close(); h.close(); }
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
module.exports = { main };
