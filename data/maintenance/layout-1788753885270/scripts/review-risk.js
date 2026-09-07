// Explicit operator action with the server stopped. Never transfers account funds.
const fs=require('fs'),path=require('path');
const {requireStopped}=require('./repair-demo-submission');
async function main(){
  const args=process.argv.slice(2),opts={};
  for(let i=0;i<args.length;i+=2){if(!['--env','--cash-flow','--reset-reason'].includes(args[i])||!args[i+1])throw Error('Use --env .env.demo with --cash-flow AMOUNT or --reset-reason REASON');opts[args[i].slice(2)]=args[i+1];}
  const env=path.resolve(opts.env||'.env.demo'),demo=path.basename(env)==='.env.demo';
  if(!demo&&path.basename(env)!=='.env')throw Error('Use .env.demo or .env');
  const cfg=require('dotenv').parse(fs.readFileSync(env));await requireStopped(Number(cfg.PORT||(demo?3334:3333)));
  const file=path.join(path.dirname(env),demo?'data/demo/state.json':'data/state.json'),original=fs.readFileSync(file,'utf8'),state=JSON.parse(original);
  if(state.pendingOrders?.length||state.openPositions?.length)throw Error('Reconcile all orders/positions before changing risk baseline');
  const r=state.riskState;if(!r||!Number.isFinite(r.equity))throw Error('No persisted equity baseline');
  if(opts['cash-flow']!==undefined){const amount=Number(opts['cash-flow']);if(!Number.isFinite(amount)||amount===0)throw Error('Invalid signed cash flow');r.cashFlows+=amount;}
  else if(opts['reset-reason']?.trim().length>=10){r.halted=false;r.highWater=r.equity-r.cashFlows;r.drawdown=0;r.resetReason=opts['reset-reason'];}
  else throw Error('Supply signed external cash flow or a reset reason of at least 10 characters');
  fs.writeFileSync(file+`.risk-backup-${Date.now()}`,original,{flag:'wx'});
  fs.appendFileSync(file+'.risk-review.jsonl',JSON.stringify({ts:Date.now(),action:opts})+'\n');
  fs.writeFileSync(file+'.review.tmp',JSON.stringify(state,null,2));fs.renameSync(file+'.review.tmp',file);console.log('Risk review saved. No account requests or automatic restart.');
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
