// Offline diagnostic only. Never trains/promotes a model or changes live settings.
const fs = require('fs');
const path = require('path');
const D = require('better-sqlite3');
const { replay, fee, asOf, spotContext } = require('../lib/history-replay');
const { MLPipeline } = require('../lib/ml-pipeline');
const { csvCell } = require('../lib/market-history');
const root = path.resolve(__dirname, '..');
const mean = a => a.length ? a.reduce((s,v)=>s+v,0)/a.length : null;
function variance(a) { const m=mean(a); return a.length>1 ? a.reduce((s,v)=>s+(v-m)**2,0)/(a.length-1) : null; }
function association(x,y) {
  if(x.length<3 || x.length!==y.length) return { n:x.length, correlation:null,beta:null };
  const mx=mean(x),my=mean(y),vx=variance(x),vy=variance(y);
  const cov=x.reduce((s,v,i)=>s+(v-mx)*(y[i]-my),0)/(x.length-1);
  return { n:x.length, correlation:vx>0&&vy>0 ? cov/Math.sqrt(vx*vy):null, beta:vx>0?cov/vx:null };
}
function tradeMetrics(rows) {
  const gp=rows.reduce((s,r)=>s+Math.max(0,r.pnl),0),gl=-rows.reduce((s,r)=>s+Math.min(0,r.pnl),0);
  return { trades:rows.length,pnl:gp-gl,profitFactor:gl>0?gp/gl:null,grossProfit:gp,grossLoss:gl,
    meanPnl:mean(rows.map(r=>r.pnl)),winRate:mean(rows.map(r=>Number(r.pnl>0))) };
}
function groups(rows,key) {
  return Object.fromEntries([...new Set(rows.map(key))].sort().map(k=>[k,tradeMetrics(rows.filter(r=>key(r)===k))]));
}
function dailySeries(rows,markets,spot,start=100) {
  const day=86400000,from=Date.parse(markets[0].open_time),to=Date.parse(markets.at(-1).close_time);
  let equity=start; const daily=[];
  for(let t=Math.floor(from/day)*day;t<to;t+=day) {
    const rs=rows.filter(r=>r.outcome_ms>t&&r.outcome_ms<=t+day);
    const pnl=rs.reduce((s,r)=>s+r.pnl,0),ret=pnl/equity;
    const a=asOf(spot,t),b=asOf(spot,t+day);
    daily.push({date:new Date(t).toISOString().slice(0,10),pnl,return:ret,trades:rs.length,
      fullDay:t>=from&&t+day<=to,btcReturn:a>=0&&b>=0&&spot[a].available_ms===t&&spot[b].available_ms===t+day?spot[b].close/spot[a].close-1:null});
    equity+=pnl;
  }
  return daily;
}
function performance(run,markets,spot,start) {
  const daily=dailySeries(run.samples,markets,spot,start),full=daily.filter(r=>r.fullDay&&r.btcReturn!==null);
  const returns=full.map(r=>r.return),v=variance(returns);
  return {...tradeMetrics(run.samples),maxRealizedDrawdown:run.maxDrawdown,
    annualizedDailySharpe:v>0?mean(returns)/Math.sqrt(v)*Math.sqrt(365):null,
    dailyObservations:full.length,btcDailyAssociation:association(full.map(r=>r.btcReturn),returns),daily,audit:run.audit};
}
async function main() {
  const h=new D(path.join(root,'data/market-history/history.sqlite'),{readonly:true,fileMustExist:true});
  const ref=new D(path.join(root,'data/research/research.sqlite'),{readonly:true,fileMustExist:true});
  try {
    const config=JSON.parse(fs.readFileSync(path.join(root,'research-config.json')));
    const markets=h.prepare("SELECT ticker,open_time,close_time,result FROM markets WHERE result IN ('yes','no') ORDER BY open_time,ticker").all();
    const spot=ref.prepare('SELECT available_ms,close FROM spot_candles ORDER BY available_ms').all();
    const dir=path.join(root,'data/research/audits',new Date().toISOString().replace(/[:.]/g,'-'));
    fs.mkdirSync(dir,{recursive:true});
    const modelPath=path.join(dir,'unused-model.json');
    // Freeze all diagnostic choices before observing subgroup performance.
    const manifest={config,regimes:'Volatility: spotContext trailing 15-return sigma at market OPEN; tertiles fitted only to first third of markets. Trend: trailing EMA/ROC at OPEN. Thresholds reused for all later markets.',
      walkForward:'Anchored history: first 40%, then three nonoverlapping 20% test blocks. Fixed baseline; no optimization or ML fit. Each fold resets to $100.',
      scenarios:['normal: next minute close, 1c exit slippage','adverse: next minute adverse extremes, 1c exit slippage','cost stress: adverse extremes, 2c exit slippage, 1.5x fee rate'],
      sharpe:'Realized-equity UTC daily simple returns, zero risk-free rate, sqrt(365) annualization; exclude partial boundary days. Not marked-to-market. Very short and autocorrelated sample.',
      limitation:'Previously inspected retrospective data; no pristine holdout or statistical claim of alpha/decay. Minute execution delay, not measured latency. No queue, depth, partial fills or full live risk engine.',
      createdAt:new Date().toISOString()};
    fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2));
    const normal=await replay(h,spot,config,{modelPath});
    const adverse=await replay(h,spot,config,{modelPath,adverse:true});
    const stress=await replay(h,spot,{...config,feeRate:config.feeRate*1.5,slippageCents:2},{modelPath,adverse:true});
    const small=await replay(h,spot,{...config,startingBalance:30},{modelPath});
    console.log('[Audit] Cost-inclusive scenarios complete');
    const contexts=markets.map(m=>spotContext(spot,asOf(spot,Date.parse(m.open_time)),config.strategy));
    const early=contexts.slice(0,Math.floor(markets.length/3)).filter(Boolean).map(c=>c.sigma).sort((a,b)=>a-b);
    const thresholds=[early[Math.floor(early.length/3)],early[Math.floor(early.length*2/3)]];
    const lookup=new Map(markets.map((m,i)=>[m.ticker,{...m,index:i,context:contexts[i],
      vol:!contexts[i]?'missing':contexts[i].sigma<=thresholds[0]?'low':contexts[i].sigma<=thresholds[1]?'medium':'high',
      trend:contexts[i]?.trend||'missing',third:['oldest','middle','newest'][Math.min(2,Math.floor(i/markets.length*3))]}]));
    const calibration=rows=>({trades:rows.length,meanModelProbability:mean(rows.map(r=>r.details.signal.modelProb)),
      settlementHitRate:mean(rows.map(r=>Number(lookup.get(r.ticker).result===r.details.signal.side))),
      modelSettlementBrier:mean(rows.map(r=>(r.details.signal.modelProb-Number(lookup.get(r.ticker).result===r.details.signal.side))**2)),
      quoteSettlementBrier:mean(rows.map(r=>(r.details.signal.priceDecimal-Number(lookup.get(r.ticker).result===r.details.signal.side))**2))});
    const costs=normal.samples.map(r=>{
      const d=r.details,n=d.contracts,entryFee=d.cost-d.entryPrice*n;
      const exitFee=d.exitType==='SETTLEMENT'?0:d.exitPrice*n-d.payout;
      const quotedAsk=d.signal.side==='yes'?d.context.yesAsk:d.context.noAsk;
      const quotedBid=d.signal.side==='yes'?d.context.yesBid:d.context.noBid;
      const estimatedRoundTripPerContract=(quotedAsk-quotedBid)+config.slippageCents/100+
        (fee(n,quotedAsk,config.feeRate)+fee(n,Math.max(.001,quotedBid-config.slippageCents/100),config.feeRate))/n;
      return {ticker:r.ticker,entryFee,exitFee,fees:entryFee+exitFee,contracts:n,
        exitSlippage:d.exitType==='SETTLEMENT'?0:n*config.slippageCents/100,
        entryPriceChange:n*(d.entryPrice-quotedAsk),estimatedRoundTripPerContract,
        estimatedProbabilityEdge:d.signal.modelProb-quotedAsk,riskFraction:d.cost/(config.startingBalance+normal.samples.slice(0,normal.samples.indexOf(r)).reduce((s,v)=>s+v.pnl,0))};
    });
    const folds=[];
    for(let k=0;k<3;k++) {
      const end=Math.floor(markets.length*(.4+.2*k)),next=Math.floor(markets.length*(.6+.2*k));
      const block=markets.slice(end,next),tickers=new Set(block.map(m=>m.ticker));
      const n=await replay(h,spot,config,{modelPath,tickers});
      const a=await replay(h,spot,config,{modelPath,tickers,adverse:true});
      folds.push({trainMarkets:end,trainLabels:normal.samples.filter(r=>lookup.get(r.ticker).index<end).length,
        testMarkets:block.length,start:block[0].open_time,end:block.at(-1).close_time,
        normal:tradeMetrics(n.samples),adverse:tradeMetrics(a.samples)});
    }
    const pipe=new MLPipeline({modelPath,config:{ML_RESEARCH_ONLY:true}});pipe.extractFeatures({type:'',side:''},{});
    const featureNames=pipe.featureNames;pipe.stop();
    const featureAssociations=featureNames.map((name,i)=>({name,...Object.fromEntries(['oldest','middle','newest'].map(third=>{
      const rows=normal.samples.filter(r=>lookup.get(r.ticker).third===third);
      return [third,association(rows.map(r=>r.features[i]),rows.map(r=>r.label))];
    }))}));
    const sources={strategy:['agents/skills/analysis/signal-generator.js','agents/skills/analysis/trend-analysis.js','bot/trend.js'],
      risk:['agents/skills/trading/risk-manager.js','lib/trading-safety.js'],
      execution:['agents/skills/trading/position-manager.js','bot/order-manager.js'],ml:['lib/ml-pipeline.js']};
    const parameters=Object.fromEntries(Object.entries(sources).map(([group,files])=>[group,[...new Set(files.flatMap(f=>[...fs.readFileSync(path.join(root,f),'utf8').matchAll(/config\.([A-Z][A-Z_0-9]+)/g)].map(m=>m[1])))].sort()]));
    const counts=Object.fromEntries(['markets','trades','candles','stream_events'].map(t=>[t,h.prepare(`SELECT count(*) n FROM ${t}`).get().n]));
    const report={directory:dir,manifest,inventory:{counts,historyBytes:fs.statSync(path.join(root,'data/market-history/history.sqlite')).size,
      start:markets[0].open_time,end:markets.at(-1).close_time,spotCandles:spot.length},parameters,
      uniqueConfigParameters:[...new Set(Object.values(parameters).flat())].length,featureCount:featureNames.length,
      constantFeatures:featureNames.filter((name,i)=>new Set(normal.samples.map(r=>r.features[i])).size<=1),
      normal:performance(normal,markets,spot,config.startingBalance),adverse:performance(adverse,markets,spot,config.startingBalance),
      stress:performance(stress,markets,spot,config.startingBalance),volatilityThresholds:thresholds,
      thirtyDollarAccount:performance(small,markets,spot,30),
      marketRegimes:markets.reduce((counts,m)=>{const r=lookup.get(m.ticker),key=r.vol+'/'+r.trend;counts[key]=(counts[key]||0)+1;return counts;},{}),
      regimes:groups(normal.samples,r=>{const m=lookup.get(r.ticker);return m.vol+'/'+m.trend;}),
      adverseRegimes:groups(adverse.samples,r=>{const m=lookup.get(r.ticker);return m.vol+'/'+m.trend;}),
      thirds:groups(normal.samples,r=>lookup.get(r.ticker).third),exits:groups(normal.samples,r=>r.details.exitType),
      calibration:{all:calibration(normal.samples),...Object.fromEntries(['oldest','middle','newest'].map(k=>[k,calibration(normal.samples.filter(r=>lookup.get(r.ticker).third===k))]))},
      costs:{entryFees:costs.reduce((s,c)=>s+c.entryFee,0),exitFees:costs.reduce((s,c)=>s+c.exitFee,0),
        modeledExitSlippage:costs.reduce((s,c)=>s+c.exitSlippage,0),meanRoundTripCostPerContract:mean(costs.map(c=>c.estimatedRoundTripPerContract)),
        meanEstimatedProbabilityEdge:mean(costs.map(c=>c.estimatedProbabilityEdge)),
        meanRiskFraction:mean(costs.map(c=>c.riskFraction)),maxRiskFraction:Math.max(...costs.map(c=>c.riskFraction)),
        riskOverOnePercent:costs.filter(c=>c.riskFraction>.01).length},folds,featureAssociations};
    fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));
    const flat=normal.samples.map(r=>({ticker:r.ticker,signal_time:new Date(r.ts).toISOString(),exit_time:new Date(r.outcome_ms).toISOString(),
      volatility:lookup.get(r.ticker).vol,trend:lookup.get(r.ticker).trend,side:r.details.signal.side,pnl:r.pnl,cost:r.details.cost,exit:r.details.exitType}));
    const cols=Object.keys(flat[0]||{});
    fs.writeFileSync(path.join(dir,'trades.csv'),[cols.join(','),...flat.map(r=>cols.map(c=>csvCell(r[c])).join(','))].join('\n'));
    fs.writeFileSync(path.join(root,'data/research/latest-audit.json'),JSON.stringify({directory:dir},null,2));
    console.log(JSON.stringify({...report,normal:{...report.normal,daily:undefined,audit:undefined},adverse:{...report.adverse,daily:undefined,audit:undefined},stress:{...report.stress,daily:undefined,audit:undefined},featureAssociations:undefined,manifest:undefined},null,2));
    return report;
  } finally {h.close();ref.close();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={mean,variance,association,tradeMetrics,dailySeries};
