// Minute-resolution research adapter. No network, account client, or live ledger.
const SignalGenerator = require('../agents/skills/analysis/signal-generator');
const ProbabilityModel = require('../agents/skills/analysis/probability-model');
const { MLPipeline } = require('./ml-pipeline');

function fee(contracts, price, rate) {
  return Math.ceil((rate * contracts * price * (1 - price)) * 100 - 1e-10) / 100;
}
function validPrice(p) { return Number.isFinite(p) && p > 0 && p < 1; }
function quote(c, market) {
  if (!validPrice(c.yes_bid_close) || !validPrice(c.yes_ask_close) || c.yes_bid_close > c.yes_ask_close) return null;
  return { ticker: market.ticker, openTime: Date.parse(market.open_time), closeTime: Date.parse(market.close_time),
    yesBid: c.yes_bid_close, yesAsk: c.yes_ask_close,
    noAsk: 1 - c.yes_bid_close, noBid: 1 - c.yes_ask_close };
}

// Binary search is explicitly as-of: the current minute's eventual close is never an input.
function asOf(rows, timestamp) {
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].available_ms <= timestamp) lo = mid + 1; else hi = mid;
  }
  return lo - 1;
}

function spotContext(rows, index, strategy) {
  const slice = rows.slice(Math.max(0, index - 179), index + 1);
  if (slice.length < 60 || slice.some((r, i) => i && r.available_ms - slice[i - 1].available_ms !== 60000)) return null;
  // Time-scaled EMA for minute observations; not invented one-second ticks.
  const fastK = 1 - (1 - 2 / ((strategy.TREND_FAST_PERIOD ?? 720) + 1)) ** 60;
  const slowK = 1 - (1 - 2 / ((strategy.TREND_SLOW_PERIOD ?? 2700) + 1)) ** 60;
  let fast = slice[0].close, slow = fast;
  for (const r of slice.slice(1)) { fast += fastK * (r.close - fast); slow += slowK * (r.close - slow); }
  const last = slice.at(-1).close, past = slice[Math.max(0, slice.length - 31)].close;
  const roc = (last / past - 1) * 100, threshold = strategy.TREND_ROC_THRESHOLD ?? 0.02;
  const trend = fast > slow && roc > threshold ? 'BULLISH' : fast < slow && roc < -threshold ? 'BEARISH' : 'NEUTRAL';
  const returns = slice.slice(-16).slice(1).map((r, i) => Math.log(r.close / slice.slice(-16)[i].close));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sigma = Math.max(0.0001, Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length * 15));
  return { price: last, sigma, trend, strength: Math.min(Math.abs(fast - slow) / slow / 0.005, 1), roc, warmup: true };
}

