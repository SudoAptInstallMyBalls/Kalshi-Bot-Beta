// Replays recorded demo submissions against captured demo depth at arrival.
// Passive fills are unknown: report them as unfilled, never fabricate a queue.
const fs=require('fs'),path=require('path'),D=require('better-sqlite3');
const {Book}=require('#src/execution/book-execution');
function main(){
  const root=require('#src/config/paths').root,telemetry=path.join(root,'data/demo/telemetry.sqlite'),history=path.join(root,'data/demo/recording/history.sqlite');
  if(!fs.existsSync(telemetry)||!fs.existsSync(history)){console.log('Insufficient recorded telemetry/book data. No fills inferred.');return;}
  const t=new D(telemetry,{readonly:true}),h=new D(history,{readonly:true});
  try{
    if(JSON.parse(h.prepare('SELECT value FROM metadata WHERE key=?').get('recording_environment')?.value||'null')!=='demo')throw Error('Verified demo recording metadata required');
    const events=t.prepare('SELECT * FROM execution_events ORDER BY ts,id').all().map(e=>({...e,details:JSON.parse(e.details)}));
    const submits=events.filter(e=>e.event==='submit'&&!e.details.reduce_only);
    const timings=events.filter(e=>e.event==='acknowledgment').map(a=>{const s=submits.find(s=>s.details.client_order_id===a.details.client_order_id);return s?a.ts-s.ts:null;}).filter(v=>v!==null).sort((a,b)=>a-b);
    if(timings.length<20){console.log('Need 20 observed acknowledgments to freeze an empirical latency stress assumption. No simulated fills reported.');return;}
    const delay=timings[Math.floor((timings.length-1)*.95)],rows=[];
    const query=h.prepare('SELECT * FROM stream_events WHERE received_ms>=? AND received_ms<=? AND (ticker=? OR ticker IS NULL) ORDER BY received_ms,id');
    for(const s of submits){
      const arrival=s.ts+delay,deadline=s.ts+30000,book=new Book();
      for(const e of query.iterate(s.ts-60000,arrival,s.details.ticker))book.apply(JSON.parse(e.raw_json),e.received_ms);
      const side=s.details.side==='bid'?'yes':'no',limit=side==='yes'?Number(s.details.price):1-Number(s.details.price);
      const fill=arrival>deadline?{filled:0,reason:'arrival_after_timeout'}:book.cross(side,limit,Number(s.details.count),arrival);
      rows.push({clientOrderId:s.details.client_order_id,ticker:s.details.ticker,arrival,deadline,...fill});
    }
    const report={latencyAssumptionMs:delay,latencySamples:timings.length,timeoutMs:30000,rows,
      limitations:'Independent entry diagnostics; acknowledgment p95 conservatively proxies arrival. Crossing depth only; passive queue fills unknown. Per-order estimated fees; no profitability or full portfolio claim.'};
    fs.writeFileSync(path.join(root,'data/demo/execution-replay.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }finally{t.close();h.close();}
}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
