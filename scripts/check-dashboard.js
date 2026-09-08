// Offline ES-module integration smoke check. No browser, network or exchange orders.
// Run: node --experimental-vm-modules scripts/check-dashboard.js
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {publicDir}=require('#src/config/paths');
async function main() {
  const nodes=new Map(),handlers={};
  const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',innerHTML:'',style:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},getContext(){return {};}});return nodes.get(id);};
  const storage={getItem(){return null;},setItem(){}};
  const context=vm.createContext({console,performance,document:{getElementById:node},localStorage:storage,sessionStorage:storage,
    window:{prompt:()=>''},setInterval(){},io:()=>({on:(name,fn)=>{handlers[name]=fn;}}),
    Chart:class {constructor(_,options){this.data=options.data;}update(){}},
    fetch(){throw Error('Unexpected network request');}});
  const modules=new Map();
  function load(file) {
    if(!modules.has(file))modules.set(file,new vm.SourceTextModule(fs.readFileSync(file,'utf8'),{context,identifier:file}));
    return modules.get(file);
  }
  const app=load(path.join(publicDir,'js/app.js'));
  await app.link((specifier,from)=>load(path.resolve(path.dirname(from.identifier),specifier)));
  await app.evaluate();
  handlers.snapshot({environment:'demo',connections:{},btcPrice:{binance:80000},balance:{total:59.4,available:59.4},
    activeMarkets:[{ticker:'BTC',yesAsk:.45,noAsk:.45}],openPositions:[],tradeLog:[],pnlHistory:[],stats:{},model:{},intent:{status:'scanning',action:null}});
  assert.equal(node('balance-value').textContent,'$59.40');
  assert.equal(node('bot-status').textContent,'SCANNING');
  assert.equal(node('intent-action').textContent,'--');
  const table=node('markets-body').innerHTML;
  assert.match(table,/paired-leg arbitrage is not supported/);
  assert.doesNotMatch(table,/<td class="positive">90¢/);
  handlers['bot:status']({running:true});
  assert.equal(node('toggle-label').textContent,'STOP');
  handlers['bot:status']({running:false});
  assert.equal(node('toggle-label').textContent,'START');
  console.log(`Dashboard: ${modules.size} modules linked; snapshot, market display and bot status handlers passed.`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
