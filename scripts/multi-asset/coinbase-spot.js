// Public Coinbase Exchange candles. This replaces Binance as the historical
// spot proxy for the multi-asset experiment. It is still not the CF Benchmarks
// settlement index.
const axios = require('axios');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PRODUCTS = new Set(['BTC-USD','ETH-USD','SOL-USD','XRP-USD','DOGE-USD']);
function normalize(row) {
  if (!Array.isArray(row) || row.length < 5) throw Error('Invalid Coinbase candle');
  const openMs=Number(row[0])*1000, close=Number(row[4]);
  if (!Number.isSafeInteger(openMs) || openMs%60000!==0 || !Number.isFinite(close) || close<=0) throw Error('Invalid Coinbase candle values');
  return {open_ms:openMs, available_ms:openMs+60000, close, raw:JSON.stringify(row)};
}
async function downloadCoinbaseSpot(db, from, to, { product, request=axios.get, pause=sleep, log=()=>{} }={}) {
  if (!PRODUCTS.has(product)) throw Error('Unsupported Coinbase product');
  const start=Math.floor(from/60000)*60000, end=Math.floor(to/60000)*60000;
  if (!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=end) throw Error('Invalid Coinbase spot range');
  const count=db.prepare('SELECT count(*) n FROM spot_candles WHERE open_ms>=? AND open_ms<?');
  const insert=db.prepare('INSERT OR REPLACE INTO spot_candles VALUES (?,?,?,?,?)'); let downloaded=0;
  // Coinbase limits candles requests to 300 minutes. Keep requests disjoint.
  for(let cursor=start;cursor<end;cursor+=300*60000){const stop=Math.min(end,cursor+300*60000);if(count.get(cursor,stop).n===(stop-cursor)/60000)continue;
    let response;for(let attempt=0;;attempt++){try{response=await request(`https://api.exchange.coinbase.com/products/${product}/candles`,{params:{granularity:60,start:new Date(cursor).toISOString(),end:new Date(stop).toISOString()},timeout:30000});break;}catch(e){if(attempt>=5)throw e;await pause(Math.min(60000,500*2**attempt));}}
    if(!Array.isArray(response.data))throw Error('Expected Coinbase candle array');
    db.transaction(()=>{for(const raw of response.data){const r=normalize(raw);
      // Coinbase may include an adjacent boundary candle. Ignore it; the
      // exact contiguous-coverage check below is the authority on completeness.
      if(r.open_ms<cursor||r.available_ms>stop)continue;
      insert.run(r.open_ms,r.available_ms,r.close,`coinbase:${product}:1m`,r.raw);downloaded++;}})();log(`[Reference] ${downloaded} ${product} Coinbase candles downloaded`);await pause(150);
  }
  const stored=count.get(start,end).n,expected=(end-start)/60000;
  // Coinbase omits minutes with no exchange candle. Preserve those gaps and
  // let the replay decide whether a particular market has enough observations.
  return{stored,expected,gaps:expected-stored,downloaded,from:start,to:end,source:`coinbase:${product}:1m`};
}
module.exports={normalize,downloadCoinbaseSpot,PRODUCTS};
