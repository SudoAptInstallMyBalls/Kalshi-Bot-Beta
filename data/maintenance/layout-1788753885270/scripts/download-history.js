const path = require('path');
const fs = require('fs');
const { PublicHistoryClient, HistoryStore, downloadHistory, exportCSVs } = require('../lib/market-history');

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('node scripts/download-history.js [--min-trades 5000] [--markets 100] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out DIRECTORY] [--delay-ms 250] [--export-only | --sqlite-only]');
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--export-only') options.exportOnly = true;
    else if (arg === '--sqlite-only') options.sqliteOnly = true;
    else if (['--min-trades', '--markets', '--from', '--to', '--out', '--delay-ms'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = args[++i];
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.exportOnly && options.sqliteOnly) throw new Error('--export-only and --sqlite-only cannot be combined');
  const integer = (key, fallback, min) => {
    const n = Number(options[key] ?? fallback);
    if (!Number.isInteger(n) || n < min) throw new Error(`Invalid --${key}`);
    return n;
  };
  const date = (key, fallback) => {
    if (!options[key]) return fallback;
    const n = Date.parse(options[key]);
    if (!Number.isFinite(n)) throw new Error(`Invalid --${key}`);
    return Math.floor(n / 1000);
  };
  const from = date('from', 0), to = date('to', Math.floor(Date.now() / 1000));
  if (from > to) throw new Error('--from must be before --to');
  const directory = path.resolve(options.out || path.join(__dirname, '../data/market-history'));
  const marketLimit = integer('markets', 100, 1), minTrades = integer('min-trades', 5000, 0);
  const client = new PublicHistoryClient({ delayMs: integer('delay-ms', 250, 100) });
  const store = new HistoryStore(path.join(directory, 'history.sqlite'));
  try {
    console.log(`[History] ${process.platform}/${process.arch}; public GET requests only; ${directory}`);
    let run;
    if (!options.exportOnly) run = await downloadHistory({ client, store, marketLimit, minTrades, from, to });
    if (!options.sqliteOnly) await exportCSVs(store, directory);
    const summary = { createdAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`,
      selection: { marketLimit, minTrades, from, to }, run, counts: store.counts(),
      csvExported: !options.sqliteOnly,
      data: 'Public exchange trades and one-minute candles; 1s bars aggregate trade prints only.',
      historicalOrderbook: 'Not provided by the documented historical API; stream_events contains only separately captured live data.',
      botTraining: 'Market data is not the bot own execution/outcome feature schema. Replay and aligned spot/reference data are separate work.' };
    // Exporting existing data must not erase provenance of the download run.
    const summaryPath = path.join(directory, options.exportOnly ? 'export-summary.json' : 'download-summary.json');
    fs.writeFileSync(summaryPath + '.tmp', JSON.stringify(summary, null, 2));
    fs.renameSync(summaryPath + '.tmp', summaryPath);
    console.log(JSON.stringify(summary, null, 2));
    if (run && !run.targetMet) process.exitCode = 2;
  } finally { store.close(); }
}
if (require.main === module) main().catch(err => {
  console.error(`[History] ${err.response?.status || err.code || 'ERROR'}: ${err.message}`);
  console.error('Previously committed rows are retained. Run the same command to resume.');
  process.exitCode = 1;
});
module.exports = main;
