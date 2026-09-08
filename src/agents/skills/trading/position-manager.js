/**
 * PositionManager Skill (Hardened)
 *
 * Manages open positions: take-profit/stop-loss execution, settlement
 * resolution, and position lifecycle tracking.
 *
 * Capabilities: take-profit, execute-take-profit, settle-position
 *
 * Fixes vs. previous revision:
 *  1. HANGING LIMIT ORDER FIX: exits now retry with progressively more
 *     aggressive (crossed) pricing instead of placing one strict limit order
 *     and leaving it to rot on the book while price runs away. STOP_LOSS /
 *     CRITICAL exits retry harder and faster than ordinary take-profit exits.
 *  2. KALSHI V2 STRING PARSING: Kalshi can return numeric fields
 *     (fill_count, taker_fill_cost, taker_fees) as strings ("10.00").
 *     `order.fill_count || 0` is NOT safe — a non-empty string like "0.00" is
 *     truthy, so the fallback never fires, and a later `=== 0` check (no
 *     coercion) then silently fails. `taker_fill_cost + taker_fees` on two
 *     strings CONCATENATES instead of adding, corrupting cost by orders of
 *     magnitude. All numeric fields from Kalshi responses are now parsed
 *     explicitly via toNumber().
 *  3. PARTIAL-FILL SAFE ACCOUNTING: previously, ANY fill on an exit order
 *     (even 2 of 10 contracts) caused the whole position to be marked
 *     "sold" using the cost basis of the ENTIRE original position, then
 *     removed from state.openPositions entirely — orphaning the unsold
 *     contracts, which are still genuinely held on Kalshi. Exits now
 *     reconcile exactly what filled: full fills close the position, partial
 *     fills reduce it in place, zero fills leave it untouched for the next
 *     scan.
 *  4. SETTLEMENT NO LONGER DOUBLE-COUNTS: settlement now settles the
 *     position's CURRENT remaining size (position.filledContracts), not the
 *     entry order's original total fill count — otherwise a position that
 *     was already partially exited via take-profit would have its sold
 *     contracts' payout counted again at settlement.
 *  5. ML FEEDBACK LOOP: when a position FULLY closes (not partial exits),
 *     if it carries a signalUuid (set at signal generation, threaded through
 *     order-executor.js and order-manager.js), the outcome is written back
 *     to the local ml_features/signals tables via mlPipeline.recordOutcome().
 *     This is what lets the ML pipeline actually accumulate labeled training
 *     data instead of permanently logging label: null.
 */

const BaseSkill = require('#src/agents/core/base-skill');
const mlPipeline = require('#src/ml/ml-pipeline');
const { executionTotals } = require('#src/execution/kalshi-order');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Explicit numeric parsing for Kalshi API fields. Kalshi v2 can return these
// as strings; JS's implicit coercion is operator-dependent (`>` and `*`
// coerce correctly, `+` on two strings concatenates, `===` never coerces at
// all) which makes relying on it silently dangerous. Always parse first.
function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

class PositionManager extends BaseSkill {
  constructor() {
    super({
      name: 'position-manager',
      description: 'Manages position lifecycle: take-profit execution and settlement resolution',
      domain: 'trading',
      capabilities: ['take-profit', 'execute-take-profit', 'settle-position'],
      dependencies: ['state-manager', 'kalshi-market-data', 'analytics-recorder'],
    });

    // =========================
    // EXIT EXECUTION TUNING
    // =========================
    // How hard to chase a fill instead of leaving a stale limit order
    // hanging on the book while price runs away. "Urgent" applies to
    // STOP_LOSS / CRITICAL-priority exits; "normal" to ordinary
    // take-profit / scalp exits, which can afford to be less aggressive.
    this.urgentMaxAttempts = 5;
    this.normalMaxAttempts = 2;
    this.urgentSlippageStepCents = 3;   // cents to cross the book per retry
    this.normalSlippageStepCents = 1;
    this.urgentFillCheckDelayMs = 800;  // wait before checking fill status
    this.normalFillCheckDelayMs = 1500;
    this._settlementTimers = new Map();
    this._settlementAttempts = new Map();
    this._exitTimers = new Map();
    this._exitAttempts = new Map();
    this._exitReconciliations = new Map();
    this._stopped = false;
  }

