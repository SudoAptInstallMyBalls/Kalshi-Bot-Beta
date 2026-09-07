// Small, predeclared comparison on existing data; no downloading or live promotion.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const Database = require('better-sqlite3');
const { replay } = require('#src/research/history-replay');
async function main() {
  const root = require('#src/config/paths').root;
  const history = new Database(path.join(root, 'data/market-history/history.sqlite'), { readonly: true });
  const reference = new Database(path.join(root, 'data/research/research.sqlite'), { readonly: true });
  try {
    const base = JSON.parse(fs.readFileSync(path.join(root, 'config/research/research-config.json')));
    const markets = history.prepare("SELECT ticker,close_time FROM markets WHERE result IN ('yes','no') ORDER BY open_time,ticker").all();
    const spot = reference.prepare('SELECT available_ms,close FROM spot_candles ORDER BY available_ms').all();
    const windows = process.argv.includes('--windows');
    if (process.argv.slice(2).some(a=>a!=='--windows')) throw Error('Usage: node scripts/compare-entry-policy.js [--windows]');
    const variants = windows ? [
      { name: 'early_0_to_4', strategy: { MIN_DIVERGENCE: 10, ENTRY_START_MINUTES: 0, TRADING_WINDOW: 4 } },
      { name: 'middle_4_to_7', strategy: { MIN_DIVERGENCE: 10, ENTRY_START_MINUTES: 4, TRADING_WINDOW: 7 } },
      { name: 'preferred_7_to_10', strategy: { MIN_DIVERGENCE: 10, ENTRY_START_MINUTES: 7, TRADING_WINDOW: 10 } },
      { name: 'broad_0_to_14', strategy: { MIN_DIVERGENCE: 10, ENTRY_START_MINUTES: 0, TRADING_WINDOW: 14, ENTRY_CLOSE_BUFFER_SECONDS: 60 } },
    ] : [
      { name: 'baseline', strategy: {} },
      { name: 'lower_edge', strategy: { MIN_DIVERGENCE: 10 } },
      { name: 'longer_window', strategy: { MIN_DIVERGENCE: 10, TRADING_WINDOW: 10 } },
      { name: 'simple_entry', strategy: { MIN_DIVERGENCE: 10, TRADING_WINDOW: 10, TREND_ENABLED: false } },
    ];
    const dir = path.join(root, 'data/research/entry-comparison', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const manifest = { base, variants, markets, startingBalance: 59.4,
      exitPolicyHash: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'src/strategy/exit-policy.js'))).digest('hex'),
      sourceHash: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'src/agents/skills/analysis/signal-generator.js'))).digest('hex'),
      limitation: 'Retrospective diagnostics on previously inspected history, not independent validation. Each chronological third restarts equity at $59.40. Fees, minute latency, spread, slippage and risk caps remain enabled. No parameter search beyond these four declared candidates.' };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const results = [];
    for (const variant of variants) {
      const blocks = [];
      for (let i = 0; i < 3; i++) {
        const tickers = new Set(markets.slice(Math.floor(markets.length*i/3), Math.floor(markets.length*(i+1)/3)).map(m=>m.ticker));
        const block = {};
        for (const adverse of [false, true]) {
          const run = await replay(history, spot, { ...base, startingBalance: 59.4, strategy: { ...base.strategy, ...variant.strategy } },
            { tickers, adverse, modelPath: path.join(dir, 'unused-model.json') });
          const gains = run.samples.reduce((s,r)=>s+Math.max(0,r.pnl),0), losses = run.samples.reduce((s,r)=>s+Math.max(0,-r.pnl),0);
          block[adverse?'adverse':'normal'] = { trades: run.samples.length, pnl: run.pnl, winRate: run.winRate, profitFactor: losses?gains/losses:null, drawdown: run.maxMarkedDrawdown, audit: run.audit };
        }
        blocks.push(block);
      }
      const result = { ...variant, blocks };
      results.push(result);
      fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ manifest, results }, null, 2));
      console.log(JSON.stringify({name:variant.name, blocks:blocks.map(b=>Object.fromEntries(Object.entries(b).map(([k,v])=>[k,{trades:v.trades,pnl:v.pnl,winRate:v.winRate}])))}));
    }
    console.log(dir);
  } finally { history.close(); reference.close(); }
}
if (require.main === module) main().catch(e=>{console.error(e);process.exitCode=1;});
