/**
 * SignalGenerator Skill (Production Hardened v2)
 *
 * Strategies:
 *  1. DIRECTIONAL — Binance spot divergence from Kalshi contract price
 *  2. POLY_ARB    — Polymarket fair value exceeds Kalshi ask
 *
 * NOTE: DUAL_SIDE (YES + NO ask < $1 guaranteed profit) is NOT implemented here.
 * The exit engine still has an `isDualSide` / `dualSideComplete` exemption path,
 * but nothing in this file ever sets those fields — it's currently dead code.
 * Wiring up a real DUAL_SIDE strategy safely requires knowing how OrderExecutor
 * pairs and fills two legs (and whether it cancels a sibling order when one leg
 * gets stopped out). Don't ship a producer for this signal until that's confirmed.
 *
 * Fixes vs. previous revision:
 *  1. Running committedThisPass accumulator (portfolio-wide) — unchanged, correct.
 *  2. NEW: committedByTicker accumulator — prevents multiple signal types
 *     (DIRECTIONAL_YES + DIRECTIONAL_NO + POLY_ARB_YES) on the SAME ticker in
 *     the SAME pass from each sizing against a stale per-market exposure figure
 *     and collectively blowing through maxMarketExposurePct.
 *  3. RECALIBRATED emergency dollar stop: previously set to exactly the same
 *     loss level as the soft percentage stop for max-size positions, which
 *     meant the emergency check (no grace period) always won the race and the
 *     30s noise-filter grace period never applied to your most common position
 *     size. Now defaults to a worse loss threshold (60% vs. 40%) so the soft
 *     stop stays the primary lever and emergency is a true tail backstop, with
 *     its own short grace period (default 3s) to filter single-tick glitches.
 *  4. Partial-fill PnL evaluation (pos.filledContracts > 0) — unchanged, correct.
 *  5. No scalp dead zone — unchanged, correct.
 *  6. Late-contract trailing lock — unchanged, correct.
 *
 * ML feedback loop (new):
 *  Every generated signal now carries a `signalId` (UUID), assigned here at
 *  the moment of generation. This is the join key that lets ml-signal-scorer,
 *  order-executor, order-manager, and position-manager all attribute a single
 *  signal's features/prediction/order/outcome back to the same row — without
 *  it, ml_features.label can never be filled in and the model can never train.
 */

const crypto = require('crypto');
const BaseSkill = require('#src/agents/core/base-skill');
const { takerFee, orderCost, affordableContracts } = require('#src/risk/trading-math');

class SignalGenerator extends BaseSkill {
  async stop() {
    this.settlementReference?.close?.();
    await super.stop();
  }
  constructor() {
    super({
      name: 'signal-generator',
      description: 'Generates trading signals, scalp exits, and multi-tier stop-loss orders',
      domain: 'analysis',
      capabilities: [
        'generate-signals',
        'generate-take-profit-signals',
        'generate-stop-loss-signals',
        'generate-exit-signals',
      ],
      dependencies: [
        'state-manager',
        'binance-price-feed',
        'polymarket-price-feed',
        'probability-model',
        'trend-analysis',
      ],
    });

    // =========================
    // ENTRY SETTINGS
    // =========================
    this.minEdge = 8.0;
    this.minDivergence = 8.0;
    this.kellyFraction = 0.25;
    this.maxTradeRiskPct = 1;
    this.executionCostBuffer = 0.01;
    this.useKelly = true;
    this.maxPositionSize = 5;
    this.tradingWindow = 10 * 60 * 1000;
    this.minContractPrice = 0.30;
    this.maxContractPrice = 0.75;
    this.feeRate = 0.07;
    this.probabilityWeight = 1;
    this.minNetEdge = 0;

    // =========================
    // BANKROLL RESERVE & CAPS
    // =========================
    this.bankrollReservePct = 0.30;           // Keep 30% of account strictly in cash
    this.maxPortfolioExposurePct = 0.50;       // Max 50% of deployable capital across all trades
    this.maxMarketExposurePct = 0.25;          // Max 25% of deployable capital in any single contract
    this.maxPortfolioExposureDollars = 50;

    // =========================
    // STOP-LOSS SETTINGS
    // =========================
    this.stopLossPct = 40;                     // 40% loss on BID triggers soft stop (primary lever)
    this.maxLossPerPosition = 3.0;             // Emergency dollar stop: 60% of $5 max — tail backstop, WORSE than soft stop
    this.stopLossGracePeriodMs = 30 * 1000;    // 30s grace period for entry spread noise (soft stop only)
    this.stopLossMinTimeRemaining = 45 * 1000; // Don't stop out in the last 45s of the contract
    this.emergencyStopGraceMs = 3 * 1000;      // Short glitch-filter for emergency stop — NOT the 30s soft grace

    // =========================
    // SCALPING SETTINGS
    // =========================
    this.enableScalping = true;
    this.scalpTakeProfitPct = 15;              // Scalp target: +15% profit, any time after min hold
    this.scalpMinHoldMs = 15 * 1000;           // Minimum hold time: 15s (avoids selling on spread bounce)
    this.scalpQuickProfitPct = 25;             // Instant scalp target (+25% profit)

    // =========================
    // TAKE-PROFIT SETTINGS
    // =========================
    this.takeProfitPct = 35;                   // Big runner target (+35%)
    this.takeProfitGainFraction = 0.50;
  }

