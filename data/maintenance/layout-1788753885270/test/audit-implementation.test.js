const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('events'),fs=require('fs'),os=require('os'),path=require('path');
const Safety=require('../lib/trading-safety'),Risk=require('../agents/skills/trading/risk-manager');
const {fit}=require('../lib/regularized-logistic');
const {Book}=require('../lib/book-execution');
const {Telemetry}=require('../lib/research-telemetry');
function state(){const s=new E();Object.assign(s,{stats:{totalPnL:0},balance:{available:30,total:30,equity:30},pendingOrders:[],openPositions:[],activeMarkets:[],updateIntent(){},saveNow(){s.saved=JSON.parse(JSON.stringify(s.riskState));}});return s;}
test('marked equity drawdown persists across restart, time passing and recovered cash',()=>{
  const s=state();let now=100;const a=new Safety(s,{},()=>now);a.entriesEnabled=true;
  a.observeBalance({total:100,available:100,equity:100});
  a.observeBalance({total:95,available:95,equity:89});assert.equal(s.saved.halted,true);
  const restarted=state();restarted.riskState=s.saved;const b=new Safety(restarted,{},()=>now);b.entriesEnabled=true;
  now+=86400000;b.observeBalance({total:120,available:120,equity:120});assert.equal(b.check().approved,false);
});
test('declared external flows do not become strategy gains and stale equity blocks entries',()=>{
  const s=state();let now=100;const a=new Safety(s,{},()=>now);a.entriesEnabled=true;
  a.observeBalance({total:100,available:100,equity:100});s.riskState.cashFlows=50;
  a.observeBalance({total:150,available:150,equity:150});assert.equal(s.riskState.highWater,100);
  now+=30001;assert.equal(a.check().reason,'equity_snapshot_stale');
});
test('one-percent fee-inclusive cap skips unaffordable whole contract and never rounds up',()=>{
  const s=state();s.safety={check:()=>({approved:true,sizeMultiplier:1})};
  const r=new Risk(),signal={ticker:'BTC',contracts:10,priceDecimal:.56,side:'no'};
  assert.equal(r._checkSignal(signal,s).reason,'one_contract_exceeds_equity_risk_cap');
  s.balance={equity:100,available:100,total:100};const v=r._checkSignal(signal,s);assert.equal(v.contracts,1);assert.ok(v.cost<=1);
});
test('regularized baseline excludes constant features with train-only preprocessing',()=>{
  const rows=Array.from({length:100},(_,i)=>({features:[5,i<50?-1:1],label:Number(i>=50)}));const m=fit(rows);
  assert.deepEqual(m.active,[1]);assert.ok(m.predict([999,1])>.5);assert.ok(m.predict([-999,-1])<.5);assert.deepEqual(m.means,[5,0]);
});
test('depth replay respects limits and partial depth and refuses gaps and stale snapshots',()=>{
  const b=new Book();b.apply({type:'orderbook_snapshot',msg:{yes_dollars_fp:[['0.4','2']],no_dollars_fp:[['0.44','2']]}},1000);
  assert.equal(b.cross('yes',.55,5,1100).filled,0);
  assert.equal(b.cross('yes',.56,5,1100).filled,2);
  assert.equal(b.cross('yes',.56,5,3000).reason,'missing_or_stale_book');
  b.apply({type:'sequence_gap'},1200);assert.equal(b.cross('yes',.56,5,1300).filled,0);
});
test('forecasts retain rejected candidates and settlement labels stay distinct from execution outcomes',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kalshi-telemetry-'));const telemetry=new Telemetry(path.join(dir,'t.sqlite'));
  t.after(()=>{telemetry.close();fs.rmSync(dir,{recursive:true,force:true});});
  telemetry.recordForecast({id:'forecast',ts:1,ticker:'BTC',close_ms:2,p_yes:.75,spot:100,strike:99,yes_bid:.5,yes_ask:.51,sigma:.001,trend:'BULLISH'});
  telemetry.recordEvent('risk_rejection',{forecastId:'forecast',reason:'cap'});
  await telemetry.resolveOne({fetchMarket:async()=>({result:'no'})});
  const row=telemetry.db.prepare('SELECT * FROM forecasts').get();assert.equal(row.result,'no');assert.ok(row.outcome_ms>row.close_ms);
  assert.equal(telemetry.db.prepare('SELECT count(*) n FROM execution_events').get().n,1);
});