  async initialize(context) {
    await super.initialize(context);
    const config = context.config || {};

    this.urgentMaxAttempts = config.EXIT_URGENT_MAX_ATTEMPTS ?? 5;
    this.normalMaxAttempts = config.EXIT_NORMAL_MAX_ATTEMPTS ?? 2;
    this.urgentSlippageStepCents = config.EXIT_URGENT_SLIPPAGE_CENTS ?? 3;
    this.normalSlippageStepCents = config.EXIT_NORMAL_SLIPPAGE_CENTS ?? 1;
    this.urgentFillCheckDelayMs = config.EXIT_URGENT_DELAY_MS ?? 800;
    this.normalFillCheckDelayMs = config.EXIT_NORMAL_DELAY_MS ?? 1500;
  }

  async handleTask(task) {
    switch (task.action) {
      case 'execute-take-profit': {
        const signals = task.params?.takeProfitSignals || [];
        const results = [];
        // NOTE: still sequential, same as before. Each exit can now take
        // several seconds (retry loop), so a burst of simultaneous
        // STOP_LOSS signals during a crash will process one-at-a-time and
        // later positions in the list wait longer than they used to. Worth
        // switching to Promise.allSettled(signals.map(...)) once you've
        // confirmed Kalshi's rate limits can absorb concurrent order calls.
        for (const tp of signals) {
          const result = await this._executeTakeProfit(tp);
          results.push(result);
        }
        return { results };
      }

      case 'settle-position': {
        const orderId = task.params?.orderId;
        if (!orderId) throw new Error('orderId required');
        return await this._settlePosition(orderId);
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  /**
   * Public method for scheduled settlement callbacks.
   */
  async settlePositionById(orderId) {
    if (this._stopped) return;
    const attempts = (this._settlementAttempts.get(orderId) || 0) + 1;
    this._settlementAttempts.set(orderId, attempts);
    if (attempts > (this.context.config?.SETTLEMENT_MAX_ATTEMPTS ?? 60)) {
      this.context.registry.get('state-manager').botState.safety?.halt('settlement_retries_exhausted');
      console.error(`[PositionManager] Settlement needs manual reconciliation: ${orderId}`);
      return;
    }
    try {
      const result = await this._settlePosition(orderId);
      if (result.settled || ['position_not_found', 'never_filled', 'already_fully_exited'].includes(result.reason)) {
        this._settlementAttempts.delete(orderId);
      } else this.scheduleSettlement(orderId);
    } catch (err) {
      console.error(`[PositionManager] Settlement error for ${orderId}: ${err.message}`);
      this.scheduleSettlement(orderId);
    }
  }

  scheduleSettlement(orderId, delayMs) {
    if (this._stopped || this._settlementTimers.has(orderId)) return;
    const delay = delayMs ?? Math.min(300000, 30000 * 2 ** Math.min(4, this._settlementAttempts.get(orderId) || 0));
    const timer = setTimeout(() => {
      this._settlementTimers.delete(orderId);
      this.settlePositionById(orderId);
    }, Math.max(0, delay));
    timer.unref?.();
    this._settlementTimers.set(orderId, timer);
  }

  scheduleExitReconciliation(orderId, delayMs) {
    if (this._stopped || this._exitTimers.has(orderId)) return;
    const attempts = this._exitAttempts.get(orderId) || 0;
    if (attempts >= (this.context.config?.EXIT_RECONCILIATION_MAX_ATTEMPTS ?? 60)) {
      this.context.registry.get('state-manager').botState.safety?.halt('exit_reconciliation_retries_exhausted');
      return;
    }
    const timer = setTimeout(() => {
      this._exitTimers.delete(orderId);
      this.reconcileExitById(orderId);
    }, delayMs ?? Math.min(300000, 5000 * 2 ** Math.min(6, attempts)));
    timer.unref?.();
    this._exitTimers.set(orderId, timer);
  }

  reconcileExitById(orderId) {
    if (this._stopped) return Promise.resolve();
    if (this._exitReconciliations.has(orderId)) return this._exitReconciliations.get(orderId);
    const pending = this._requeryExit(orderId).catch(err => {
      console.error(`[PositionManager] Exit reconciliation failed for ${orderId}: ${err.message}`);
    }).finally(() => {
      this._exitReconciliations.delete(orderId);
      const position = this.context.registry.get('state-manager').botState.openPositions.find(p => p.orderId === orderId);
      if (position?.exitOrder || position?.exitSubmissionUnknown) this.scheduleExitReconciliation(orderId);
      else {
        this._exitAttempts.delete(orderId);
        clearTimeout(this._exitTimers.get(orderId));
        this._exitTimers.delete(orderId);
      }
    });
    this._exitReconciliations.set(orderId, pending);
    return pending;
  }

  async _requeryExit(orderId) {
    const state = this.context.registry.get('state-manager').botState;
    const position = state.openPositions.find(p => p.orderId === orderId);
    if (!position || this._exiting?.has(orderId)) return;
    const attempts = this._exitAttempts.get(orderId) || 0;
    if (attempts >= (this.context.config?.EXIT_RECONCILIATION_MAX_ATTEMPTS ?? 60)) return;
    this._exitAttempts.set(orderId, attempts + 1);
    const client = this.context.registry.get('kalshi-market-data').getClient();
    if (position.exitSubmissionUnknown) {
      // Legacy markers without an identity require manual reconciliation.
      if (!position.exitClientOrderId) throw new Error('Unknown exit has no persisted client order id');
      const order = await client.findOrderByClientId(position.ticker, position.exitClientOrderId);
      if (!order) return;
      if (order.client_order_id !== position.exitClientOrderId || order.ticker !== position.ticker || !order.order_id) {
        throw new Error('Exit lookup identity mismatch');
      }
      const requested = position.exitRequested;
      if (!Number.isFinite(requested) || requested <= 0) throw new Error('Unknown exit requested quantity');
      position.exitOrder = { id: order.order_id, requested };
      delete position.exitSubmissionUnknown;
      state.saveNow();
    }
    if (position.exitOrder) {
      await this._executeTakeProfit({ orderId, ticker: position.ticker, side: position.side,
        contracts: position.filledContracts ?? position.contracts, sellPriceCents: 1,
        reason: 'Scheduled exit reconciliation', reconcileOnly: true });
    }
  }

  async start() {
    this._stopped = false;
    await super.start();
    for (const position of this.context.registry.get('state-manager').botState.openPositions) {
      if (position.exitOrder || position.exitSubmissionUnknown) this.scheduleExitReconciliation(position.orderId);
    }
  }

  async stop() {
    this._stopped = true;
    for (const timer of this._settlementTimers.values()) clearTimeout(timer);
    this._settlementTimers.clear();
    for (const timer of this._exitTimers.values()) clearTimeout(timer);
    this._exitTimers.clear();
    await Promise.all(this._exitReconciliations.values());
    await super.stop();
  }

  // ============================================================
  // EXIT EXECUTION (take-profit / scalp / stop-loss)
  // ============================================================

  /**
   * Places a sell order and, if it doesn't fully fill, cancels and retries
   * at a more aggressive (crossed) price instead of leaving it hanging.
   */
  async _executeTakeProfit(tp) {
    const kalshiSkill = this.context.registry.get('kalshi-market-data');
    const client = kalshiSkill.getClient();
    const state = this.context.registry.get('state-manager').botState;
    const position = state.openPositions.find(p => p.orderId === tp.orderId);
    if (!position) return { status: 'error', error: 'position_not_found' };
    if (state.pendingOrders.some(p => p.orderId === tp.orderId)) return { status: 'blocked', error: 'entry_order_pending' };
    if (position.reconciliationRequired) return { status: 'blocked', error: 'portfolio_reconciliation_required' };
    if (position.exitSubmissionUnknown) return { status: 'blocked', error: 'unknown_exit_submission_requires_reconciliation' };
    if (this._exiting?.has(tp.orderId)) return { status: 'pending', error: 'exit_in_progress' };
    this._exiting ||= new Set();
    this._exiting.add(tp.orderId);

    const isUrgent = tp.priority === 'CRITICAL' || tp.type === 'STOP_LOSS';
    const maxAttempts = isUrgent ? this.urgentMaxAttempts : this.normalMaxAttempts;
    const slippageStepCents = isUrgent ? this.urgentSlippageStepCents : this.normalSlippageStepCents;
    const fillCheckDelayMs = isUrgent ? this.urgentFillCheckDelayMs : this.normalFillCheckDelayMs;

    let remaining = Math.min(tp.contracts, position.filledContracts ?? position.contracts);
    let priceCents = tp.sellPriceDecimal != null ? tp.sellPriceDecimal * 100 : tp.sellPriceCents;
    let totalFilled = 0;
    let totalProceedsCents = 0;
    let lastError = null;

    try {
      if (!position.entryCostVerified) {
        const entry = executionTotals(await client.getOrder(tp.orderId));
        if (entry.filled <= 0) throw new Error('Entry fills unavailable for exit cost basis');
        position.totalCost = (entry.gross + entry.fees) / 100 / entry.filled * (position.filledContracts ?? position.contracts);
        position.entryCostVerified = true;
      }
      for (let attempt = 0; attempt < maxAttempts && remaining > 0; attempt++) {
        let order;
        if (position.exitOrder) {
          order = { order_id: position.exitOrder.id };
        } else {
          if (tp.reconcileOnly) break;
          // Persist an unknown-submission marker before POST. A crash or timeout
          // must not result in another sell whose predecessor may still be live.
          position.exitSubmissionUnknown = true;
          position.exitClientOrderId = require('crypto').randomUUID();
          position.exitRequested = remaining;
          state.saveNow();
          try {
            order = await client.sellPosition(tp.ticker, tp.side, remaining, priceCents, position.exitClientOrderId);
          } catch (err) {
            // Only a definite rejection of THIS POST proves there is no exit order.
            // Timeouts and failures while observing an accepted order remain unknown.
            if (require('#src/execution/order-rejection').isDefiniteRejection(err)) {
              delete position.exitSubmissionUnknown;
              delete position.exitClientOrderId;
              delete position.exitRequested;
              state.saveNow();
            }
            throw err;
          }
          if (!order.order_id) throw new Error('Exit response missing order id');
          position.exitOrder = { id: order.order_id, requested: remaining };
          delete position.exitSubmissionUnknown;
          state.saveNow();
        }

        // Give the book a moment, then re-fetch for an authoritative fill
        // count. Don't trust the placement response alone — it's a
        // snapshot taken at submission time, before the order has had a
        // chance to actually cross with resting liquidity.
        await sleep(fillCheckDelayMs);

        let fresh = await client.getOrder(order.order_id);
        if (!['executed', 'canceled', 'cancelled'].includes(fresh.status)) {
          try { await client.cancelOrder(order.order_id, tp.ticker); } catch (err) {
            // A cancel failure can mean a concurrent fill. Requery THIS order
            // before considering another sell; never infer that it is canceled.
          }
          fresh = await client.getOrder(order.order_id);
        }
        if (!['executed', 'canceled', 'cancelled'].includes(fresh.status)) throw new Error('Exit order still active; retry deferred');
        const totals = executionTotals(fresh);
        const filledThisAttempt = totals.filled;
        if (filledThisAttempt > position.exitOrder.requested || filledThisAttempt > remaining) throw new Error('Exit fills exceed tracked position');
        if (filledThisAttempt > 0) {
          totalFilled += filledThisAttempt;
          totalProceedsCents += totals.gross - totals.fees;
          remaining -= filledThisAttempt;
        }
        delete position.exitOrder;
        delete position.exitClientOrderId;
        delete position.exitRequested;
        // Commit each terminal order before another POST, including partials.
        const result = this._reconcileExit(tp, filledThisAttempt, totals.gross - totals.fees, remaining, null);
        state.saveNow();
        if (remaining <= 0) return result;
        totalFilled = 0; totalProceedsCents = 0;
        priceCents = Math.max(1, priceCents - slippageStepCents);
      }
    } catch (err) {
      const detail = err.response?.data?.error;
      lastError = [err.message, detail?.code, typeof detail?.message === 'string' ? detail.message : null].filter(Boolean).join(' | ');
      state.saveNow();
    } finally {
      this._exiting.delete(tp.orderId);
      if (position.exitOrder || position.exitSubmissionUnknown) this.scheduleExitReconciliation(tp.orderId);
    }

    return this._reconcileExit(tp, totalFilled, totalProceedsCents, remaining, lastError);
  }

  /**
   * Books whatever ACTUALLY filled against the position — never assumes a
   * partial fill means the whole position is gone.
   */
  _reconcileExit(tp, totalFilled, totalProceedsCents, remaining, lastError) {
    const state = this.context.registry.get('state-manager').botState;
    const position = state.openPositions.find(p => p.orderId === tp.orderId);

    if (!position) {
      return { ticker: tp.ticker, status: 'error', error: 'position_not_found' };
    }

    if (totalFilled <= 0) {
      // Nothing sold — most likely a zero-bid / evaporated book (see
      // signal-generator.js's exit generator for the upstream check that
      // stops signals from being generated at all once bid hits 0). Leave
      // the position exactly as-is; it'll be picked up on the next exit
      // scan, or ride to settlement if the bid never returns.
      return {
        ticker: tp.ticker,
        status: lastError ? 'error' : 'pending',
        error: lastError,
        contracts: remaining,
      };
    }

    const avgSellPriceDecimal = (totalProceedsCents / 100) / totalFilled;
    const held = position.filledContracts ?? position.contracts;
    const entryPriceDecimal = Number.isFinite(position.totalCost) && position.totalCost > 0 && held > 0
      ? position.totalCost / held : (position.priceDecimal || 0);
    const proceeds = totalProceedsCents / 100;
    const costOfSoldPortion = entryPriceDecimal * totalFilled;
    const pnl = proceeds - costOfSoldPortion;

    state.logTrade({
      type: 'TRADE',
      action: 'SELL',
      side: tp.side,
      ticker: tp.ticker,
      contracts: totalFilled,
      price: Math.round(avgSellPriceDecimal * 100),
      pnl,
      reason: tp.reason + (remaining > 0 ? ` [partial: ${totalFilled}/${tp.contracts} filled]` : ''),
    });

    const currentRemainingOnPosition = (position.filledContracts != null && position.filledContracts > 0)
      ? position.filledContracts
      : (position.contracts || totalFilled);

    if (totalFilled >= currentRemainingOnPosition) {
      // This sale covers everything still held — fully exited.
      // Include prior partial exits in the final trade label and session P&L.
      const tradePnL = pnl + (position.realizedExitPnL || 0);
      const won = tradePnL > 0;

      state.closePosition(tp.orderId, {
        won,
        pnl: tradePnL,
        payout: proceeds + (position.realizedExitProceeds || 0),
        cost: costOfSoldPortion + (position.realizedExitCost || 0),
        exitType: tp.type || 'TAKE_PROFIT',
      });

      // ML feedback loop: this is a FULL close, so the original signal's
      // outcome is now known. Write it back so training data accumulates.
      // Reconciled positions (no originating signal) have signalUuid: null
      // and are correctly skipped here — see order-manager.js.
      if (position.signalUuid) {
        mlPipeline.recordOutcome(position.signalUuid, won, tradePnL)
          .catch(err => console.error('[PositionManager] recordOutcome error:', err.message));
      }

      return { ticker: tp.ticker, status: 'sold', pnl, filled: totalFilled };
    }

    // Partial exit: the un-sold contracts are still genuinely held on
    // Kalshi — reduce the position in place instead of closing it, so the
    // bot doesn't lose visibility into real remaining exposure. Do NOT
    // record an ML outcome here — the signal hasn't fully resolved yet.
    position.filledContracts = currentRemainingOnPosition - totalFilled;
    position.contracts = position.filledContracts;
    position.totalCost = entryPriceDecimal * position.filledContracts;
    position.realizedExitPnL = (position.realizedExitPnL || 0) + pnl;
    position.realizedExitProceeds = (position.realizedExitProceeds || 0) + proceeds;
    position.realizedExitCost = (position.realizedExitCost || 0) + costOfSoldPortion;
    state._scheduleSave();
    state.emit('position:updated', position);

    return {
      ticker: tp.ticker,
      status: 'partial',
      pnl,
      filled: totalFilled,
      remaining: position.filledContracts,
    };
  }

  // ============================================================
  // SETTLEMENT
  // ============================================================
  async _settlePosition(orderId) {
    const state = this.context.registry.get('state-manager').botState;
    const kalshiSkill = this.context.registry.get('kalshi-market-data');
    const analyticsSkill = this.context.registry.get('analytics-recorder');
    const client = kalshiSkill.getClient();

    const position = state.openPositions.find(p => p.orderId === orderId);
    if (!position) {
      const pending = (state.pendingOrders || []).find(p => p.orderId === orderId);
      if (pending) {
        return { settled: false, reason: 'entry_order_pending' };
      }
      return { settled: false, reason: 'position_not_found' };
    }
    if (position.exitOrder && !position.reconciliationRequired && !position.exitSubmissionUnknown && !this._exiting?.has(orderId)) {
      await this._executeTakeProfit({ orderId, ticker: position.ticker, side: position.side,
        contracts: position.filledContracts ?? position.contracts, sellPriceCents: 1,
        reason: 'Reconcile outstanding exit before settlement', reconcileOnly: true });
      if (!state.openPositions.some(p => p.orderId === orderId)) return { settled: true, reason: 'fully_exited' };
    }
    if (position.reconciliationRequired || position.exitOrder || position.exitSubmissionUnknown || this._exiting?.has(orderId)) {
      return { settled: false, reason: 'exit_reconciliation_pending' };
    }

    const order = await client.getOrder(orderId);

    // See toNumber() comment at top of file — this is the concrete bug:
    // `order.fill_count || 0` never falls back for a truthy non-empty
    // string like "0.00", and a later `=== 0` check (no coercion) then
    // silently fails to catch a genuinely-unfilled order.
    const entryFilled = toNumber(order.fill_count, 0);

    if (entryFilled <= 0) {
      state.openPositions = state.openPositions.filter(p => p.orderId !== orderId);
      state.emit('position:removed', position);
      return { settled: false, reason: 'never_filled' };
    }

    // Settle only what's STILL held. If take-profit/stop-loss already
    // partially exited this position before settlement,
    // position.filledContracts reflects the reduced remaining size — using
    // the entry order's original fill_count here would double-count
    // contracts whose PnL was already realized at exit time.
    const remainingContracts = (position.filledContracts != null && position.filledContracts > 0)
      ? position.filledContracts
      : (position.contracts || entryFilled);

    if (remainingContracts <= 0) {
      // Fully exited already via take-profit/stop-loss — nothing left to settle.
      state.openPositions = state.openPositions.filter(p => p.orderId !== orderId);
      return { settled: false, reason: 'already_fully_exited' };
    }

    const market = await client.fetchMarket(position.ticker);

    if (!market || (market.result !== 'yes' && market.result !== 'no')) {
      // Not settled yet, retry
      this.scheduleSettlement(orderId);
      return { settled: false, reason: 'not_settled_yet' };
    }

    const won = position.side === market.result;

    // Cost basis, explicitly parsed (see toNumber comment — the original
    // `(order.taker_fill_cost || 0) + (order.taker_fees || 0)` performs
    // STRING CONCATENATION if both fields come back as strings, corrupting
    // cost by orders of magnitude). Prorated per-contract from the entry
    // order's total, then scaled to the remaining held size — an
    // approximation when a partial exit already happened (Kalshi doesn't
    // expose exactly how fees were apportioned across partial fills), but
    // proportionally correct and far closer to reality than charging the
    // ENTIRE original cost basis against only the remaining contracts.
    const entryTotals = executionTotals(order);
    const entryFillCostCents = entryTotals.gross;
    const entryFeesCents = entryTotals.fees;
    const costPerContractCents = entryFilled > 0
      ? (entryFillCostCents + entryFeesCents) / entryFilled
      : 0;
    const costDollars = (costPerContractCents * remainingContracts) / 100;

    const payout = won ? remainingContracts * 1.00 : 0;
    const pnl = payout - costDollars;
    const tradePnL = pnl + (position.realizedExitPnL || 0);
    const tradeWon = tradePnL > 0;

    analyticsSkill.updateOrderDirect(orderId, 'settled', entryFilled, entryFillCostCents, entryFeesCents);
    analyticsSkill.logMarketSnapshotDirect(market, state.btcPrice.binance, 'settlement');

    state.closePosition(orderId, {
      won: tradeWon, pnl: tradePnL,
      payout: payout + (position.realizedExitProceeds || 0),
      cost: costDollars + (position.realizedExitCost || 0),
      filledContracts: remainingContracts, exitType: 'SETTLEMENT', result: market.result,
    });

    // ML feedback loop: settlement is always a FULL close of whatever
    // remains, so this is a safe place to write the outcome back.
    if (position.signalUuid) {
      mlPipeline.recordOutcome(position.signalUuid, tradeWon, tradePnL)
        .catch(err => console.error('[PositionManager] recordOutcome error:', err.message));
    }

    state.logTrade({
      type: 'SETTLEMENT', action: won ? 'WIN' : 'LOSS',
      side: position.side, ticker: position.ticker,
      contracts: remainingContracts, pnl, cost: costDollars, payout, result: market.result,
    });

    console.log(
      `[PositionManager] ${won ? 'WON' : 'LOST'}: ${position.ticker} ${position.side} x${remainingContracts} | Cost: $${costDollars.toFixed(2)} | Payout: $${payout.toFixed(2)} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`
    );

    await client.fetchBalance();

    return { settled: true, won, pnl, payout };
  }
}

module.exports = PositionManager;
