const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const root = require('#src/config/paths').root;
const { analyzeSettlementBasis } = require('#src/research/settlement-basis');
function main(args = process.argv.slice(2)) {
  if (args.length && (args.length !== 2 || args[0] !== '--out')) throw Error('Usage: node scripts/check-settlement-basis.js [--out report.json]');
  const h = new Database(path.join(root, 'data/market-history/history.sqlite'), { readonly: true, fileMustExist: true });
  let s;
  try {
    s = new Database(path.join(root, 'data/research/research.sqlite'), { readonly: true, fileMustExist: true });
    const markets = h.prepare('SELECT * FROM markets ORDER BY close_time,ticker').all();
    const spot = s.prepare('SELECT * FROM spot_candles ORDER BY available_ms').all();
    const report = analyzeSettlementBasis(markets, spot);
    if (args.length) fs.writeFileSync(path.resolve(args[1]), JSON.stringify(report, null, 2) + '\n');
    const { mismatches, byDay, ...compact } = report;
    console.log(JSON.stringify(compact, null, 2));
    return report;
  } finally { h.close(); s?.close(); }
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
