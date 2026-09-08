// Resumable, isolated five-asset exploratory history. BTC forward files untouched.
const fs = require('fs');
const path = require('path');
const { HistoryStore, PublicHistoryClient } = require('../../src/research/market-history');
const { openResearch } = require('./spot');
const { downloadCoinbaseSpot } = require('./coinbase-spot');
const root = path.resolve(__dirname, '../../data/research/multi-asset');
const assets = ['BTC','ETH','SOL','XRP','DOGE'];
function complete(h, m) {
  const rows = h.db.prepare('SELECT end_period_ts FROM candles WHERE ticker=? AND period_minutes=1 ORDER BY end_period_ts').all(m.ticker);
  return rows.length === 15 && rows.every((r,i) => r.end_period_ts * 1000 === Date.parse(m.open_time) + (i+1)*60000);
}
async function run() {
  if (process.argv.length > 2) throw Error('Usage: node scripts/multi-asset/backfill.js');
  fs.mkdirSync(root, { recursive: true });
  const requestFile = path.join(root, 'backfill-request.json');
  if (!fs.existsSync(requestFile)) {
    const to = Math.floor((Date.now()-120000)/900000)*900000;
    fs.writeFileSync(requestFile, JSON.stringify({ from: to-60*86400000, to, days:60, assets }, null, 2), { flag:'wx' });
  }
  const range = JSON.parse(fs.readFileSync(requestFile));
  if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.to <= range.from || range.to-range.from>90*86400000) throw Error('Invalid saved range');
  const client = new PublicHistoryClient();
  const reports = [];
  for (const asset of assets) {
    const dir = path.join(root, asset); fs.mkdirSync(dir,{recursive:true});
    const h = new HistoryStore(path.join(dir,'history.sqlite')); let spot;
    try {
      const series = `KX${asset}15M`;
      const metadata = await client.get(`/series/${series}`);
      fs.writeFileSync(path.join(dir,'series.json'),JSON.stringify({ fetchedAt:new Date().toISOString(),...metadata},null,2));
      const markets = new Map();
      for (const source of ['live','historical']) {
        for await (const page of client.pages(source==='live'?'/markets':'/historical/markets','markets',{
          series_ticker:series,min_close_ts:range.from/1000,max_close_ts:range.to/1000,
          ...(source==='live'?{status:'settled'}:{})
        })) for (const m of page) {
          const open=Date.parse(m.open_time), close=Date.parse(m.close_time);
          if (!m.ticker?.startsWith(series+'-') || !['yes','no'].includes(m.result) || open<range.from || close>range.to || close-open!==900000 || markets.has(m.ticker)) continue;
          h.market(m,source);markets.set(m.ticker,{...m,source});
        }
      }
      if (!markets.size) throw Error('No settled markets returned');
      const pending = [...markets.values()].filter(m=>!complete(h,m)).sort((a,b)=>Date.parse(a.open_time)-Date.parse(b.open_time));
      const live = pending.filter(m=>m.source==='live');
      console.log(`${asset}: ${markets.size} markets; ${pending.length} need candles`);
      for (let i=0;i<live.length;) {
        const batch=live.slice(i,i+20);
        while(batch.length>1 && batch.length*(Date.parse(batch.at(-1).close_time)-Date.parse(batch[0].open_time))/60000>9500) batch.pop();
        const allowed=new Map(batch.map(m=>[m.ticker,m]));
        const result=await client.get('/markets/candlesticks',{
          market_tickers:batch.map(m=>m.ticker).join(','),start_ts:Math.min(...batch.map(m=>Date.parse(m.open_time)))/1000,
          end_ts:Math.max(...batch.map(m=>Date.parse(m.close_time)))/1000,period_interval:1
        });
        if (!Array.isArray(result.markets)) throw Error('Missing batch markets');
        for (const row of result.markets) {
          const m=allowed.get(row.market_ticker);
          if (!m || !Array.isArray(row.candlesticks)) throw Error('Unexpected batch market');
          h.candles(m.ticker,row.candlesticks.filter(c=>c.end_period_ts*1000>Date.parse(m.open_time) && c.end_period_ts*1000<=Date.parse(m.close_time)),'live');
        }
        i+=batch.length;
        if(i%500<batch.length || i===live.length) console.log(`${asset}: candle batch ${Math.min(i+20,live.length)}/${live.length}`);
      }
      // Older data uses a distinct endpoint; also retry incomplete batch results.
      for (const m of pending.filter(m=>!complete(h,m))) {
        const endpoint=m.source==='historical'?`/historical/markets/${m.ticker}/candlesticks`:`/series/${series}/markets/${m.ticker}/candlesticks`;
        const r=await client.get(endpoint,{start_ts:Date.parse(m.open_time)/1000,end_ts:Date.parse(m.close_time)/1000,period_interval:1});
        if(!Array.isArray(r.candlesticks)) throw Error('Missing candles');
        h.candles(m.ticker,r.candlesticks.filter(c=>c.end_period_ts*1000>Date.parse(m.open_time)&&c.end_period_ts*1000<=Date.parse(m.close_time)),m.source);
      }
      // Keep the old Binance exploratory DB for reproducibility; Coinbase gets
      // a separate database so a failed network run cannot destroy prior data.
      spot=openResearch(path.join(dir,'spot-coinbase.sqlite'));
      const reference=await downloadCoinbaseSpot(spot,range.from-3*3600000,range.to,{product:asset+'-USD',log:message=>console.log(`${asset}: ${message}`)});
      const incomplete=[...markets.values()].filter(m=>!complete(h,m)).map(m=>m.ticker);
      const report={asset,completedAt:new Date().toISOString(),from:new Date(range.from).toISOString(),to:new Date(range.to).toISOString(),
        markets:markets.size,expectedSlots:(range.to-range.from)/900000,complete:markets.size-incomplete.length,incomplete,reference};
      fs.writeFileSync(path.join(dir,'backfill.json'),JSON.stringify(report,null,2));reports.push(report);console.log(JSON.stringify(report));
    } catch(e) {const message=e?.stack||e?.message||String(e);reports.push({asset,error:message});console.error(`${asset}: ${message}`);}
    finally {spot?.close();h.close();}
  }
  fs.writeFileSync(path.join(root,'backfill-summary.json'),JSON.stringify(reports,null,2));
  // Missing Kalshi candle slots are recorded in the summary and excluded from
  // the corresponding asset's replay. They are expected for a historical
  // backfill and should not make the command look like Coinbase failed.
  if(reports.some(r=>r.error)) throw Error('One or more asset downloads failed; see backfill-summary.json');
}
if(require.main===module)run().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={complete};
