// Session means this process lifetime. Dashboard stop/start cannot reset a halt.
// Stops block new exposure; exits/cancellations remain available except on 401.
class TradingSafety {
  constructor(state, config = {}, now = Date.now) {
    this.state = state;
    this.now = now;
    this.config = {
      SESSION_DRAWDOWN_REDUCE_PCT: 0.10, SESSION_DRAWDOWN_PAUSE_PCT: 0.20,
      SESSION_DRAWDOWN_PAUSE_MS: 900000, MAX_EXECUTION_FAILURES: 5,
      MIN_TRADING_BALANCE: 5, ...config,
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
    this.maxEquityDrawdown = config.MAX_EQUITY_DRAWDOWN_PCT ?? 0.10;
    this.equityMaxAge = config.EQUITY_MAX_AGE_MS ?? 30000;
    if (state.riskState?.halted) this.haltReason = 'equity_drawdown_latched';
    state.on('balance', balance => this.observeBalance(balance));
    state.on('position:close', () => this.check());
  }

  observeBalance(balance) {
    this.balanceKnown = Number.isFinite(balance.total) && Number.isFinite(balance.available);
    if (!this.balanceKnown) return this.halt('invalid_balance');
    if (this.startingBalance === null && balance.total > 0) this.startingBalance = balance.total;
    if (balance.total < this.config.MIN_TRADING_BALANCE) this.halt('minimum_balance');
    if (balance.equity != null) {
      if (!Number.isFinite(balance.equity) || balance.equity < 0) return this.halt('invalid_equity');
      const risk = this.state.riskState ||= { highWater: balance.equity, cashFlows: 0, halted: false };
      if (!Number.isFinite(risk.highWater) || !Number.isFinite(risk.cashFlows)) return this.halt('invalid_persisted_risk');
      const adjusted = balance.equity - risk.cashFlows;
      risk.highWater = Math.max(risk.highWater, adjusted);
      risk.equity = balance.equity;
      risk.observedAt = this.now();
      risk.drawdown = risk.highWater > 0 ? Math.max(0, 1 - adjusted / risk.highWater) : 0;
      if (risk.drawdown >= this.maxEquityDrawdown - 1e-12) {
        risk.halted = true;
        this.halt('equity_drawdown_latched');
      }
      this.state.saveNow?.();
    }
  }

  halt(reason) {
    if (!this.haltReason || reason === 'authentication_failed') {
      this.haltReason = reason;
      console.error(`[Safety] New trading halted: ${reason}`);
    }
    this.publish(reason);
  }

  authenticationFailure() {
    this.authFailed = true;
    this.halt('authentication_failed');
  }

  executionSucceeded() { this.failureStreak = 0; }
  executionFailed() {
    if (++this.failureStreak >= this.config.MAX_EXECUTION_FAILURES) this.halt('execution_failures');
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
    const reason = this.haltReason || (this.state.riskState?.halted ? 'equity_drawdown_latched' : null) || (equityStale ? 'equity_snapshot_stale' : null) || (!this.entriesEnabled ? 'stopped' :
      !this.balanceKnown ? 'balance_unavailable' : this.now() < this.pauseUntil ? 'session_drawdown' : null);
    return { approved: !reason, reason, drawdown, sessionPnL: pnl,
      sizeMultiplier: drawdown > this.config.SESSION_DRAWDOWN_REDUCE_PCT ? 0.5 : 1,
      pauseUntil: this.pauseUntil, failureStreak: this.failureStreak };
  }
}

module.exports = TradingSafety;
