// Train-only preprocessing. Constant columns are excluded from fitting.
function fit(rows, {iterations=250,rate=.05,penalty=.1}={}) {
  if(!rows.length) throw Error('No training rows');
  const n=rows[0].features.length;
  const means=Array.from({length:n},(_,j)=>rows.reduce((s,r)=>s+r.features[j],0)/rows.length);
  const stds=means.map((m,j)=>Math.sqrt(rows.reduce((s,r)=>s+(r.features[j]-m)**2,0)/rows.length));
  const active=stds.map((s,j)=>s>1e-10?j:null).filter(j=>j!==null);
  const weights=active.map(()=>0);let intercept=0;
  const X=rows.map(r=>active.map(j=>(r.features[j]-means[j])/stds[j]));
  const sigmoid=x=>1/(1+Math.exp(-Math.max(-35,Math.min(35,x))));
  for(let t=0;t<iterations;t++) {
    const errors=rows.map((r,i)=>sigmoid(intercept+weights.reduce((s,w,j)=>s+w*X[i][j],0))-r.label);
    intercept-=rate*errors.reduce((a,b)=>a+b,0)/rows.length;
    for(let j=0;j<weights.length;j++) weights[j]-=rate*(errors.reduce((s,e,i)=>s+e*X[i][j],0)/rows.length+penalty*weights[j]);
  }
  return {active,means,stds,weights,intercept,predict:features=>sigmoid(intercept+weights.reduce((s,w,i)=>s+w*(features[active[i]]-means[active[i]])/stds[active[i]],0))};
}
module.exports={fit};