  async initialize(context) {
    await super.initialize(context);
    const config = context.config;
    this.settlementAware = config.SETTLEMENT_AWARE === true;
    if (this.settlementAware) this.settlementReference = context.settlementReference ||
      new (require('#src/market-data/settlement-reference').SettlementReference)(config.SETTLEMENT_INDEX_DB);
    this.telemetryEnabled = config.ENABLE_TELEMETRY === true;
    this.maxTradeRiskPct = config.MAX_TRADE_RISK_PCT ?? 1;
    this.executionCostBuffer = (config.ROUND_TRIP_SLIPPAGE_CENTS ?? 1) / 100;

    this.minEdge = config.MIN_EDGE ?? 8.0;
    this.minDivergence = config.MIN_DIVERGENCE ?? 8.0;
    this.kellyFraction = config.KELLY_FRACTION ?? 0.25;
    this.useKelly = config.USE_KELLY_SIZING !== false;
    this.maxPositionSize = config.MAX_POSITION_SIZE ?? 5;
    this.tradingWindow = (config.TRADING_WINDOW ?? 10) * 60 * 1000;
    this.entryStartMs = (config.ENTRY_START_MINUTES ?? 0) * 60 * 1000;
    this.entryCloseBufferMs = (config.ENTRY_CLOSE_BUFFER_SECONDS ?? 30) * 1000;
    this.minContractPrice = (config.MIN_CONTRACT_PRICE ?? 30) / 100;
    this.maxContractPrice = (config.MAX_CONTRACT_PRICE ?? 75) / 100;
    this.feeRate = config.TAKER_FEE_RATE ?? 0.07;
    this.probabilityWeight = config.MODEL_PROBABILITY_WEIGHT ?? 1;
    this.minNetEdge = config.MIN_NET_EDGE ?? 0;

    this.bankrollReservePct = config.BANKROLL_RESERVE_PCT ?? 0.30;
    this.maxPortfolioExposurePct = config.MAX_PORTFOLIO_EXPOSURE_PCT ?? 0.50;
    this.maxMarketExposurePct = config.MAX_MARKET_EXPOSURE_PCT ?? 0.25;
    this.maxPortfolioExposureDollars = config.MAX_PORTFOLIO_EXPOSURE_DOLLARS ?? 50;

    this.stopLossPct = config.STOP_LOSS_PCT ?? 40;
    // Default emergency stop to 60% of max position size — meaningfully WORSE
    // than the soft stop's 40%, so the soft stop (with grace period) remains
    // the primary lever for your typical (max-size) position, and emergency
    // only fires for losses beyond what the soft stop would already catch.
    this.maxLossPerPosition = config.MAX_LOSS_PER_POSITION ?? Math.min(3.0, this.maxPositionSize * 0.60);
    this.stopLossGracePeriodMs = (config.STOP_LOSS_GRACE_SECONDS ?? 30) * 1000;
    this.stopLossMinTimeRemaining = (config.STOP_LOSS_MIN_TIME_REMAINING ?? 45) * 1000;
    this.emergencyStopGraceMs = (config.EMERGENCY_STOP_GRACE_SECONDS ?? 3) * 1000;

    this.enableScalping = config.ENABLE_SCALPING !== false;
    this.scalpTakeProfitPct = config.SCALP_TAKE_PROFIT_PCT ?? 15;
    this.scalpMinHoldMs = (config.SCALP_MIN_HOLD_SECONDS ?? 15) * 1000;
    this.scalpQuickProfitPct = config.SCALP_QUICK_PROFIT_PCT ?? 25;

    this.takeProfitPct = config.TAKE_PROFIT_PCT ?? 35;
    this.takeProfitGainFraction = config.TAKE_PROFIT_GAIN_FRACTION ?? 0.50;
  }

