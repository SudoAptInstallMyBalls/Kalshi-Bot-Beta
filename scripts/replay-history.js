#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { openResearch, downloadSpot } = require('#src/research/research-data');
const { replay, validateConfig } = require('#src/research/history-replay');
const { MLPipeline } = require('#src/ml/ml-pipeline');
const { csvCell } = require('#src/research/market-history');
const root = require('#src/config/paths').root;

function parseArgs(args) {
  const options = { history: path.join(root, 'data/market-history/history.sqlite'),
    out: path.join(root, 'data/research'), config: path.join(root, 'config/research/research-config.json'), download: false };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--download-spot') options.download = true;
    else if (key === '--help') options.help = true;
    else if (['--history', '--out', '--config'].includes(key)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
      options[key.slice(2)] = path.resolve(args[++i]);
    } else throw new Error(`Unknown option: ${key}`);
  }
  if (path.resolve(options.history).toLowerCase() === path.join(options.out, 'research.sqlite').toLowerCase()) {
    throw new Error('Research output cannot overwrite the history database');
  }
  return options;
}

function summarize(run) {
  return { ...run, samples: run.samples.length };
}
function metrics(rows, predict) {
  if (!rows.length) return null;
  const probabilities = rows.map(predict);
  return { size: rows.length,
    accuracy: rows.reduce((sum, row, i) => sum + Number(Number(probabilities[i] > 0.5) === row.label), 0) / rows.length,
    brierScore: rows.reduce((sum, row, i) => sum + (probabilities[i] - row.label) ** 2, 0) / rows.length };
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log('node scripts/replay-history.js [--download-spot] [--history PATH] [--out DIRECTORY] [--config JSON_PATH]');
    return;
  }
  const config = JSON.parse(fs.readFileSync(options.config, 'utf8'));
  validateConfig(config);
  const history = new Database(options.history, { readonly: true, fileMustExist: true });
  let research;
  try {
    const range = history.prepare("SELECT min(open_time) start,max(close_time) end FROM markets WHERE result IN ('yes','no')").get();
    if (!range.start || !range.end) throw new Error('No settled markets downloaded');
    research = openResearch(path.join(options.out, 'research.sqlite'));
    const from = Date.parse(range.start) - 3 * 3600000, to = Date.parse(range.end);
    if (options.download) await downloadSpot(research, from, to);
    const spot = research.prepare('SELECT available_ms,close FROM spot_candles WHERE available_ms>? AND available_ms<=? ORDER BY available_ms').all(from, to);
    if (!spot.length) throw new Error('BTC reference data missing. Run with --download-spot to fetch public BTCUSDT candles.');
    const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8);
    const runDir = path.join(options.out, 'runs', id);
    fs.mkdirSync(runDir, { recursive: true });
    const modelPath = path.join(runDir, 'research-model.json');
    console.log('[Replay] Using actual Kalshi candles and the bot signal/exit generator; minute-resolution simulation.');
    const normal = await replay(history, spot, config, { modelPath });
    const adverse = await replay(history, spot, config, { modelPath, adverse: true });
    const rows = normal.samples;
    // Markets cannot overlap and each contributes at most one row. Labels from
    // training are therefore known before any later held-out signal is generated.
    for (let i = 1; i < rows.length; i++) {
      if (rows[i - 1].outcome_ms >= rows[i].ts) throw new Error('Outcome overlaps later signal; refusing leakage-prone training');
    }
    const trainEnd = Math.floor(rows.length * 0.70), valEnd = Math.floor(rows.length * 0.85);
    const training = rows.slice(0, trainEnd), validation = rows.slice(trainEnd, valEnd), test = rows.slice(valEnd);
    const trainingWinRate = training.length ? training.reduce((sum, row) => sum + row.label, 0) / training.length : 0.5;
    const ml = new MLPipeline({ modelPath, db: { getTrainingData: () => rows }, config: {
      ML_RESEARCH_ONLY: true, ML_MIN_TRAINING_SAMPLES: config.minimumTrainingSamples,
    } });
    let trained;
    try { trained = await ml.train(); } finally { ml.stop(); }
    const report = { id, createdAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`,
      history: options.history, range, reference: { source: 'binance:BTCUSDT:1m', candles: spot.length }, config,
      mode: 'research-only', liveModelChanged: false,
      sourceHashes: Object.fromEntries(['src/strategy/exit-policy.js','src/research/history-replay.js', 'src/ml/ml-pipeline.js',
        'src/agents/skills/analysis/signal-generator.js', 'src/agents/skills/analysis/probability-model.js'].map(file =>
        [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
      assumptions: [
        'Signals use only completed candles; entries and exits execute at the following minute end, never on the signal candle.',
        'One entry attempt per market; shared signal and exit rules, but not a full replay of the live orchestrator, risk breakers or ML-filtered trading.',
        'Normal scenario: next-minute closing ask for entry, closing bid minus configured slippage for exit; entry limit includes configured slippage.',
        'Adverse scenario: next-minute worst ask/bid. Full fills require volume participation capacity; aggregate volume is NOT evidence of available book depth.',
        'Fees use configurable quadratic rate and cent rounding per simulated order. Series-specific multipliers, rounding rebates and split fills are not reconstructed.',
        'Minute spot EMA and volatility approximate the tick feed. No historical Polymarket feed; that strategy is disabled. Settlement uses recorded Kalshi result.',
        'Configured fee-inclusive equity risk cap and a latched minute-mark equity drawdown threshold are modeled. This still does not reproduce exact live account marks or intrasecond execution.',
        'Recent performance features contain only earlier simulated closes; data and models are isolated from real execution labels.',
      ],
      normal: summarize(normal), adverse: summarize(adverse),
      split: { method: 'chronological, disjoint markets', training: training.length, validation: validation.length, test: test.length,
        validationStarts: validation[0]?.ts ?? null, testStarts: test[0]?.ts ?? null },
      ml: { ...ml.describe(), trainedThisRun: trained, minimumSamples: config.minimumTrainingSamples,
        modelPath: trained ? modelPath : null,
        reason: trained ? 'Research model only; no live promotion' : `Only ${rows.length} simulated outcomes; need ${config.minimumTrainingSamples}` },
      baselines: { validation: { constantHalf: metrics(validation, () => 0.5), trainingWinRate: metrics(validation, () => trainingWinRate) },
        test: { constantHalf: metrics(test, () => 0.5), trainingWinRate: metrics(test, () => trainingWinRate) } },
    };
    const insert = research.prepare('INSERT INTO replay_samples VALUES (?,?,?,?,?,?,?,?)');
    research.transaction(() => {
      research.prepare('INSERT INTO replay_runs VALUES (?,?,?)').run(id, Date.now(), JSON.stringify(report));
      for (const row of rows) insert.run(id, row.ticker, row.ts, row.outcome_ms, JSON.stringify(row.features), row.label, row.pnl, JSON.stringify(row.details));
    })();
    const columns = ['ticker', 'ts', 'outcome_ms', 'label', 'pnl', 'features'];
    fs.writeFileSync(path.join(runDir, 'samples.csv'), [columns.join(','), ...rows.map(row =>
      columns.map(key => csvCell(key === 'features' ? JSON.stringify(row[key]) : row[key])).join(','))].join('\r\n') + '\r\n');
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
    const overview = `# Kalshi history replay\n\nRun: ${id}\n\n` +
      `**Research simulation, not a live performance forecast.** Starting balance: $${config.startingBalance.toFixed(2)}.\n\n` +
      `| Scenario | Simulated trades | Net P&L | Maximum realized drawdown |\n|---|---:|---:|---:|\n` +
      `| Next-minute close | ${rows.length} | $${normal.pnl.toFixed(2)} | ${(normal.maxDrawdown * 100).toFixed(2)}% |\n` +
      `| Adverse minute range | ${adverse.samples.length} | $${adverse.pnl.toFixed(2)} | ${(adverse.maxDrawdown * 100).toFixed(2)}% |\n\n` +
      `Eligible markets: ${normal.audit.eligibleMarkets}/${normal.audit.markets}. BTC reference candles: ${spot.length}.\n\n` +
      `Training / validation / test outcomes: ${training.length} / ${validation.length} / ${test.length}.\n\n` +
      `Model: ${report.ml.reason}. Live model unchanged.\n\n` +
      report.assumptions.map(item => `- ${item}`).join('\n') + '\n\nSee report.json for configuration, audit counters, model metrics and baselines; samples.csv for the 27-feature labeled dataset.\n';
    fs.writeFileSync(path.join(runDir, 'REPORT.md'), overview);
    fs.writeFileSync(path.join(options.out, 'latest-report.json.tmp'), JSON.stringify(report, null, 2));
    fs.renameSync(path.join(options.out, 'latest-report.json.tmp'), path.join(options.out, 'latest-report.json'));
    console.log(JSON.stringify({ report: path.join(runDir, 'report.json'), normal: report.normal, adverse: report.adverse, ml: report.ml }, null, 2));
    if (!normal.audit.eligibleMarkets) process.exitCode = 2;
    return report;
  } finally { research?.close(); history.close(); }
}
if (require.main === module) main().catch(error => { console.error('[Replay]', error.message || error.code || String(error)); process.exitCode = 1; });
module.exports = { main, parseArgs, metrics };
