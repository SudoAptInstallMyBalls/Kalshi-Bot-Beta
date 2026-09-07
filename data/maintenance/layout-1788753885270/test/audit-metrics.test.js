const { test } = require('node:test');
const assert = require('node:assert/strict');
const { association,tradeMetrics,dailySeries } = require('../scripts/audit-strategy');
test('audit profit factor and beta match known values without inventing zero-variance estimates',()=>{
  const m=tradeMetrics([{pnl:2},{pnl:-1},{pnl:0}]);
  assert.equal(m.profitFactor,2);assert.equal(m.pnl,1);assert.equal(m.winRate,1/3);
  const a=association([1,2,3],[2,4,6]);assert.equal(a.beta,2);assert.equal(a.correlation,1);
  assert.equal(association([1,1,1],[2,3,4]).correlation,null);
});
test('daily audit includes flat days, aligns returns and labels incomplete boundary days',()=>{
  const day=86400000;
  const markets=[{open_time:new Date(day/2).toISOString(),close_time:new Date(day*3.5).toISOString()}];
  const spot=Array.from({length:5},(_,i)=>({available_ms:day*i,close:100+i}));
  const rows=[{outcome_ms:day*1.5,pnl:10},{outcome_ms:day*3.2,pnl:-11}];
  const ds=dailySeries(rows,markets,spot,100);
  assert.deepEqual(ds.map(x=>x.fullDay),[false,true,true,false]);
  assert.equal(ds[1].return,.1);assert.equal(ds[2].return,0);assert.equal(ds[3].return,-.1);
});
