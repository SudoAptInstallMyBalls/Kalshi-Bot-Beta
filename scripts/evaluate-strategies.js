#!/usr/bin/env node
// Fixed, small candidate set. Selection never consults the final time block.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { replay } = require('#src/research/history-replay');
const root = require('#src/config/paths').root;

function summarize(result) {
  const groups = {};
  for (const row of result.samples) {
    const key = row.details.exitType;
    const g = groups[key] ||= { trades: 0, pnl: 0, wins: 0 };
    g.trades++; g.pnl += row.pnl; g.wins += row.label;
  }
  return { trades: result.samples.length, pnl: result.pnl, drawdown: result.maxDrawdown,
    winRate: result.winRate, audit: result.audit, exits: groups };
}
function eligible(candidate) {
  return candidate.train.trades >= 30 && candidate.validation.trades >= 30 &&
    candidate.train.pnl > 0 && candidate.validation.pnl > 0 && candidate.stressValidation.pnl > 0;
}
async function main() {
  const history = new Database(path.join(root, 'data/market-history/history.sqlite'), { readonly: true });
  const reference = new Database(path.join(root, 'data/research/research.sqlite'), { readonly: true });
  try {
    const markets = history.prepare("SELECT ticker,open_time,close_time FROM markets WHERE result IN ('yes','no') ORDER BY open_time,ticker").all();
    if (markets.length < 100) throw new Error('Need at least 100 markets for comparison');
    const spot = reference.prepare('SELECT available_ms,close FROM spot_candles ORDER BY available_ms').all();
    const base = JSON.parse(fs.readFileSync(path.join(root, 'config/research/research-config.json')));
    const variants = [
      ['corrected_baseline', {}],
      ['no_trend_boost', { TREND_ENABLED: false }],
      ['market_blend_75', { MODEL_PROBABILITY_WEIGHT: 0.75 }],
      ['market_blend_50', { MODEL_PROBABILITY_WEIGHT: 0.5 }],
      ['eight_minute_window', { TRADING_WINDOW: 8 }],
      ['ten_point_edge', { MIN_DIVERGENCE: 10 }],
      ['twenty_point_edge', { MIN_DIVERGENCE: 20 }],
      ['no_scalping', { ENABLE_SCALPING: false }],
    ].map(([name, strategy]) => ({ name, config: { ...base, strategy: { ...base.strategy, ...strategy } } }));
    const trainEnd = Math.floor(markets.length * 0.6), validationEnd = Math.floor(markets.length * 0.8);
    const blocks = { train: markets.slice(0, trainEnd), validation: markets.slice(trainEnd, validationEnd), test: markets.slice(validationEnd) };
    const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8);
    const dir = path.join(root, 'data/research/evaluations', id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = { id, createdAt: new Date().toISOString(), variants, blocks,
      selectionRule: 'At least 30 train and 30 validation trades; positive train, validation and adverse validation P&L; select largest validation P&L among eligible candidates.',
      limitation: 'Retrospective time-block holdout: aggregate results on this history were already inspected. Fresh future data is still required. Each block starts at the same research balance.',
      execution: 'Minute replay assumptions apply. No live model or configuration promotion.' };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const run = async (config, block, adverse = false) => summarize(await replay(history, spot, config, {
      modelPath: path.join(dir, 'unused-model.json'), adverse, tickers: new Set(block.map(m => m.ticker)),
    }));
    const results = [];
    for (const variant of variants) {
      const value = { name: variant.name, train: await run(variant.config, blocks.train),
        validation: await run(variant.config, blocks.validation), stressValidation: await run(variant.config, blocks.validation, true) };
      value.eligible = eligible(value);
      results.push(value);
      console.log(`[Evaluate] ${value.name}: train $${value.train.pnl.toFixed(2)}, validation $${value.validation.pnl.toFixed(2)}, adverse validation $${value.stressValidation.pnl.toFixed(2)}; eligible=${value.eligible}`);
    }
    const winner = results.filter(eligible).sort((a, b) => b.validation.pnl - a.validation.pnl)[0];
    // Freeze selection before querying the final block. If nobody qualifies,
    // report the corrected baseline as a diagnostic; do not pretend it won.
    fs.writeFileSync(path.join(dir, 'selection.json'), JSON.stringify({ selected: winner?.name ?? null, results }, null, 2));
    const chosen = variants.find(v => v.name === winner?.name) || variants[0];
    const finalTest = { name: chosen.name, diagnosticOnly: !winner,
      normal: await run(chosen.config, blocks.test), adverse: await run(chosen.config, blocks.test, true) };
    const report = { id, selected: winner?.name ?? null, results, finalTest, livePromotion: false,
      futureHoldoutAfter: markets.at(-1).close_time, limitations: manifest.limitation };
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    const lines = ['# Strategy evaluation', '', `Selection: **${winner?.name || 'No candidate passed the predeclared gates'}**. No live promotion.`, '',
      '| Candidate | Training P&L | Validation trades | Validation P&L | Adverse validation P&L | Pass |', '|---|---:|---:|---:|---:|---|',
      ...results.map(v => `| ${v.name} | $${v.train.pnl.toFixed(2)} | ${v.validation.trades} | $${v.validation.pnl.toFixed(2)} | $${v.stressValidation.pnl.toFixed(2)} | ${v.eligible} |`), '',
      `Final time-block test (${chosen.name}${winner ? '' : ', diagnostic only'}): ${finalTest.normal.trades} trades, $${finalTest.normal.pnl.toFixed(2)} net; adverse $${finalTest.adverse.pnl.toFixed(2)}.`, '',
      manifest.selectionRule, '', manifest.limitation, '', `Untouched forward data must be later than ${report.futureHoldoutAfter}.`, '',
      'See manifest.json for fixed candidates and market membership; report.json for rejection counters and exit breakdowns.'];
    fs.writeFileSync(path.join(dir, 'REPORT.md'), lines.join('\n'));
    fs.writeFileSync(path.join(root, 'data/research/latest-evaluation.json'), JSON.stringify({ ...report, directory: dir }, null, 2));
    console.log(JSON.stringify({ directory: dir, selected: report.selected, finalTest }, null, 2));
    return report;
  } finally { history.close(); reference.close(); }
}
if (require.main === module) main().catch(err => { console.error(err.message); process.exitCode = 1; });
module.exports = { eligible, summarize };
