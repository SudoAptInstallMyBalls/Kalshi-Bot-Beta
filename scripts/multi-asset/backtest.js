const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { evaluateForecasts, comparison } = require('./settlement-evaluation');
const { replay } = require('./history-replay');
const { normalize: normalizeCoinbase } = require('./coinbase-spot');
const { settlementNumber } = require('../../src/strategy/settlement-number');
const repo = path.resolve(__dirname,'../..');
const root = path.join(repo,'data/research/multi-asset');
const keys = ['rawTerminal','proxyTerminal','proxyAverage','marketMidpoint'];
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function blockAt(time, range) {
  return time < range.from+(range.to-range.from)*.6 ? 'train' : time < range.from+(range.to-range.from)*.8 ? 'validation' : 'test';
}
function sourceHashes() {
  const walk = dir => fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):e.name.endsWith('.js')?[path.join(dir,e.name)]:[]);
  return Object.fromEntries([...walk(path.join(repo,'src')),...walk(__dirname),path.join(repo,'config/research/research-config.json'),path.join(repo,'package-lock.json')]
    .sort().map(p=>[path.relative(repo,p),sha(fs.readFileSync(p))]));
}
async function main() {
  if(process.argv.length>2) throw Error('Usage: node scripts/multi-asset/backtest.js');
  const range=JSON.parse(fs.readFileSync(path.join(root,'backfill-request.json')));
  if(!Number.isSafeInteger(range.from)||!Number.isSafeInteger(range.to)||range.from>=range.to) throw Error('Invalid backfill range');
  const config=JSON.parse(fs.readFileSync(path.join(repo,'config/research/research-config.json')));
  const dir=path.join(root,'backtests',new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(dir,{recursive:true});
  const manifest={createdAt:new Date().toISOString(),range,config,codeSha256:sourceHashes(),
    split:'Fixed common calendar boundaries: 60% development, 20% validation, 20% retrospective test. No tuning or model selection in this run.',
    bankroll:'Each asset, strategy and split starts with its own $100. Also run a continuous 60-day account per asset/strategy. No pooled portfolio or capital sharing.',
    limitations:'Retrospective minute-resolution replay. Same fixed BTC percentage-volatility floor and strategy thresholds across assets. Trailing calibration uses only outcomes with settlement_ts <= decision time. Next-minute simulated fills use bid/ask candles, fees, volume participation and adverse extrema, not actual depth or queue position. Historical settlement_ts is assumed availability. Coinbase and Binance are not the official index. Per-asset P&Ls are not a portfolio backtest. Repeated market forecasts are correlated. No ML training or live promotion.'};
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2));
  const results=[];
  for(const asset of ['BTC','ETH','SOL','XRP','DOGE']) {
    console.log(`${asset}: validating and scoring`);
    const h=new Database(path.join(root,asset,'history.sqlite'),{readonly:true,fileMustExist:true});
    const s=new Database(path.join(root,asset,'spot-coinbase.sqlite'),{readonly:true,fileMustExist:true});
    try {
      h.exec('BEGIN');s.exec('BEGIN');
      h.exec(`CREATE TEMP VIEW markets AS SELECT * FROM main.markets WHERE unixepoch(open_time)*1000>=${range.from} AND unixepoch(close_time)*1000<=${range.to}`);
      const markets=h.prepare('SELECT * FROM markets ORDER BY open_time,ticker').all();
      if(!markets.length) throw Error(`${asset}: no markets`);
      const spot=s.prepare('SELECT * FROM spot_candles WHERE available_ms>? AND available_ms<=? ORDER BY available_ms').all(range.from-3*3600000,range.to);
      if(!spot.length) throw Error(`${asset}: empty Coinbase reference range`);
      for(const [i,r] of spot.entries()) {
        const raw=normalizeCoinbase(JSON.parse(r.raw_json));
        if(r.source!==`coinbase:${asset}-USD:1m` || r.close!==raw.close || r.available_ms!==raw.available_ms || r.open_ms!==raw.open_ms || (i&&r.available_ms<=spot[i-1].available_ms)) throw Error(`${asset}: invalid spot row`);
      }
      const invalidMetadata = [];
      const validMarkets = [];
      for(const m of markets) {
        const raw=JSON.parse(m.raw_json),official=settlementNumber(m.expiration_value);
        if(!m.ticker.startsWith(`KX${asset}15M-`)||raw.strike_type!=='greater_or_equal'||!(m.floor_strike>0)||Date.parse(m.close_time)-Date.parse(m.open_time)!==900000||official===null||
          (official>=m.floor_strike?'yes':'no')!==m.result||['ticker','open_time','close_time','result','expiration_value'].some(k=>raw[k]!==m[k])||Number(raw.floor_strike)!==m.floor_strike) {
          invalidMetadata.push({ ticker:m.ticker, reason: !Number.isFinite(m.floor_strike) || official===null ? 'missing_strike_or_expiration' : 'metadata_mismatch' });
          continue;
        }
        validMarkets.push(m);
      }
      h.exec('DROP VIEW markets');
      const quotedTickers=validMarkets.map(m=>`'${m.ticker.replaceAll("'","''")}'`).join(',');
      h.exec(`CREATE TEMP VIEW markets AS SELECT * FROM main.markets WHERE ticker IN (${quotedTickers || "''"})`);
      const volatilityReturns={BTC:15,ETH:15,SOL:30,XRP:30,DOGE:30}[asset];
      const f=evaluateForecasts(h,spot,{asset,volatilityReturns});
      for(const r of f.rows) r.block=blockAt(r.openTime,range);
      const scores=Object.fromEntries(['train','validation','test','all'].map(b=>[b,comparison(f.rows.filter(r=>b==='all'||r.block===b),keys)]));
      const trading={};
      for(const aware of [false,true]) {
        const name=aware?'proxyAverageRobust':'legacyBaseline';trading[name]={};
        for(const b of ['train','validation','test','all']) {
          trading[name][b]={};
          const tickers=new Set(markets.filter(m=>b==='all'||blockAt(Date.parse(m.open_time),range)===b).map(m=>m.ticker));
          for(const adverse of [false,true]) {
            const result=await replay(h,spot,{...config,strategy:{...config.strategy,SETTLEMENT_AWARE:aware,RESEARCH_VOLATILITY_RETURNS:volatilityReturns}},
              {asset,adverse,tickers,modelPath:path.join(dir,'unused-model.json')});
            const {samples,...summary}=result;
            trading[name][b][adverse?'adverse':'normal']={...summary,trades:samples.length,
              entryFees:samples.reduce((n,t)=>n+t.details.cost-t.details.entryPrice*t.details.contracts,0)};
            fs.writeFileSync(path.join(dir,`${asset}-${name}-${b}-${adverse?'adverse':'normal'}-trades.jsonl`),samples.map(r=>JSON.stringify({asset,...r})).join('\n'));
          }
        }
      }
      const result={asset,markets:markets.length,validMarkets:validMarkets.length,invalidMetadata,skipped:f.skipped,skippedCalibrationMarkets:f.skippedCalibrationMarkets,calibrationSettings:f.calibrationSettings,scores,trading,
        dataSha256:{markets:sha(JSON.stringify(markets)),spot:sha(JSON.stringify(spot)),candles:sha(JSON.stringify(h.prepare('SELECT c.* FROM candles c JOIN markets m ON m.ticker=c.ticker ORDER BY c.ticker,c.end_period_ts').all()))}};
      results.push(result);
      fs.writeFileSync(path.join(dir,`${asset}-report.json`),JSON.stringify(result,null,2));
      fs.writeFileSync(path.join(dir,`${asset}-forecasts.jsonl`),f.rows.map(r=>JSON.stringify({asset,...r})).join('\n'));
      console.log(JSON.stringify({asset,test:scores.test,normalTest:Object.fromEntries(Object.entries(trading).map(([k,v])=>[k,{trades:v.test.normal.trades,pnl:v.test.normal.pnl,riskLatched:v.test.normal.riskLatched}]))},(k,v)=>k==='calibration'?undefined:v));
    } finally {h.close();s.close();}
  }
  if(JSON.stringify(sourceHashes())!==JSON.stringify(manifest.codeSha256)) throw Error('Source changed during evaluation');
  fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify({manifest,results},null,2));
  const lines=['# Five-asset retrospective backtest','',manifest.limitations,'',
    'Test period uses the final 12 days. Each strategy/asset starts with $100 in this block. Lower Brier is better.','',
    '| Asset | Test markets scored | Raw Brier | Proxy-average Brier | Market Brier | Baseline trades / net P&L | Robust trades / net P&L |','|---|---:|---:|---:|---:|---:|---:|'];
  for(const r of results){const m=r.scores.test.models,a=r.trading.legacyBaseline.test.normal,b=r.trading.proxyAverageRobust.test.normal;
    lines.push(`| ${r.asset} | ${r.scores.test.commonMarkets} | ${m.rawTerminal.brier?.toFixed(5)} | ${m.proxyAverage.brier?.toFixed(5)} | ${m.marketMidpoint.brier?.toFixed(5)} | ${a.trades} / $${a.pnl.toFixed(2)} | ${b.trades} / $${b.pnl.toFixed(2)} |`);}
  fs.writeFileSync(path.join(dir,'REPORT.md'),lines.join('\n'));
  fs.writeFileSync(path.join(root,'latest-backtest.json'),JSON.stringify({directory:dir,completedAt:new Date().toISOString()},null,2));
  console.log('Completed: '+dir);
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={blockAt};
