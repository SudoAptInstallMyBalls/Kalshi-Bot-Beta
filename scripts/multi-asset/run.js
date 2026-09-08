// Public data collection only. No credentials or order APIs.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Database = require('better-sqlite3');
const { HistoryStore, PublicHistoryClient } = require('../../src/research/market-history');
const { openResearch, downloadSpot } = require('./spot');
const { CoinbaseRecorder } = require('./coinbase-recorder');
const assets = ['ETH', 'SOL', 'XRP', 'DOGE'];
const root = path.resolve(__dirname, '../../data/research/multi-asset');
const directory = asset => path.join(root, asset);
function options(args) {
  const [command, ...rest] = args;
  if (!['download', 'record', 'status'].includes(command)) throw Error('Usage: node scripts/multi-asset/run.js download [--days 7] | record | status');
  let days = 7;
  if (rest.length) {
    if (command !== 'download' || rest.length !== 2 || rest[0] !== '--days') throw Error('Only download accepts --days');
    days = Number(rest[1]);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw Error('Days must be 1–90');
  }
  return { command, days };
}
async function download(asset, days, client = new PublicHistoryClient()) {
  const dir = directory(asset), series = `KX${asset}15M`;
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now(), from = now - days * 86400000;
  const metadata = await client.get(`/series/${series}`);
  if (metadata.series?.ticker !== series || metadata.series.frequency !== 'fifteen_min') throw Error('Unexpected series metadata');
  fs.writeFileSync(path.join(dir, 'series.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), ...metadata }, null, 2));
  const h = new HistoryStore(path.join(dir, 'history.sqlite'));
  let spot, selected = 0, complete = 0;
  const seen = new Set();
  try {
    for (const source of ['live', 'historical']) {
      for await (const page of client.pages(source === 'live' ? '/markets' : '/historical/markets', 'markets', {
        series_ticker: series, min_close_ts: Math.floor(from / 1000), max_close_ts: Math.floor((now - 120000) / 1000),
        ...(source === 'live' ? { status: 'settled' } : {})
      })) {
        for (const m of page) {
          const open = Date.parse(m.open_time), close = Date.parse(m.close_time);
          if (!m.ticker?.startsWith(series + '-') || seen.has(m.ticker) || !['yes','no'].includes(m.result) ||
              !Number.isFinite(open) || !Number.isFinite(close) || close < from || close > now - 120000 || close - open !== 900000) continue;
          seen.add(m.ticker); selected++; h.market(m, source);
          const covered = () => {
            const rows = h.db.prepare('SELECT end_period_ts FROM candles WHERE ticker=? ORDER BY end_period_ts').all(m.ticker);
            return rows.length === 15 && rows.every((r, i) => r.end_period_ts * 1000 === open + (i + 1) * 60000);
          };
          if (!covered()) {
            const endpoint = source === 'live' ? `/series/${series}/markets/${encodeURIComponent(m.ticker)}/candlesticks` : `/historical/markets/${encodeURIComponent(m.ticker)}/candlesticks`;
            const result = await client.get(endpoint, { start_ts: open / 1000, end_ts: close / 1000, period_interval: 1 });
            if (!Array.isArray(result.candlesticks)) throw Error('Missing candlestick array');
            h.candles(m.ticker, result.candlesticks, source);
          }
          if (covered()) complete++;
          if (selected % 50 === 0) console.log(`${asset}: ${selected} markets, ${complete} with complete minute candles`);
        }
      }
    }
    spot = openResearch(path.join(dir, 'spot.sqlite'));
    const reference = await downloadSpot(spot, from - 3 * 3600000, now - 120000, { symbol: asset + 'USDT' });
    const summary = { asset, completedAt: new Date().toISOString(), days, selected, complete, incomplete: selected - complete, reference,
      purpose: 'Exploratory historical collection; not a frozen forward study or a profitability result' };
    fs.writeFileSync(path.join(dir, 'download.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
    return summary;
  } finally { spot?.close(); h.close(); }
}
async function record() {
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, 'recorder.pid');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw Error('Invalid recorder lock');
    try { process.kill(pid, 0); throw Error(`Recorder already running: ${pid}`); }
    catch (e) { if (e.code !== 'ESRCH') throw e; fs.unlinkSync(lock); }
  }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  const recorders = [];
  const stop = () => {
    for (const r of recorders) r.stop();
    recorders.length = 0;
    if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock);
  };
  try {
    for (const asset of assets) {
      const product = (await axios.get(`https://api.exchange.coinbase.com/products/${asset}-USD`, { timeout: 15000 })).data;
      if (product.id !== asset + '-USD' || product.status !== 'online') throw Error(`${asset} Coinbase product unavailable`);
    }
    for (const asset of assets) {
      const r = new CoinbaseRecorder(path.join(directory(asset), 'coinbase.sqlite'), asset + '-USD');
      recorders.push(r); r.start();
    }
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    console.log(JSON.stringify({ pid: process.pid, assets, startedAt: new Date().toISOString(), shadowOnly: true }));
  } catch (e) { stop(); throw e; }
}
function status() {
  for (const asset of assets) {
    const file = path.join(directory(asset), 'coinbase.sqlite'), report = { asset };
    if (fs.existsSync(file)) {
      const db = new Database(file, { readonly: true });
      try {
        for (const table of ['proxy_ticks', 'proxy_quotes']) {
          report[table] = db.prepare(`SELECT count(*) samplesLastMinute FROM ${table} WHERE received_ms>?`).get(Date.now() - 60000);
          const last = db.prepare(`SELECT max(received_ms) t FROM ${table}`).get().t;
          report[table].latestAgeSeconds = last === null ? null : (Date.now() - last) / 1000;
        }
        report.lastEvent = db.prepare('SELECT event,detail FROM feed_events ORDER BY id DESC LIMIT 1').get();
      } finally { db.close(); }
    } else report.recorder = 'no database yet';
    const summary = path.join(directory(asset), 'download.json');
    if (fs.existsSync(summary)) report.download = JSON.parse(fs.readFileSync(summary));
    console.log(JSON.stringify(report));
  }
}
async function main(args) {
  const { command, days } = options(args);
  if (command === 'record') return record();
  if (command === 'status') return status();
  let failed = false;
  for (const asset of assets) {
    try { await download(asset, days); }
    catch (e) { failed = true; console.error(`${asset}: ${e.message}. Rerun to resume.`); }
  }
  if (failed) throw Error('One or more asset downloads failed');
}
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { assets, options, download };
