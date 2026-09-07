// Local diagnostics; --resolve adds read-only demo GETs to label settled forecasts.
const fs=require('fs'),path=require('path'),D=require('better-sqlite3');
const {fit}=require('../lib/regularized-logistic');
const {association}=require('./audit-strategy');
const {asOf}=require('../lib/history-replay');
const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
async function main(){
  const args=process.argv.slice(2);if(args.some(a=>a!=='--resolve'))throw Error('Usage: node scripts/evaluate-telemetry.js [--resolve] (demo only)');
  const root=path.resolve(__dirname,'..'),file=path.join(root,'data/demo/telemetry.sqlite');
  if(!fs.existsSync(file)){console.log('No demo telemetry yet. Restart the updated demo to begin recording.');return;}
  const db=new D(file,{readonly:!args.includes('--resolve')});
  try{
    if(args.includes('--resolve')) {
      const config=require('dotenv').parse(fs.readFileSync(path.join(root,'.env.demo')));
      delete process.env.KALSHI_PRIVATE_KEY_BASE64;config.KALSHI_API_BASE='https://external-api.demo.kalshi.co';
      config.KALSHI_PRIVATE_KEY_PATH=path.resolve(root,config.KALSHI_PRIVATE_KEY_PATH);
      const client=new(require('../bot/kalshi'))(config,{});
      const due=db.prepare('SELECT DISTINCT ticker FROM forecasts WHERE result IS NULL AND close_ms<? LIMIT 200').all(Date.now()-60000);
      for(const {ticker}of due){const m=await client.fetchMarket(ticker);if(['yes','no'].includes(m?.result))db.prepare('UPDATE forecasts SET result=?,outcome_ms=? WHERE ticker=? AND result IS NULL').run(m.result,Date.now(),ticker);}
    }
    const raw=db.prepare('SELECT * FROM forecasts ORDER BY ts,id').all();
    // One earliest decision per contract; repeated scans do not inflate sample size.
    const unique=[...new Map([...raw].reverse().map(r=>[r.ticker,r])).values()].sort((a,b)=>a.ts-b.ts);
    const resolved=unique.filter(r=>r.result).map(r=>({...r,label:Number(r.result==='yes')}));
    const brier=rows=>({markets:rows.length,model:mean(rows.map(r=>(r.p_yes-r.label)**2)),marketMid:mean(rows.map(r=>((r.yes_bid+r.yes_ask)/2-r.label)**2)),constantHalf:rows.length?.25:null});
    const windows=[];for(let i=0;i<resolved.length;i+=30)windows.push({start:resolved[i].ts,...brier(resolved.slice(i,i+30)),insufficient:resolved.slice(i,i+30).length<30});
    const boundary=resolved[Math.floor(resolved.length*.7)]?.ts;
    const training=resolved.filter(r=>r.ts<boundary&&r.outcome_ms<boundary),test=resolved.filter(r=>r.ts>=boundary);
    let calibration={trained:false,reason:'Need 300 resolved prior markets and 100 held-out markets; late-known labels are purged'};
    if(training.length>=300&&test.length>=100){
      const features=r=>[Math.log(Math.max(.001,r.p_yes)/Math.max(.001,1-r.p_yes))];
      const model=fit(training.map(r=>({features:features(r),label:r.label})));
      calibration={trained:true,usage:'research-only',training:training.length,test:test.length,
        rawBrier:brier(test).model,calibratedBrier:mean(test.map(r=>(model.predict(features(r))-r.label)**2)),model:{...model,predict:undefined}};
    }
    const events=db.prepare('SELECT * FROM execution_events ORDER BY ts,id').all().map(r=>({...r,details:JSON.parse(r.details)}));
    const submits=new Map(),acks=new Map(),cancels=new Map(),firstFill=new Map(),terminal=new Map();
    const ackLatency=[],fillLatency=[],cancelLatency=[];
    for(const e of events){const d=e.details,o=d.order;
      if(e.event==='submit')submits.set(d.client_order_id,e.ts);
      if(e.event==='acknowledgment'){const t=submits.get(d.client_order_id);if(t!=null)ackLatency.push(e.ts-t);if(o?.order_id)acks.set(o.order_id,t);}
      if(e.event==='cancel_request')cancels.set(d.orderId,e.ts);
      if(o?.order_id){const id=o.order_id,n=Number(o.fill_count_fp??o.fill_count??0);
        if(n>0&&!firstFill.has(id)){firstFill.set(id,e.ts);if(acks.get(id)!=null)fillLatency.push(e.ts-acks.get(id));}
        if(['executed','canceled','cancelled'].includes(o.status)&&!terminal.has(id)){terminal.set(id,e.ts);if(cancels.has(id))cancelLatency.push(e.ts-cancels.get(id));}
      }
    }
    const dist=a=>{const s=[...a].sort((a,b)=>a-b);return {n:s.length,meanMs:mean(s),p95Ms:s.length?s[Math.floor((s.length-1)*.95)]:null};};
    const equity=db.prepare('SELECT * FROM equity_samples ORDER BY ts').all();
    const exposures=equity.map(r=>{const p=JSON.parse(r.details).positions||[];return {ts:r.ts,signedContracts:p.reduce((s,p)=>s+(p.side==='yes'?1:-1)*Number(p.filledContracts??p.contracts),0)};});
    let factor={n:0,correlation:null,beta:null,reason:'No aligned reference coverage'};
    const refFile=path.join(root,'data/research/research.sqlite');
    if(equity.length&&fs.existsSync(refFile)){
      const ref=new D(refFile,{readonly:true});const spot=ref.prepare('SELECT available_ms,close FROM spot_candles ORDER BY available_ms').all();ref.close();
      const daily=new Map();for(const e of equity){const day=Math.floor(e.ts/86400000);if(!daily.has(day))daily.set(day,{first:e,last:e});else daily.get(day).last=e;}
      const pairs=[...daily.values()].filter(d=>d.last.ts-d.first.ts>23*3600000&&JSON.parse(d.first.details).cashFlows===JSON.parse(d.last.details).cashFlows&&d.first.equity>0).map(d=>{const a=asOf(spot,d.first.ts),b=asOf(spot,d.last.ts);return a>=0&&b>=0&&d.first.ts-spot[a].available_ms<60000&&d.last.ts-spot[b].available_ms<60000?[spot[b].close/spot[a].close-1,d.last.equity/d.first.equity-1]:null;}).filter(Boolean);
      factor={...association(pairs.map(p=>p[0]),pairs.map(p=>p[1])),limitation:'Near-full-day marked equity intervals; days with declared external flows excluded. Undeclared transfers cannot be corrected automatically.'};
    }
    const early=resolved.slice(0,300).map(r=>r.sigma).sort((a,b)=>a-b),cuts=early.length>=300?[early[100],early[200]]:null;
    const regimes={};if(cuts)for(const r of resolved.slice(300)){const key=(r.sigma<=cuts[0]?'low':r.sigma<=cuts[1]?'medium':'high')+'/'+r.trend;(regimes[key]||=[]).push(r);}
    const recent=windows.slice(-3),decayAlert=recent.length===3&&recent.every(w=>w.markets>=30&&w.model>w.marketMid);
    const result={rawForecasts:raw.length,independentMarkets:unique.length,resolvedMarkets:resolved.length,calibration:brier(resolved),windows,
      regimeThresholds:cuts,regimes:Object.fromEntries(Object.entries(regimes).map(([k,v])=>[k,brier(v)])),
      decayAlert:{active:decayAlert,rule:'Three disjoint 30-market blocks worse than market-mid Brier; diagnostic only, not proof of decay'},
      researchCalibration:calibration,execution:{ack:dist(ackLatency),firstObservedFill:dist(fillLatency),cancelToObservedTerminal:dist(cancelLatency),
        limitation:'Polling timestamps bound observation latency; they are not matching-engine event times. Zero fills does not establish execution quality.'},
      exposure:{samples:exposures.length,maxAbsoluteSignedContracts:Math.max(0,...exposures.map(e=>Math.abs(e.signedContracts))),factor},
      futureDataRequired:resolved.length<400,livePromotion:false};
    const out=path.join(root,'data/demo/telemetry-report.json');fs.writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{db.close();}
}
if(require.main===module)main().catch(e=>{console.error(e.response?.data?.error?.message||e.message);process.exitCode=1;});
