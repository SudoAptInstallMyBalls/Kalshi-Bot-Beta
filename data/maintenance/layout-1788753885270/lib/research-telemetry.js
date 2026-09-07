const D = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
class Telemetry {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new D(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS forecasts(id TEXT PRIMARY KEY,ts INTEGER,ticker TEXT,close_ms INTEGER,p_yes REAL,spot REAL,strike REAL,yes_bid REAL,yes_ask REAL,sigma REAL,trend TEXT,result TEXT,outcome_ms INTEGER);
      CREATE TABLE IF NOT EXISTS execution_events(id INTEGER PRIMARY KEY,ts INTEGER,event TEXT,details TEXT);
      CREATE TABLE IF NOT EXISTS equity_samples(ts INTEGER PRIMARY KEY,equity REAL,cash REAL,details TEXT);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS resolution_checks(ticker TEXT PRIMARY KEY,next_poll INTEGER)');
    this.forecast = this.db.prepare('INSERT OR IGNORE INTO forecasts VALUES (@id,@ts,@ticker,@close_ms,@p_yes,@spot,@strike,@yes_bid,@yes_ask,@sigma,@trend,NULL,NULL)');
    this.event = this.db.prepare('INSERT INTO execution_events(ts,event,details) VALUES (?,?,?)');
    this.equity = this.db.prepare('INSERT OR REPLACE INTO equity_samples VALUES (?,?,?,?)');
  }
  recordForecast(row) { this.forecast.run(row); }
  recordEvent(event,details) { this.event.run(Date.now(),event,JSON.stringify(details)); }
  recordEquity(balance,positions,risk) { this.equity.run(Date.now(),balance.equity,balance.available,JSON.stringify({positions,exchangeBalances:balance.exchangeBalances,cashFlows:risk?.cashFlows||0})); }
  async resolveOne(client) {
    const now=Date.now();
    const row=this.db.prepare('SELECT DISTINCT f.ticker FROM forecasts f LEFT JOIN resolution_checks c ON f.ticker=c.ticker WHERE f.result IS NULL AND f.close_ms<? AND (c.next_poll IS NULL OR c.next_poll<?) ORDER BY f.close_ms LIMIT 1').get(now-60000,now);
    if(!row)return;
    this.db.prepare('INSERT OR REPLACE INTO resolution_checks VALUES (?,?)').run(row.ticker,now+300000);
    const market=await client.fetchMarket(row.ticker);
    if(['yes','no'].includes(market?.result)) this.db.prepare('UPDATE forecasts SET result=?,outcome_ms=? WHERE ticker=? AND result IS NULL').run(market.result,Date.now(),row.ticker);
  }
  close() {this.db.close();}
}
let instance;
function telemetry() {
  return instance ||= new Telemetry(path.join(process.env.BOT_DATA_DIR || path.join(__dirname,'../data'),'telemetry.sqlite'));
}
// Diagnostics never turn a successful exchange response into a failed submission.
function record(method,...args) {
  try {telemetry()[method](...args);} catch(e) {console.error('[Telemetry] Recording failed:',e.message);}
}
async function resolveOne(client){try{await telemetry().resolveOne(client);}catch(e){console.error('[Telemetry] Settlement lookup failed:',e.message);}}
module.exports={Telemetry,record,resolveOne};
