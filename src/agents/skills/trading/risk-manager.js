/**
 * RiskManager Skill
 *
 * Evaluates signals against risk constraints before execution.
 * Enforces position limits, balance checks, exposure caps, and
 * session drawdown rules.
 *
 * Capabilities: check-risk, evaluate-signals, check-position-limits, check-balance
 */

const BaseSkill = require('#src/agents/core/base-skill');
const { orderCost, affordableContracts } = require('#src/risk/trading-math');

class RiskManager extends BaseSkill {
  constructor() {
    super({
      name: 'risk-manager',
      description: 'Evaluates trading signals against risk constraints and position limits',
      domain: 'trading',
      capabilities: ['check-risk', 'evaluate-signals', 'check-position-limits', 'check-balance'],
      dependencies: ['state-manager', 'analytics-recorder'],
    });

    this.maxOpenPositions = 10;
    this.maxPerContract = 1;
    this.maxPositionSize = 25;
    this.feeRate = 0.07;
    this.maxRiskFraction = 0.01;
  }

  async initialize(context) {
    await super.initialize(context);
    this.maxOpenPositions = context.config.MAX_TOTAL_OPEN_POSITIONS ?? 10;
    this.maxPerContract = context.config.MAX_POSITIONS_PER_CONTRACT ?? 1;
    this.maxPositionSize = context.config.MAX_POSITION_SIZE ?? 25;
    this.feeRate = context.config.TAKER_FEE_RATE ?? 0.07;
    this.maxRiskFraction = context.config.MAX_TRADE_RISK_PCT ?? 0.01;
  }

  async handleTask(task) {
    const state = this.context.registry.get('state-manager').botState;

    switch (task.action) {
      case 'evaluate-signals': {
        // Accept ML-scored signals (preferred) or raw signals
        const signals = task.params?.scoredSignals || task.params?.signals || [];
        const approved = [];

        for (const signal of signals) {
          const check = this._checkSignal(signal, state);
          if (check.approved) {
            approved.push(signal);
          } else {
            if(this.context.config?.ENABLE_TELEMETRY) require('#src/storage/research-telemetry').record('recordEvent','risk_rejection',{signal,reason:check.reason});
            // Log blocked signal
            const db = this.context.registry.get('analytics-recorder');
            if (db) db.logBlockedSignal(signal, check.reason);
          }
        }

        return { approvedSignals: approved, rejected: signals.length - approved.length };
      }

      case 'check-risk': {
        const signal = task.params?.signal;
        if (!signal) throw new Error('signal required');
        return this._checkSignal(signal, state);
      }

      case 'check-position-limits': {
        return this._getPositionLimits(state);
      }

      case 'check-balance': {
        return {
          available: state.balance.available,
          total: state.balance.total,
          reserved: state.balance.reserved,
        };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  _checkSignal(signal, state) {
    const safety = state.safety?.check() || { approved: false, reason: 'safety_unavailable' };
    if (!safety.approved) return safety;
    if (state.stateLoadFailed || state.persistenceFailed) return { approved: false, reason: 'state_persistence_failed' };
    if (state.pendingOrders.some(p => p.submissionUnknown)) return { approved: false, reason: 'entry_submission_unknown' };
    if (state.btcPrice?.lastUpdate != null && Date.now() - state.btcPrice.lastUpdate > 10000) {
      return { approved: false, reason: 'stale_spot_price' };
    }
    if (state.openPositions.some(p => p.exitOrder || p.exitSubmissionUnknown)) {
      return { approved: false, reason: 'exit_reconciliation_pending' };
    }
    const market = state.activeMarkets?.find(m => m.ticker === signal.ticker);
    if (market?.quoteStale || (market?.quoteUpdatedAt != null && Date.now() - market.quoteUpdatedAt > 10000)) {
      return { approved: false, reason: 'stale_market_quote' };
    }
    const price = signal.priceDecimal != null ? Number(signal.priceDecimal) : Number(signal.priceCents) / 100;
    const adjustment = signal.mlAdjustment ?? 1;
    if (!Number.isFinite(price) || price <= 0 || price >= 1 ||
        !Number.isInteger(signal.contracts) || signal.contracts <= 0 ||
        !Number.isFinite(adjustment) || adjustment < 0 || signal.mlBlocked) {
      return { approved: false, reason: 'invalid_signal' };
    }
    // Apply influence once, at the execution boundary, keeping all dollar caps.
    const equity = Number(state.balance.equity ?? state.balance.total ?? state.balance.available);
    if (!Number.isFinite(equity) || equity <= 0) return { approved: false, reason: 'equity_unavailable' };
    const riskCap = affordableContracts(equity * this.maxRiskFraction, price, this.feeRate);
    const contracts = Math.min(riskCap, Math.floor(signal.contracts * adjustment * safety.sizeMultiplier),
      affordableContracts(Math.min(this.maxPositionSize * safety.sizeMultiplier, signal.riskBudget ?? Infinity), price, this.feeRate));
    if (contracts < 1) return { approved: false, reason: riskCap < 1 ? 'one_contract_exceeds_equity_risk_cap' : 'size_below_one_contract' };
    // Check total position limits (pending + open)
    const totalExposure = state.openPositions.length + state.pendingOrders.length;
    if (totalExposure >= this.maxOpenPositions) {
      return { approved: false, reason: 'max_positions' };
    }

    // Check per-contract limits
    const existingOnTicker = [
      ...state.openPositions.filter(p => p.ticker === signal.ticker),
      ...state.pendingOrders.filter(p => p.ticker === signal.ticker),
    ];
    if (existingOnTicker.length >= this.maxPerContract) {
      return { approved: false, reason: 'per_contract_cap' };
    }

    // Check balance
    const cost = orderCost(contracts, price, this.feeRate);
    if (cost > state.balance.available) {
      return { approved: false, reason: 'insufficient_balance' };
    }

    // Check cumulative ticker exposure
    const existingCost = existingOnTicker.reduce((sum, p) => sum + (p.totalCost || p.reservedCost || 0), 0);
    if (existingCost + cost > this.maxPositionSize * 1.5) {
      return { approved: false, reason: 'ticker_exposure_cap' };
    }

    return { approved: true, contracts, cost, price, existingExposure: existingCost };
  }

  _getPositionLimits(state) {
    const totalExposure = state.openPositions.length + state.pendingOrders.length;
    return {
      currentOpen: state.openPositions.length,
      currentPending: state.pendingOrders.length,
      totalExposure,
      maxOpenPositions: this.maxOpenPositions,
      maxPerContract: this.maxPerContract,
      slotsAvailable: Math.max(0, this.maxOpenPositions - totalExposure),
    };
  }
}

module.exports = RiskManager;