function validateConfig(config) {
  const bounds = { startingBalance: [1, 1e9], feeRate: [0, 1], slippageCents: [0, 25],
    volumeParticipation: [0, 1], minimumTrainingSamples: [10, 1e7] };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (!Number.isFinite(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid research ${key}`);
  }
  if (!config.strategy || typeof config.strategy !== 'object') throw new Error('Missing strategy config');
  for (const [key, value] of Object.entries(config.strategy)) {
    if (typeof value !== 'boolean' && (!Number.isFinite(value) || value < 0)) throw new Error(`Invalid strategy ${key}`);
  }
}

async function replay(history, spotRows, config, { modelPath, adverse = false, tickers = null } = {}) {
  validateConfig(config);
  const markets = history.prepare("SELECT * FROM markets WHERE result IN ('yes','no') ORDER BY open_time,ticker").all()
    .filter(m => !tickers || tickers.has(m.ticker));
  const candles = history.prepare('SELECT * FROM candles WHERE ticker=? AND period_minutes=1 ORDER BY end_period_ts');
  const generator = new SignalGenerator(), probability = new ProbabilityModel();
  let currentSpot;
  const registry = new Map([
    ['probability-model', probability],
    ['binance-price-feed', { getFeed: () => ({ getRecentVolatility: () => currentSpot.sigma }) }],
    ['polymarket-price-feed', { getCachedPrice: () => null }],
    ['trend-analysis', { getIndicator: () => ({ getTrend: () => currentSpot }), getTrendMultiplier: side => {
      if (config.strategy.TREND_ENABLED === false || currentSpot.trend === 'NEUTRAL') return 1;
      const aligned = (side === 'yes') === (currentSpot.trend === 'BULLISH');
      return aligned ? 1 + (config.strategy.TREND_BOOST ?? 0.25) : 1 - (config.strategy.TREND_PENALTY ?? 0.40);
    } }],
  ]);
  await generator.initialize({ registry, config: { ...config.strategy, TAKER_FEE_RATE: config.feeRate } });
  const pipeline = new MLPipeline({ modelPath, config: { ML_RESEARCH_ONLY: true } });
  const samples = [], audit = { markets: markets.length, eligibleMarkets: 0, missingCandles: 0,
    missingSpot: 0, invalidMarkets: 0, invalidQuotes: 0, rejectedEntries: 0, noSignal: 0,
    entryFilters: {}, fillRejections: { invalidPrice: 0, limitExceeded: 0, liquidity: 0, balance: 0 } };
  let balance = config.startingBalance, wins = 0, streak = 0, peak = balance, maxDrawdown = 0, previousClose = -Infinity;
  let riskLatched = false, markedPeak = balance, maxMarkedDrawdown = 0;
  audit.riskPausedMarkets = 0;
  for (const m of markets) {
    const open = Date.parse(m.open_time), close = Date.parse(m.close_time);
    if (!Number.isFinite(open) || close - open !== 900000 || open < previousClose || !(m.floor_strike > 0)) {
      audit.invalidMarkets++; continue;
    }
    previousClose = close;
    const cs = candles.all(m.ticker).filter(c => c.end_period_ts * 1000 > open && c.end_period_ts * 1000 <= close);
    if (cs.length !== 15 || cs.some((c, i) => c.end_period_ts * 1000 !== open + (i + 1) * 60000)) {
      audit.missingCandles++; continue;
    }
    // Reject a whole market on reference gaps; never silently replay only favorable minutes.
    if (cs.some(c => {
      const ts = c.end_period_ts * 1000, index = asOf(spotRows, ts);
      return index < 0 || spotRows[index].available_ms !== ts || !spotContext(spotRows, index, config.strategy);
    })) { audit.missingSpot++; continue; }
    audit.eligibleMarkets++;
    if(riskLatched){audit.riskPausedMarkets++;continue;}
    const state = { btcPrice: {}, marketOpenPrices: { [m.ticker]: m.floor_strike },
      balance: { available: balance, total: balance }, openPositions: [], pendingOrders: [],
      model: {}, updateModel(value) { this.model = value; } };
    let position = null, candidate = null, result = null;
    for (let i = 0; i < cs.length - 1; i++) {
      const ts = cs[i].end_period_ts * 1000, next = cs[i + 1], fillTime = next.end_period_ts * 1000;
      const market = quote(cs[i], m);
      if (!market) { audit.invalidQuotes++; continue; }
      currentSpot = spotContext(spotRows, asOf(spotRows, ts), config.strategy);
      state.btcPrice.binance = currentSpot.price;
      if (position) {
        const bid=position.side==='yes'?market.yesBid:market.noBid;
        const equity=balance-position.cost+position.contracts*bid-fee(position.contracts,bid,config.feeRate);
        markedPeak=Math.max(markedPeak,equity);
        const dd=(markedPeak-equity)/markedPeak;maxMarkedDrawdown=Math.max(maxMarkedDrawdown,dd);
        if(dd>=(config.strategy.MAX_EQUITY_DRAWDOWN_PCT??1)-1e-12)riskLatched=true;
        const exit = generator._generateExitSignals([position], [market], ts)[0];
        if (!exit) continue;
        const price = position.side === 'yes' ? next[adverse ? 'yes_bid_low' : 'yes_bid_close'] :
          next[adverse ? 'yes_ask_high' : 'yes_ask_close'] == null ? null : 1 - next[adverse ? 'yes_ask_high' : 'yes_ask_close'];
        if (!validPrice(price) || !Number.isFinite(next.volume) || next.volume * config.volumeParticipation < position.contracts) continue;
        const sell = Math.max(0.001, price - config.slippageCents / 100);
        result = { exitType: exit.type, outcome_ms: fillTime, exitPrice: sell,
          payout: sell * position.contracts - fee(position.contracts, sell, config.feeRate) };
        break;
      }
      // At most one attempted entry per market: no correlated duplicate labels across splits.
      if (candidate || fillTime >= close) continue;
      const signal = generator._generateSignals([market], state, ts, audit.entryFilters)[0];
      if (!signal) continue;
      const context = { btcPrice: currentSpot.price, openPrice: m.floor_strike,
        timeRemainingMs: close - ts, totalDurationMs: close - open, sigma: currentSpot.sigma,
        trend: currentSpot.trend, trendStrength: currentSpot.strength, trendROC: currentSpot.roc,
        yesAsk: market.yesAsk, yesBid: market.yesBid, noAsk: market.noAsk, noBid: market.noBid,
        recentWinRate: samples.length ? wins / samples.length : 0.5,
        recentPnL: balance - config.startingBalance, streak, balanceAvailable: balance };
      candidate = { ts, signal: { ...signal, signalId: `replay:${m.ticker}:${ts}` }, features: pipeline.extractFeatures(signal, context), context };
      const price = signal.side === 'yes' ? next[adverse ? 'yes_ask_high' : 'yes_ask_close'] :
        next[adverse ? 'yes_bid_low' : 'yes_bid_close'] == null ? null : 1 - next[adverse ? 'yes_bid_low' : 'yes_bid_close'];
      const limit = Math.min(0.999, signal.priceDecimal + config.slippageCents / 100);
      const rejection = !validPrice(price) ? 'invalidPrice' : price > limit ? 'limitExceeded' :
        !Number.isFinite(next.volume) || next.volume * config.volumeParticipation < signal.contracts ? 'liquidity' : null;
      if (rejection) { audit.rejectedEntries++; audit.fillRejections[rejection]++; continue; }
      const cost = price * signal.contracts + fee(signal.contracts, price, config.feeRate);
      if(cost>balance*(config.strategy.MAX_TRADE_RISK_PCT??1)+1e-10){audit.rejectedEntries++;audit.fillRejections.riskCap=(audit.fillRejections.riskCap||0)+1;continue;}
      if (cost > balance) { audit.rejectedEntries++; audit.fillRejections.balance++; continue; }
      position = { ...signal, orderId: candidate.signal.signalId, priceDecimal: price,
        filledContracts: signal.contracts, entryTime: fillTime, cost };
    }
    if (!position) { if (!candidate) audit.noSignal++; continue; }
    if (!result) result = { exitType: 'SETTLEMENT', outcome_ms: close, exitPrice: m.result === position.side ? 1 : 0,
      payout: m.result === position.side ? position.contracts : 0 };
    const pnl = result.payout - position.cost, label = Number(pnl > 0);
    samples.push({ ticker: m.ticker, ts: candidate.ts, outcome_ms: result.outcome_ms,
      features: candidate.features, label, pnl, details: { ...candidate, features: undefined,
        entryPrice: position.priceDecimal, entryTime: position.entryTime, contracts: position.contracts,
        cost: position.cost, ...result } });
    balance += pnl; wins += label;
    markedPeak=Math.max(markedPeak,balance);maxMarkedDrawdown=Math.max(maxMarkedDrawdown,(markedPeak-balance)/markedPeak);
    if((markedPeak-balance)/markedPeak>=(config.strategy.MAX_EQUITY_DRAWDOWN_PCT??1)-1e-12)riskLatched=true;
    streak = label ? Math.max(0, streak) + 1 : Math.min(0, streak) - 1;
    peak = Math.max(peak, balance); maxDrawdown = Math.max(maxDrawdown, (peak - balance) / peak);
  }
  pipeline.stop();
  return { samples, audit, balance, pnl: balance - config.startingBalance, maxDrawdown,maxMarkedDrawdown,riskLatched,
    winRate: samples.length ? wins / samples.length : null };
}

module.exports = { replay, fee, asOf, spotContext, quote, validateConfig };
