/**
 * Order Lifecycle Manager
 *
 * Separates "pending orders" (placed but unconfirmed) from "open positions"
 * (confirmed fills). Polls Kalshi for fill updates and cancels stale orders.
 *
 * Flow:
 *   signal → executeSignal() → pendingOrders
 *   OrderManager poll → detects fills → promotes to openPositions
 *   OrderManager poll → stale timeout → cancels order, removes from pending
 */

const { executionTotals } = require('../lib/kalshi-order');

class OrderManager {
  constructor(kalshi, state, db, config = {}) {
    this.kalshi = kalshi;
    this.state = state;
    this.db = db;

    // How often to poll for fill updates (ms)
    this.pollIntervalMs = config.ORDER_POLL_INTERVAL || 5000;
    // How long before an unfilled order is cancelled (ms)
    this.staleTimeoutMs = config.ORDER_STALE_TIMEOUT || 30000;

    this._interval = null;
    this._polling = false;
    this._pollPromise = null;
  }

  start() {
    if (this._interval) return;
    this._interval = setInterval(() => {
      if (this._polling) return;
      const pollPromise = this.poll();
      this._pollPromise = pollPromise;
      pollPromise
        .catch((err) => {
          console.error(`[OrderMgr] Unhandled poll error: ${err.message}`);
        })
        .finally(() => {
          if (this._pollPromise === pollPromise) this._pollPromise = null;
        });
    }, this.pollIntervalMs);
  }

