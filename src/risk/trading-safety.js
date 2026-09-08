const { REJECTION_REASONS } = require('#src/risk/rejection-reasons');
const DEFAULTS = require('#src/config/defaults');
// Session means this process lifetime. Dashboard stop/start cannot reset a halt.
// Stops block new exposure; exits/cancellations remain available except on 401.
class TradingSafety {
  constructor(state, config = {}, now = Date.now) {
    this.state = state;
    this.now = now;
    this.config = {
      SESSION_DRAWDOWN_REDUCE_PCT: DEFAULTS.SESSION_DRAWDOWN_REDUCE_PCT,
      SESSION_DRAWDOWN_PAUSE_PCT: DEFAULTS.SESSION_DRAWDOWN_PAUSE_PCT,
      SESSION_DRAWDOWN_PAUSE_MS: DEFAULTS.SESSION_DRAWDOWN_PAUSE_MS,
      MAX_EXECUTION_FAILURES: DEFAULTS.MAX_EXECUTION_FAILURES,
      MIN_TRADING_BALANCE: DEFAULTS.MIN_TRADING_BALANCE, ...config,
    };
    this.initialPnL = Number(state.stats.totalPnL) || 0;
    this.startingBalance = null;
    this.balanceKnown = false;
    this.failureStreak = 0;
    this.haltReason = null;
    this.authFailed = false;
    this.pauseUntil = 0;
    this.pausePnL = null;
    this.entriesEnabled = false;
    this.maxEquityDrawdown = config.MAX_EQUITY_DRAWDOWN_PCT ?? DEFAULTS.MAX_EQUITY_DRAWDOWN_PCT;
    this.equityMaxAge = config.EQUITY_MAX_AGE_MS ?? DEFAULTS.EQUITY_MAX_AGE_MS;
    if (state.riskState?.halted) this.haltReason = REJECTION_REASONS.EQUITY_DRAWDOWN_LATCHED;
    state.on('balance', balance => this.observeBalance(balance));
    state.on('position:close', () => this.check());
  }

  observeBalance(balance) {
    this.balanceKnown = Number.isFinite(balance.total) && Number.isFinite(balance.available);
    if (!this.balanceKnown) return this.halt(REJECTION_REASONS.INVALID_BALANCE);
    if (this.startingBalance === null && balance.total > 0) this.startingBalance = balance.total;
    if (balance.total < this.config.MIN_TRADING_BALANCE) this.halt(REJECTION_REASONS.MINIMUM_BALANCE);
    if (balance.equity != null) {
      if (!Number.isFinite(balance.equity) || balance.equity < 0) return this.halt(REJECTION_REASONS.INVALID_EQUITY);
      const risk = this.state.riskState ||= { highWater: balance.equity, cashFlows: 0, halted: false };
      if (!Number.isFinite(risk.highWater) || !Number.isFinite(risk.cashFlows)) return this.halt(REJECTION_REASONS.INVALID_PERSISTED_RISK);
      const adjusted = balance.equity - risk.cashFlows;
      risk.highWater = Math.max(risk.highWater, adjusted);
      risk.equity = balance.equity;
      risk.observedAt = this.now();
      risk.drawdown = risk.highWater > 0 ? Math.max(0, 1 - adjusted / risk.highWater) : 0;
      if (risk.drawdown >= this.maxEquityDrawdown - 1e-12) {
        risk.halted = true;
        this.halt(REJECTION_REASONS.EQUITY_DRAWDOWN_LATCHED);
      }
      this.state.saveNow?.();
    }
  }

  halt(reason) {
    if (!this.haltReason || reason === REJECTION_REASONS.AUTHENTICATION_FAILED) {
      this.haltReason = reason;
      console.error(`[Safety] New trading halted: ${reason}`);
    }
    this.publish(reason);
  }

  authenticationFailure() {
    this.authFailed = true;
    this.halt(REJECTION_REASONS.AUTHENTICATION_FAILED);
  }

  executionSucceeded() { this.failureStreak = 0; }
  executionFailed() {
    if (++this.failureStreak >= this.config.MAX_EXECUTION_FAILURES) this.halt(REJECTION_REASONS.EXECUTION_FAILURES);
  }

  publish(reason) {
    this.state.updateIntent({ status: 'paused', message: `Trading blocked: ${reason}`, action: null });
  }

  check() {
    const pnl = Number(this.state.stats.totalPnL) - this.initialPnL;
    const drawdown = this.startingBalance > 0 ? Math.max(0, -pnl / this.startingBalance) : 0;
    // One cooldown per breach; further realized losses after expiry trigger
    // another cooldown. Unchanged cumulative loss does not pause forever.
    if (drawdown > this.config.SESSION_DRAWDOWN_PAUSE_PCT && this.now() >= this.pauseUntil &&
        (this.pausePnL === null || pnl < this.pausePnL)) {
      this.pauseUntil = this.now() + this.config.SESSION_DRAWDOWN_PAUSE_MS;
      this.pausePnL = pnl;
    }
    if (drawdown <= this.config.SESSION_DRAWDOWN_PAUSE_PCT && this.now() >= this.pauseUntil) this.pausePnL = null;
    const equityStale = this.state.riskState && this.now() - this.state.riskState.observedAt > this.equityMaxAge;
    const reason = this.haltReason || (this.state.riskState?.halted ? REJECTION_REASONS.EQUITY_DRAWDOWN_LATCHED : null) || (equityStale ? REJECTION_REASONS.EQUITY_SNAPSHOT_STALE : null) || (!this.entriesEnabled ? REJECTION_REASONS.STOPPED :
      !this.balanceKnown ? REJECTION_REASONS.BALANCE_UNAVAILABLE : this.now() < this.pauseUntil ? REJECTION_REASONS.SESSION_DRAWDOWN : null);
    return { approved: !reason, reason, drawdown, sessionPnL: pnl,
      sizeMultiplier: drawdown > this.config.SESSION_DRAWDOWN_REDUCE_PCT ? 0.5 : 1,
      pauseUntil: this.pauseUntil, failureStreak: this.failureStreak };
  }
}

module.exports = TradingSafety;
