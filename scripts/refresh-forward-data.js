// Public metadata and minute candles only; no account, order, or trade-download API.
const fs = require('fs');
const path = require('path');
const { root } = require('../src/config/paths');
const { verify, outputPaths, parseStudyArgs } = require('../src/research/forward-study');
const { HistoryStore, PublicHistoryClient } = require('../src/research/market-history');
const { openResearch, downloadSpot } = require('../src/research/research-data');
async function refresh({ client = new PublicHistoryClient(), now = Date.now(), version = 'v1' } = {}) {
  const study = verify(version), cutoff = Date.parse(study.cutoff), outputs = outputPaths(version);
  if (now < cutoff) return { studyId: study.id, status: 'waiting_for_cutoff', cutoff: study.cutoff };
  const h = new HistoryStore(path.join(root, 'data/market-history/history.sqlite'));
  let s, selected = 0, downloaded = 0;
  try {
    const seen = new Set();
    for (const source of ['live', 'historical']) {
      const endpoint = source === 'live' ? '/markets' : '/historical/markets';
      for await (const page of client.pages(endpoint, 'markets', { series_ticker: 'KXBTC15M', ...(source === 'live' ? { status: 'settled' } : {}) })) {
        for (const m of page) {
          if (!m.ticker?.startsWith('KXBTC15M-') || !['yes', 'no'].includes(m.result) || seen.has(m.ticker)) continue;
          const open = Date.parse(m.open_time), close = Date.parse(m.close_time);
          if (!Number.isFinite(open) || !Number.isFinite(close) || open < cutoff || close > now - 120000 || close - open !== 900000) continue;
          seen.add(m.ticker); selected++; h.market(m, source);
          const cs = h.db.prepare('SELECT end_period_ts FROM candles WHERE ticker=? AND period_minutes=1 ORDER BY end_period_ts').all(m.ticker);
          if (cs.length === 15 && cs.every((c, i) => c.end_period_ts * 1000 === open + (i + 1) * 60000)) continue;
          const url = source === 'live' ? `/series/KXBTC15M/markets/${encodeURIComponent(m.ticker)}/candlesticks` : `/historical/markets/${encodeURIComponent(m.ticker)}/candlesticks`;
          const response = await client.get(url, { start_ts: open / 1000, end_ts: close / 1000, period_interval: 1 });
          if (!Array.isArray(response.candlesticks)) throw Error('Missing candle array');
          h.candles(m.ticker, response.candlesticks, source); downloaded++;
        }
      }
    }
    const range = h.db.prepare("SELECT min(open_time) first,max(close_time) last FROM markets WHERE result IN ('yes','no')").get();
    s = openResearch(path.join(root, 'data/research/research.sqlite'));
    const spot = range.first && range.last
      ? await downloadSpot(s, Date.parse(range.first) - 3 * 3600000, Date.parse(range.last))
      : { status: 'waiting_for_settled_markets' };
    const summary = { completedAt: new Date().toISOString(), selected, marketsWithCandlesDownloaded: downloaded, lastClose: range.last, spot, studyId: study.id };
    verify(version);
    fs.mkdirSync(outputs.directory, { recursive: true });
    fs.writeFileSync(outputs.refresh, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
    return summary;
  } finally { s?.close(); h.close(); }
}
if (require.main === module) {
  Promise.resolve().then(() => refresh({ version: parseStudyArgs(process.argv.slice(2)) }))
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { refresh };