  async handleTask(task) {
    const state = this.context.registry.get('state-manager').botState;

    switch (task.action) {
      case 'generate-signals': {
        const markets = task.params?.markets || state.activeMarkets;
        const diagnostics = {};
        const signals = this._generateSignals(markets, state, Date.now(), diagnostics);
        if (this.telemetryEnabled) {
          this.entryCounters ||= {};
          for (const [key, value] of Object.entries(diagnostics)) this.entryCounters[key] = (this.entryCounters[key] || 0) + value;
          if (!this.lastEntrySummary || Date.now() - this.lastEntrySummary >= 30000) {
            require('#src/storage/research-telemetry').record('recordEvent', 'entry_filter_summary', {
              counts: this.entryCounters, intervalStart: this.lastEntrySummary || Date.now(),
              thresholds: { minDivergence: this.minDivergence, minNetEdge: this.minNetEdge, windowMinutes: this.tradingWindow / 60000, startMinutes: this.entryStartMs / 60000, closeBufferSeconds: this.entryCloseBufferMs / 1000 },
            });
            this.entryCounters = {};
            this.lastEntrySummary = Date.now();
          }
        }
        return { signals, diagnostics };
      }

      case 'generate-take-profit-signals': {
        const markets = task.params?.markets || state.activeMarkets;
        // Returns all exits (take-profit, scalps, and stop-loss) to OrderExecutor
        const takeProfitSignals = this._generateExitSignals(state.openPositions, markets);
        return { takeProfitSignals };
      }

      case 'generate-stop-loss-signals': {
        const markets = task.params?.markets || state.activeMarkets;
        const stopLossSignals = this._generateStopLossSignals(state.openPositions, markets);
        return { stopLossSignals };
      }

      case 'generate-exit-signals': {
        const markets = task.params?.markets || state.activeMarkets;
        const exitSignals = this._generateExitSignals(state.openPositions, markets);
        return { exitSignals };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  // ============================================================
  // RISK BUDGETING & EXPOSURE (portfolio-wide AND per-ticker pass tracking)
  // ============================================================
_getPortfolioExposure(state) {
    const all = [...(state.openPositions || []), ...(state.pendingOrders || [])];
    return all.reduce((total, pos) => {
      const contracts = (pos.filledContracts != null && pos.filledContracts > 0)
        ? pos.filledContracts
        : (pos.contracts || 0);
      const entryPrice = pos.priceDecimal || 0;
      return total + (contracts * entryPrice);
    }, 0);
  }

  _getMarketExposure(ticker, state) {
    const all = [...(state.openPositions || []), ...(state.pendingOrders || [])];
    return all
      .filter(pos => pos.ticker === ticker)
      .reduce((total, pos) => {
        const contracts = (pos.filledContracts != null && pos.filledContracts > 0)
          ? pos.filledContracts
          : (pos.contracts || 0);
        const entryPrice = pos.priceDecimal || 0;
        return total + (contracts * entryPrice);
      }, 0);
  }

  /**
   * @param committedThisPass  Portfolio-wide dollars already committed to signals
   *                           generated earlier in this same pass (not yet in openPositions).
   * @param committedForTicker Dollars already committed to THIS ticker earlier in this
   *                           same pass. Without this, a market can receive multiple signal
   *                           types (directional + poly-arb) in one pass that each check
   *                           market exposure against a stale (pre-pass) figure and
   *                           collectively exceed maxMarketExposurePct.
   */
  _getRiskBudget(state, ticker, committedThisPass = 0, committedForTicker = 0) {
    const available = Math.max(0, (state.balance?.available || 0) - committedThisPass);
    const totalBalance = Math.max(available, state.balance?.total || state.balance?.equity || available);

    const reserve = totalBalance * this.bankrollReservePct;
    const deployableCapital = Math.max(0, totalBalance - reserve);

    const portfolioExposure = this._getPortfolioExposure(state) + committedThisPass;
    const marketExposure = this._getMarketExposure(ticker, state) + committedForTicker;

    const portfolioCap = Math.min(
      deployableCapital * this.maxPortfolioExposurePct,
      this.maxPortfolioExposureDollars
    );

    const portfolioRemaining = Math.max(0, portfolioCap - portfolioExposure);
    const marketCap = deployableCapital * this.maxMarketExposurePct;
    const marketRemaining = Math.max(0, marketCap - marketExposure);

    // Hard ceiling: neither cap can be breached by stacking signals within a pass
    const riskBudget = Math.min(available, portfolioRemaining, marketRemaining);

    return {
      totalBalance, available, reserve, deployableCapital,
      portfolioExposure, portfolioCap, portfolioRemaining,
      marketExposure, marketCap, marketRemaining, riskBudget,
    };
  }

  _calculatePositionSize({ state, ticker, price, edge, probability, probModel, committedThisPass = 0, committedForTicker = 0 }) {
    if (!price || price <= 0) return { contracts: 0, dollars: 0, riskBudget: 0 };

    const budget = this._getRiskBudget(state, ticker, committedThisPass, committedForTicker);
    if (budget.riskBudget <= 0) return { contracts: 0, dollars: 0, riskBudget: 0 };

    let desiredDollars;
    if (this.useKelly) {
      const kellySize = probModel.kellySize(edge / 100, probability, this.kellyFraction, price, takerFee(1, price, this.feeRate));
      desiredDollars = kellySize * budget.deployableCapital;
    } else {
      desiredDollars = this.maxPositionSize;
    }

    const positionDollars = Math.min(desiredDollars, this.maxPositionSize, budget.riskBudget,
      (state.balance.equity ?? budget.totalBalance) * this.maxTradeRiskPct);
    const contracts = affordableContracts(positionDollars, price, this.feeRate);
    if(contracts<1 && this.telemetryEnabled) {
      const reason=orderCost(1,price,this.feeRate)>(state.balance.equity??budget.totalBalance)*this.maxTradeRiskPct
        ? 'one_contract_exceeds_equity_risk_cap':'sizing_budget_below_one_contract';
      require('#src/storage/research-telemetry').record('recordEvent','sizing_rejection',{ticker,price,positionDollars,reason});
      state.updateIntent?.({status:'waiting',message:`Entry skipped: ${reason}`,action:null});
    }

    return {
      contracts: Math.max(0, contracts),
      dollars: orderCost(Math.max(0, contracts), price, this.feeRate),
      riskBudget: budget.riskBudget,
      reserve: budget.reserve,
      portfolioExposure: budget.portfolioExposure,
    };
  }

  // ============================================================
  // ENTRY SIGNAL GENERATION
  // ============================================================
  _generateSignals(kalshiMarkets, state, now = Date.now(), diagnostics = null) {
    const signals = [];
    const count = key => { if (diagnostics) diagnostics[key] = (diagnostics[key] || 0) + 1; };
    const btcPrice = state.btcPrice?.binance;
    if (!btcPrice && !this.settlementAware) return signals;

    // Running tallies ensure simultaneous signals in one pass cannot blow
    // through EITHER the portfolio cap or any single market's cap.
    let committedThisPass = 0;
    const committedByTicker = new Map();

    const probModel = this.context.registry.get('probability-model');
    const trendSkill = this.context.registry.get('trend-analysis');
    const polySkill = this.context.registry.get('polymarket-price-feed');
    const binanceFeed = this.context.registry.get('binance-price-feed').getFeed();

    const commitSize = (ticker, dollars) => {
      committedThisPass += dollars;
      committedByTicker.set(ticker, (committedByTicker.get(ticker) || 0) + dollars);
    };

    for (const market of kalshiMarkets) {
      if (market.quoteStale) { count('stale_quote'); continue; }
      const timeRemaining = market.closeTime - now;
      const totalDuration = market.closeTime - market.openTime;
      const timeSinceOpen = now - market.openTime;

      if (!require('#src/strategy/entry-window').isEntryTime(now, market, this.entryStartMs ?? 0, this.tradingWindow, this.entryCloseBufferMs ?? 30000)) { count('outside_entry_window'); continue; }

      const openPrice = state.marketOpenPrices[market.ticker];
      if (!openPrice) { count('missing_strike'); continue; }
      if (!market.yesAsk || !market.noAsk) { count('missing_quote'); continue; }
      if (![market.yesAsk, market.noAsk].every(v => Number.isFinite(v) && v > 0 && v < 1)) { count('invalid_quote'); continue; }

      const yesInRange = market.yesAsk >= this.minContractPrice && market.yesAsk <= this.maxContractPrice;
      const noInRange = market.noAsk >= this.minContractPrice && market.noAsk <= this.maxContractPrice;

      const poly = polySkill ? polySkill.getCachedPrice(market.closeTime) : null;
      const estimate = this.settlementAware
        ? this.settlementReference.getForecast(market, openPrice, now)
        : probModel.calculateImpliedProbability(btcPrice, openPrice, timeRemaining, totalDuration, binanceFeed);
      const prob = { ...estimate }; // Blending must not mutate a cached reference forecast.
      if (this.settlementAware && !prob.ready) {
        count(prob.reason || 'settlement_reference_unavailable');
        state.updateIntent?.({ status: 'waiting', message: `Entry blocked: ${prob.reason || 'settlement reference unavailable'}`, action: null });
        continue;
      }
      if (prob.volatilityKnown === false) { count('volatility_unavailable'); continue; }
	  const marketMid = (market.yesBid + market.yesAsk) / 2;
      if (Number.isFinite(marketMid)) {
        prob.probUp = this.probabilityWeight * prob.probUp + (1 - this.probabilityWeight) * marketMid;
        prob.probDown = 1 - prob.probUp;
      }
      // Blending must never erase uncertainty in the underlying reference model.
      const conservativeYes = Math.min(prob.probUp, prob.lowerProbUp ?? prob.probUp);
      const conservativeNo = Math.min(prob.probDown, 1 - (prob.upperProbUp ?? prob.probUp));
      const trendData = trendSkill.getIndicator() ? trendSkill.getIndicator().getTrend() : {};

      state.updateModel({
        impliedProbUp: prob.probUp,
        impliedProbDown: prob.probDown,
        spotMove: prob.move,
        spotMovePct: prob.movePct,
        timeRemaining: timeRemaining / 1000,
        volatility: prob.sigma,
        trend: trendData.trend || 'NEUTRAL',
        trendStrength: trendData.strength || 0,
        trendROC: trendData.roc || 0,
        trendWarmup: trendData.warmup || false,
      });

      const kalshiYesImplied = market.yesAsk;
      const modelEdgeYes = (conservativeYes - kalshiYesImplied) * 100;
      const modelEdgeNo = (conservativeNo - market.noAsk) * 100;

      const trendMultYes = trendSkill.getTrendMultiplier('yes');
      const trendMultNo = trendSkill.getTrendMultiplier('no');
      const adjustedEdgeYes = modelEdgeYes * trendMultYes;
      const adjustedEdgeNo = modelEdgeNo * trendMultNo;
      const currentTrend = trendData.trend || 'NEUTRAL';
      const roundTrip = (ask,bid) => Math.max(0,ask-bid) + takerFee(1,ask,this.feeRate) + takerFee(1,bid,this.feeRate) + this.executionCostBuffer;
      const netYes = (conservativeYes - market.yesAsk - roundTrip(market.yesAsk,market.yesBid)) * 100;
      const netNo = (conservativeNo - market.noAsk - roundTrip(market.noAsk,market.noBid)) * 100;
      const forecastId = this.telemetryEnabled ? crypto.randomUUID() : `research:${market.ticker}:${now}`;
      if (this.telemetryEnabled) require('#src/storage/research-telemetry').record('recordForecast', {
        id: forecastId, ts: now, ticker: market.ticker, close_ms: market.closeTime,
        p_yes: prob.probUp, spot: prob.referencePrice ?? btcPrice, strike: openPrice, yes_bid: market.yesBid,
        yes_ask: market.yesAsk, sigma: prob.sigma, trend: currentTrend,
      });
      if(this.telemetryEnabled) {
        const feed = binanceFeed;
        require('#src/storage/research-telemetry').record('recordEvent','forecast_context', {
          forecastId,source:feed?.wsConnected ? feed.wsEndpoints?.[feed.currentEndpointIdx] : 'REST fallback',
          settlementIndex: prob.referenceSource || 'not_observed', referenceTimestamp: prob.referenceTimestamp,
          basisErrorBps: prob.errorBps, conservativeYes, conservativeNo, knownSettlementSamples: prob.knownCount,
          netYes,netNo,quoteUpdatedAt:market.quoteUpdatedAt,
          adjustedEdgeYes, adjustedEdgeNo, yesInRange, noInRange,
          minDivergence: this.minDivergence, minNetEdge: this.minNetEdge,
        });
      }
      for (const [inRange, edge, net] of [[yesInRange, adjustedEdgeYes, netYes], [noInRange, adjustedEdgeNo, netNo]]) {
        count(!inRange ? 'price_out_of_range' : edge <= this.minDivergence ? 'edge_below_threshold' :
          net <= this.minNetEdge ? 'net_edge_below_threshold' : 'entry_candidate');
      }

      const tickerCommitted = () => committedByTicker.get(market.ticker) || 0;

      // 1. DIRECTIONAL YES
      if (adjustedEdgeYes > this.minDivergence && yesInRange && netYes > this.minNetEdge) {
        const sizing = this._calculatePositionSize({
          state, ticker: market.ticker, price: market.yesAsk,
          edge: adjustedEdgeYes, probability: conservativeYes, probModel,
          committedThisPass, committedForTicker: tickerCommitted(),
        });

        if (sizing.contracts > 0) {
          commitSize(market.ticker, sizing.dollars);
          signals.push({
            type: 'DIRECTIONAL_YES', forecastId,
            signalId: crypto.randomUUID(),
            ticker: market.ticker, side: 'yes',
            priceCents: market.yesAsk * 100,
            priceDecimal: market.yesAsk, edge: adjustedEdgeYes, contracts: sizing.contracts,
            positionDollars: sizing.dollars, modelProb: prob.probUp,
            forecastContext: { referencePrice: prob.referencePrice ?? btcPrice, strike: openPrice, sigma: prob.sigma,
              referenceSource: prob.referenceSource || 'binance', referenceTimestamp: prob.referenceTimestamp ?? now,
              forecastTimestamp: now, errorBps: prob.errorBps ?? null },
            riskBudget: sizing.riskBudget, bankrollReserve: sizing.reserve,
            reason: `Spot +${(prob.movePct || 0).toFixed(3)}% | Model ${(prob.probUp * 100).toFixed(0)}% vs Kalshi ${(kalshiYesImplied * 100).toFixed(0)}% | 1H: ${currentTrend}`,
            closeTime: market.closeTime, executionMode: 'taker',
          });
        }
      }

      // 2. DIRECTIONAL NO
      if (adjustedEdgeNo > this.minDivergence && noInRange && netNo > this.minNetEdge) {
        const sizing = this._calculatePositionSize({
          state, ticker: market.ticker, price: market.noAsk,
          edge: adjustedEdgeNo, probability: conservativeNo, probModel,
          committedThisPass, committedForTicker: tickerCommitted(),
        });

        if (sizing.contracts > 0) {
          commitSize(market.ticker, sizing.dollars);
          signals.push({
            type: 'DIRECTIONAL_NO', forecastId,
            signalId: crypto.randomUUID(),
            ticker: market.ticker, side: 'no',
            priceCents: market.noAsk * 100,
            priceDecimal: market.noAsk, edge: adjustedEdgeNo, contracts: sizing.contracts,
            positionDollars: sizing.dollars, modelProb: prob.probDown,
            forecastContext: { referencePrice: prob.referencePrice ?? btcPrice, strike: openPrice, sigma: prob.sigma,
              referenceSource: prob.referenceSource || 'binance', referenceTimestamp: prob.referenceTimestamp ?? now,
              forecastTimestamp: now, errorBps: prob.errorBps ?? null },
            riskBudget: sizing.riskBudget, bankrollReserve: sizing.reserve,
            reason: `Spot ${(prob.movePct || 0).toFixed(3)}% | Model ${(prob.probDown * 100).toFixed(0)}% vs Kalshi ${(market.noAsk * 100).toFixed(0)}% | 1H: ${currentTrend}`,
            closeTime: market.closeTime, executionMode: 'taker',
          });
        }
      }

      // 3. POLYMARKET ARBITRAGE (If reference spread exists)
      // A different settlement reference is not a validated arbitrage leg.
      if (poly && !this.settlementAware) {
        const polyEdgeYes = (poly.upMid - market.yesAsk) * 100;
        if (polyEdgeYes > this.minEdge * 1.5 && yesInRange &&
            polyEdgeYes - takerFee(1, market.yesAsk, this.feeRate) * 100 > this.minNetEdge) {
          const sizing = this._calculatePositionSize({
            state, ticker: market.ticker, price: market.yesAsk,
            edge: polyEdgeYes, probability: poly.upMid, probModel,
            committedThisPass, committedForTicker: tickerCommitted(),
          });

          if (sizing.contracts > 0) {
            commitSize(market.ticker, sizing.dollars);
            signals.push({
              type: 'POLY_ARB_YES',
              signalId: crypto.randomUUID(),
              ticker: market.ticker, side: 'yes',
              priceCents: market.yesAsk * 100,
              priceDecimal: market.yesAsk, edge: polyEdgeYes, contracts: sizing.contracts,
              positionDollars: sizing.dollars, modelProb: poly.upMid,
              riskBudget: sizing.riskBudget, bankrollReserve: sizing.reserve,
              reason: `Poly UP mid=${(poly.upMid * 100).toFixed(1)}% vs Kalshi ask=${(market.yesAsk * 100).toFixed(1)}%`,
              closeTime: market.closeTime, executionMode: 'taker',
            });
          }
        }
      }
    }

    signals.sort((a, b) => b.edge - a.edge);
    return signals;
  }

  // ============================================================
  // UNIFIED EXIT ENGINE (Two-Tier Stop-Loss & Scalping Hierarchy)
  // ============================================================
  _generateExitSignals(openPositions, kalshiMarkets, now = Date.now()) {
    return require('#src/strategy/exit-policy').generateExitSignals(this, openPositions, kalshiMarkets, now);
  }

  _generateStopLossSignals(openPositions, kalshiMarkets) {
    return this._generateExitSignals(openPositions, kalshiMarkets)
      .filter(signal => signal.type === 'STOP_LOSS');
  }
}

module.exports = SignalGenerator;
