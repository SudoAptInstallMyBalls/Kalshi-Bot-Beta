const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {CoinbaseBook}=require('../src/research/coinbase-book');
const {CoinbaseRecorder}=require('../src/research/coinbase-recorder');
const {CandidateReference}=require('../src/research/candidate-reference');
const {ProxyReference}=require('../src/research/proxy-reference');
const {verify}=require('../src/research/forward-study');
test('Coinbase book applies size replacements and removals and resets on resnapshot',()=>{
 const book=new CoinbaseBook();
 book.apply({type:'snapshot',product_id:'BTC-USD',bids:[['100','2'],['99','3']],asks:[['101','2']]},1000);
 assert.equal(book.quote().price,100.5);
 book.apply({type:'l2update',product_id:'BTC-USD',time:new Date(2000).toISOString(),changes:[['buy','100','0'],['sell','101','4']]},2001);
 assert.equal(book.quote().bid,99);assert.equal(book.asks.get(101),4);
 book.reset();assert.equal(book.quote(),null);
 assert.throws(()=>book.apply({type:'snapshot',product_id:'BTC-USD',bids:[['bad','2']],asks:[]},1000),/Invalid/);
});
test('book records independently of quiet ticker, keeps sources separate and rejects stale data',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coinbase-test-'));const rec=new CoinbaseRecorder(path.join(dir,'feed.sqlite'));
 try{
 rec.recordBook({type:'snapshot',product_id:'BTC-USD',bids:[['100','2']],asks:[['101','2']]},1000);
 rec.recordBook({type:'l2update',product_id:'BTC-USD',time:new Date(2000).toISOString(),changes:[['buy','100','3']]},2001);
 assert.equal(rec.db.prepare('select count(*) n from proxy_quotes').get().n,2);
 assert.equal(rec.db.prepare('select count(*) n from proxy_ticks').get().n,0);
 assert.equal(rec.db.prepare('select source from proxy_quotes limit 1').get().source,'coinbase:BTC-USD:book-midpoint');
 rec.recordBook({type:'l2update',product_id:'BTC-USD',time:new Date(3000).toISOString(),changes:[]},10000);
 assert.equal(rec.db.prepare('select count(*) n from proxy_quotes').get().n,2);
 const ticker={type:'ticker',product_id:'BTC-USD',price:'100',best_bid:'99',best_ask:'101',time:new Date(12000).toISOString()};
 assert.equal(rec.record(ticker,11000),false);assert.equal(rec.counts.future_ticker_time,1);
 }finally{rec.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
test('original study hashes remain unchanged and experimental default matches frozen proxy',()=>{
 assert.equal(verify().cutoff,'2026-09-07T00:15:00Z');
 const spot=Array.from({length:100},(_,i)=>({available_ms:(i+1)*60000,close:100+Math.sin(i)}));
 const m={ticker:'KXBTC15M-X',openTime:70*60000,closeTime:85*60000};
 const old=new ProxyReference([],spot),candidate=new CandidateReference([],spot);
 assert.deepEqual(candidate.getForecast(m,100,71*60000,{requireCalibration:false}),old.getForecast(m,100,71*60000,{requireCalibration:false}));
 const wide=new CandidateReference([],spot,{volatilityReturns:60});assert.equal(wide.getForecast(m,100,71*60000,{requireCalibration:false}).ready,true);
});
