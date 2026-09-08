// Train-only isotonic calibration. PAVA never reads validation/test labels.
function fitIsotonic(rows,key='proxyAverage') {
  const sorted=rows.filter(r=>Number.isFinite(r[key])&&Number.isFinite(r.y)).sort((a,b)=>a[key]-b[key]);
  const blocks=[];
  for(const r of sorted){const b={lo:r[key],hi:r[key],n:1,sum:r.y};blocks.push(b);while(blocks.length>1){const a=blocks.at(-2),c=blocks.at(-1);if(a.sum/a.n<=c.sum/c.n)break;blocks.splice(-2,2,{lo:a.lo,hi:c.hi,n:a.n+c.n,sum:a.sum+c.sum});}}
  return {n:sorted.length,blocks,apply:p=>{if(!Number.isFinite(p)||!blocks.length)return null;const b=blocks.find(x=>p<=x.hi)||blocks.at(-1);return b.sum/b.n;}};
}
function calibrationSummary(rows,rawKey='proxyAverage',calibratedKey='calibrated') {const x=rows.filter(r=>Number.isFinite(r[calibratedKey]));const mean=f=>x.length?x.reduce((s,r)=>s+f(r),0)/x.length:null;return{n:x.length,brier:mean(r=>(r[calibratedKey]-r.y)**2),logLoss:mean(r=>{const p=Math.max(1e-9,Math.min(1-1e-9,r[calibratedKey]));return-r.y*Math.log(p)-(1-r.y)*Math.log(1-p)}),rawBrier:mean(r=>(r[rawKey]-r.y)**2)};}
module.exports={fitIsotonic,calibrationSummary};
