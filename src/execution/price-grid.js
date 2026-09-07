// Prices are YES-book dollars. Never relax the caller's limit when snapping.
function snapLimit(price, side, ranges) {
  if (!['bid','ask'].includes(side) || !Number.isFinite(price) || price <= 0 || price >= 1) throw Error('Invalid order limit');
  if (!Array.isArray(ranges) || !ranges.length) return price;
  const target = price * 10000, candidates = [];
  for (const band of ranges) {
    const start = Math.round(Number(band.start)*10000), end = Math.round(Number(band.end)*10000), step = Math.round(Number(band.step)*10000);
    if (![start,end,step].every(Number.isFinite) || step<=0 || start<0 || end>10000 || start>=end) throw Error('Invalid market price grid');
    const n = side==='bid' ? Math.floor((Math.min(target,end)-start)/step+1e-8) : Math.ceil((Math.max(target,start)-start)/step-1e-8);
    const value = start+n*step;
    if(value>0&&value<10000&&value>=start&&value<=end&&(side==='bid'?value<=target+1e-8:value>=target-1e-8))candidates.push(value);
  }
  if(!candidates.length)throw Error('No valid tick within order limit');
  return (side==='bid'?Math.max(...candidates):Math.min(...candidates))/10000;
}
module.exports={snapLimit};
