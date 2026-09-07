// Frozen anchored folds. All models remain research-only; no account imports.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),D=require('better-sqlite3');
const {replay}=require('#src/research/history-replay');
const {fit}=require('#src/ml/regularized-logistic');
const {MLPipeline}=require('#src/ml/ml-pipeline');
const {tradeMetrics}=require('./audit-strategy.js');
const root=require('#src/config/paths').root;
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
function metrics(rows,predict) {return {samples:rows.length,brier:mean(rows.map(r=>(predict(r.features)-r.label)**2)),accuracy:mean(rows.map(r=>Number((predict(r.features)>=.5)===Boolean(r.label))))};}
async function main(){
  const h=new D(path.join(root,'data/market-history/history.sqlite'),{readonly:true});
  const s=new D(path.join(root,'data/research/research.sqlite'),{readonly:true});
  try {
    const config=JSON.parse(fs.readFileSync(path.join(root,'config/research/research-config.json')));
    const args=process.argv.slice(2);
    if(args.length && (args.length!==2 || args[0]!=='--policy'))throw Error('Usage: node scripts/walk-forward.js [--policy named-policy.json]');
    const policyPath=path.resolve(root,args[1]||'config/research/research-policy.json');
    const policy=JSON.parse(fs.readFileSync(policyPath));
    if(policy.allowLivePromotion!==false || policy.configSha256!==crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex')) {
      throw Error('Research configuration differs from frozen policy. Retain old trials and declare a new named policy before evaluating changes.');
    }
    const markets=h.prepare("SELECT ticker,open_time,close_time FROM markets WHERE result IN ('yes','no') ORDER BY open_time,ticker").all();
    const spot=s.prepare('SELECT available_ms,close FROM spot_candles ORDER BY available_ms').all();
    const dir=path.join(root,'data/research/walk-forward',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(dir,{recursive:true});
    const manifest={config,policy,policyPath,marketIds:markets.map(m=>m.ticker),schemes:'anchored; initial 40%, step/test 20%; inner last 25% of earlier markets for selection',
      candidates:['training_base_rate','regularized_logistic','existing_stumps'],logistic:{iterations:250,rate:.05,penalty:.1},
      gate:'300 fit outcomes, 30 inner validation outcomes; choose lowest inner-validation Brier; no live promotion',
      limitations:'Previously inspected markets. Predictive model comparison, not a simulation of model-filtered sizing/fills. All strategy P&L shown is fixed-policy with costs.',
      hashes:Object.fromEntries(['src/strategy/exit-policy.js','src/research/history-replay.js','src/ml/ml-pipeline.js','src/ml/regularized-logistic.js','src/agents/skills/analysis/signal-generator.js'].map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]))};
    fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2));
    const index=new Map(markets.map((m,i)=>[m.ticker,i]));
    const full=await replay(h,spot,config,{modelPath:path.join(dir,'unused.json')});
    const folds=[];
    for(let k=0;k<3;k++) {
      const end=Math.floor(markets.length*(.4+.2*k)),next=Math.floor(markets.length*(.6+.2*k)),inner=Math.floor(end*.75);
      const fitBefore=Date.parse(markets[inner].open_time),testBefore=Date.parse(markets[end].open_time);
      const training=full.samples.filter(r=>index.get(r.ticker)<inner&&r.outcome_ms<fitBefore);
      const validation=full.samples.filter(r=>index.get(r.ticker)>=inner&&index.get(r.ticker)<end&&r.outcome_ms<testBefore);
      const test=full.samples.filter(r=>index.get(r.ticker)>=end&&index.get(r.ticker)<next);
      const block=markets.slice(end,next),tickers=new Set(block.map(m=>m.ticker));
      const normal=await replay(h,spot,config,{modelPath:path.join(dir,'unused.json'),tickers});
      const adverse=await replay(h,spot,config,{modelPath:path.join(dir,'unused.json'),tickers,adverse:true});
      const record={training:training.length,validation:validation.length,test:test.length,testStart:block[0].open_time,testEnd:block.at(-1).close_time,
        normal:tradeMetrics(normal.samples),adverse:tradeMetrics(adverse.samples),selected:null};
      if(training.length>=300&&validation.length>=30) {
        const base=mean(training.map(r=>r.label)),linear=fit(training);
        const pipeline=new MLPipeline({modelPath:path.join(dir,`fold-${k}-research-model.json`),db:{getTrainingData:()=>training},config:{ML_RESEARCH_ONLY:true}});
        const trained=await pipeline.train();
        const candidates=[{name:'training_base_rate',predict:()=>base},{name:'regularized_logistic',predict:linear.predict}];
        if(trained)candidates.push({name:'existing_stumps',predict:x=>pipeline.predict(x).confidence});
        const rankings=candidates.map(c=>({...c,validation:metrics(validation,c.predict)})).sort((a,b)=>a.validation.brier-b.validation.brier);
        const selected=rankings[0];
        fs.writeFileSync(path.join(dir,`fold-${k}-selection.json`),JSON.stringify({selected:selected.name,validation:rankings.map(({predict,...r})=>r)},null,2));
        record.selected=selected.name;record.predictiveTest=metrics(test,selected.predict);record.droppedConstantFeatures=training[0].features.length-linear.active.length;
        pipeline.stop();
      } else record.reason='Insufficient independent fit/validation labels; no model trained or selected';
      folds.push(record);
    }
    const result={directory:dir,folds,livePromotion:false};fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{h.close();s.close();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={metrics};