  async stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    if (this._pollPromise) {
      try {
        await this._pollPromise;
      } finally {
        this._pollPromise = null;
      }
    }
  }

  /**
   * Add a newly placed order to the pending queue.
   * Called by engine.executeSignal() after Kalshi returns order confirmation.
   */
  addPendingOrder(orderInfo) {
    this.state.addPendingOrder(orderInfo);

    // If the order was already (partially) filled at placement, process immediately
    if (orderInfo.fillCount > 0) {
      this._processFill(orderInfo, orderInfo.fillCount, 'placement');
    }
  }

  /**
   * Main poll loop — check all pending orders for fills or staleness.
   */
  async poll() {
    if (this._polling) return;
    this._polling = true;

    try {
      const pending = [...this.state.pendingOrders];
      if (pending.length === 0) { this._polling = false; return; }

      for (const order of pending) {
        try {
          await this._checkOrder(order);
        } catch (err) {
          console.error(`[OrderMgr] Error checking order ${order.orderId}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[OrderMgr] Poll error: ${err.message}`);
    } finally {
      this._polling = false;
    }
  }

  async _checkOrder(pendingOrder) {
    if (pendingOrder.submissionUnknown) {
      if (this.state._entrySubmissionsInFlight?.has(pendingOrder.orderId)) return;
      this.state.safety?.halt('entry_submission_unknown');
      return;
    }
    const kalshiOrder = await this.kalshi.getOrder(pendingOrder.orderId);
    if (!kalshiOrder) return;

    const currentFills = Number(kalshiOrder.fill_count ?? 0);
    const prevFills = this._processedFills(pendingOrder);
    if (!Number.isFinite(currentFills) || currentFills < prevFills || currentFills > pendingOrder.contracts) throw new Error('Invalid cumulative entry fills');
    const status = kalshiOrder.status;

    // New fills detected
    if (currentFills > prevFills) {
      this._processFill(pendingOrder, currentFills, 'poll');
    }

    // Order fully executed or cancelled — remove from pending
    if (status === 'executed' || status === 'canceled' || status === 'cancelled') {
      this._finalizePendingOrder(pendingOrder, kalshiOrder);
      return;
    }

    // Check for stale orders (resting with 0 fills past timeout)
    const age = Date.now() - pendingOrder.placedAt;
    if (status === 'resting' && age > this.staleTimeoutMs) {
      await this._cancelStaleOrder(pendingOrder);
      return;
    }

    // Update local fill count
    pendingOrder.fillCount = currentFills;
  }

  /**
   * Process detected fills — promote to openPositions.
   */
  _processFill(pendingOrder, currentFills, source) {
    currentFills = Number(currentFills);
    if (!Number.isFinite(currentFills) || currentFills < 0 || currentFills > pendingOrder.contracts) throw new Error('Invalid cumulative entry fills');
    const prevFills = this._processedFills(pendingOrder);
    const newFills = currentFills - prevFills;
    if (newFills <= 0) return;

    // Log fill event
    if (this.db) {
      this.db.logFill(
        pendingOrder.orderId,
        pendingOrder.ticker,
        pendingOrder.side,
        currentFills,
        prevFills,
        source
      );
    }

    // Update pending order's tracked fill count
    pendingOrder.fillCount = currentFills;
    pendingOrder.processedFillCount = currentFills;

    // Check if a position already exists for this order (partial fill update)
    const existingPos = this.state.openPositions.find(
      p => p.orderId === pendingOrder.orderId
    );

    if (existingPos) {
      // Update existing position's fill count
      existingPos.filledContracts += newFills;
      existingPos.contracts = existingPos.filledContracts;
      existingPos.totalCost += pendingOrder.priceDecimal * newFills;
      existingPos.entryCostVerified = false;
      this.state.emit('position:updated', existingPos);
    } else {
      // Promote to open position
      const position = {
        orderId: pendingOrder.orderId,
        clientOrderId: pendingOrder.clientOrderId,
        ticker: pendingOrder.ticker,
        type: pendingOrder.signalType,
        signalUuid: pendingOrder.signalUuid || null,
        side: pendingOrder.side,
        contracts: currentFills,
        filledContracts: currentFills,
        priceCents: pendingOrder.priceCents,
        priceDecimal: pendingOrder.priceDecimal,
        totalCost: pendingOrder.priceDecimal * currentFills,
        edge: pendingOrder.edge,
        modelProb: pendingOrder.modelProb,
        reason: pendingOrder.reason,
        entryTime: pendingOrder.placedAt,
        closeTime: pendingOrder.closeTime,
        status: 'filled',
        isDualSide: pendingOrder.isDualSide || false,
      };

      this.state.addPosition(position);

      console.log(
        `[OrderMgr] Promoted to position: ${pendingOrder.ticker} ${pendingOrder.side} ` +
        `x${currentFills} @ ${pendingOrder.priceCents}c (source: ${source})`
      );
    }
  }

  _processedFills(pendingOrder) {
    if (pendingOrder.processedFillCount != null) return Number(pendingOrder.processedFillCount);
    // Old persisted pending rows did not have processedFillCount. An existing
    // position proves the previous cumulative count was already promoted.
    return this.state.openPositions.some(p => p.orderId === pendingOrder.orderId)
      ? Number(pendingOrder.fillCount ?? 0) : 0;
  }

  /**
   * Finalize a pending order — remove from pending queue.
   * If it had fills, the position already exists via _processFill.
   * If fully cancelled with 0 fills, just clean up.
   */
  _finalizePendingOrder(pendingOrder, kalshiOrder) {
    const fills = Number(kalshiOrder.fill_count ?? 0);

    // Update DB
    if (this.db) {
      this.db.updateOrder(
        pendingOrder.orderId,
        kalshiOrder.status,
        fills,
        kalshiOrder.taker_fill_cost || 0,
        kalshiOrder.taker_fees || 0
      );
    }

    // Process any remaining fills
    if (fills > this._processedFills(pendingOrder)) {
      this._processFill(pendingOrder, fills, 'finalize');
    }
    const position = this.state.openPositions.find(p => p.orderId === pendingOrder.orderId);
    if (position && fills > 0) {
      const totals = executionTotals(kalshiOrder);
      position.priceDecimal = totals.gross / 100 / fills;
      position.priceCents = position.priceDecimal * 100;
      position.totalCost = (totals.gross + totals.fees) / 100 / fills * position.filledContracts;
      position.entryCostVerified = true;
    }

    // Remove from pending
    this.state.removePendingOrder(pendingOrder.orderId);

    if (fills === 0) {
      console.log(
        `[OrderMgr] Order ${pendingOrder.orderId} closed with 0 fills ` +
        `(status: ${kalshiOrder.status})`
      );
    }
  }

  /**
   * Cancel a stale order that hasn't filled.
   */
  async _cancelStaleOrder(pendingOrder) {
    try {
      console.log(
        `[OrderMgr] Cancelling stale order: ${pendingOrder.orderId} ` +
        `(${pendingOrder.ticker} ${pendingOrder.side}, age: ${((Date.now() - pendingOrder.placedAt) / 1000).toFixed(0)}s)`
      );

      try { await this.kalshi.cancelOrder(pendingOrder.orderId, pendingOrder.ticker); } catch (_) {
        // Cancel may race a fill. Only the follow-up order state resolves it.
      }
      const order = await this.kalshi.getOrder(pendingOrder.orderId);
      if (!['executed', 'canceled', 'cancelled'].includes(order.status)) return;
      this._finalizePendingOrder(pendingOrder, order);
      // A guessed refund can make filled capital appear spendable twice.
      await this.kalshi.fetchBalance();

    } catch (err) {
      console.error(`[OrderMgr] Cancel error for ${pendingOrder.orderId}: ${err.message}`);
      // If cancel fails (e.g. already filled), next poll will pick up the new state
    }
  }
}

module.exports = OrderManager;
