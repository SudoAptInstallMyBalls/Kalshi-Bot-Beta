const {test}=require('node:test'),assert=require('node:assert/strict');
const {snapLimit}=require('#src/execution/price-grid');
const Client=require('#src/exchange/kalshi-client');
test('dynamic grid snaps both book sides without worsening their limit',()=>{
  const grid=[{start:'0',end:'0.1',step:'0.001'},{start:'0.1',end:'0.9',step:'0.01'},{start:'0.9',end:'1',step:'0.001'}];
  assert.equal(snapLimit(.563,'ask',grid),.57);
  assert.equal(snapLimit(.563,'bid',grid),.56);
  assert.equal(snapLimit(.072,'ask',grid),.072);
  assert.equal(snapLimit(.01,'ask',grid),.01);
  assert.throws(()=>snapLimit(NaN,'ask',grid));
});
test('exits use IOC and fresh quotes, retain reduce-only and preserve the worst permitted price',async()=>{
  const client=new Client({},{}),sent=[];
  client.checkAuthentication=()=>{};
  let bid=.70,ask=.72;
  client.fetchMarket=async()=>({exchangeIndex:2,yesBid:bid,yesAsk:ask,priceRanges:[{start:'0',end:'1',step:'0.01'}]});
  client.post=async(_,body)=>{sent.push(body);return {data:{order_id:'exit'}};};
  await client.sellPosition('BTC','yes',1,68);
  assert.equal(sent.at(-1).price,'0.7000');
  bid=.65;await client.sellPosition('BTC','yes',1,68);
  assert.equal(sent.at(-1).price,'0.6800');
  ask=.72;await client.sellPosition('BTC','no',1,27);
  assert.equal(sent.at(-1).price,'0.7200');
  ask=.80;await client.sellPosition('BTC','no',1,27);
  assert.equal(sent.at(-1).price,'0.7300');
  for(const order of sent){assert.equal(order.time_in_force,'immediate_or_cancel');assert.equal(order.reduce_only,true);assert.equal(order.exchange_index,2);}
});
