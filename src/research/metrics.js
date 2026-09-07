const { asOf } = require('#src/research/history-replay');
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

module.exports = { mean, variance, association, tradeMetrics, groups, dailySeries, performance };
