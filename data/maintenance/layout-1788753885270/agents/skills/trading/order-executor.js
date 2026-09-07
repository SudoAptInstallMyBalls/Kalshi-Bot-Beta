/**
 * OrderExecutor Skill (V2 Kalshi API Compliant)
 *
 * Places orders using Kalshi's V2 single-book event order endpoint:
 * /trade-api/v2/portfolio/events/orders
 *
 * Quotes are mapped from the YES book:
 *  - BUY YES: side = 'bid', price = yes_price
 *  - BUY NO:  side = 'ask', price = (1.00 - no_price)
 */

const crypto = require('crypto');
const BaseSkill = require('../../core/base-skill');
const OrderManager = require('../../../bot/order-manager');
const { isDefiniteRejection } = require('../../../lib/order-rejection');

class OrderExecutor extends BaseSkill {
  constructor() {
    super({
      name: 'order-executor',
      description: 'Places orders on Kalshi and manages order lifecycle (fills, cancellations)',
      domain: 'trading',
      capabilities: ['execute-signals', 'place-order', 'cancel-order', 'check-order-status'],
      dependencies: ['state-manager', 'kalshi-market-data', 'analytics-recorder', 'risk-manager'],
    });

    this.orderManager = null;
    this.maxPositionSize = 25;
  }

  async initialize(context) {
    await super.initialize(context);

    const stateManager = context.registry.get('state-manager');
    const kalshiSkill = context.registry.get('kalshi-market-data');
    const analyticsSkill = context.registry.get('analytics-recorder');

    this.orderManager = new OrderManager(
      kalshiSkill.getClient(),
      stateManager.botState,
      analyticsSkill.getDB(),
      context.config
    );

    this.maxPositionSize = context.config.MAX_POSITION_SIZE || 25;
  }

  async start() {
    await super.start();
    this.orderManager.start();
  }

  async handleTask(task) {
    const state = this.context.registry.get('state-manager').botState;
    const kalshiSkill = this.context.registry.get('kalshi-market-data');
    const analyticsSkill = this.context.registry.get('analytics-recorder');
    const riskSkill = this.context.registry.get('risk-manager');

    switch (task.action) {
      case 'execute-signals': {
        const signals = task.params?.approvedSignals || [];
        const results = [];
        let executedCount = 0;
        const maxPerScan = 2;
        let lastTicker = null;

        for (const signal of signals) {
          if (executedCount >= maxPerScan) break;

          // Final risk check before execution
          const riskCheck = await riskSkill.execute({
            action: 'check-risk',
            params: { signal },
          });

          if (!riskCheck.success || !riskCheck.approved) {
            results.push({ signal: signal.ticker, status: 'blocked', reason: riskCheck.reason || 'risk_check_failed' });
            continue;
          }

          if (lastTicker === signal.ticker) await sleep(100);

          const result = await this._executeSignal(signal, state, kalshiSkill, analyticsSkill);
          results.push(result);
          if (result.status === 'executed') executedCount++;
          lastTicker = signal.ticker;
        }

        return { executedSignals: results, totalExecuted: executedCount };
      }

      case 'place-order': {
        // Raw orders bypass signal sizing and lifecycle accounting.
        throw new Error('Use execute-signals with a risk-checked signal');
      }

      case 'cancel-order': {
        const orderId = task.params?.orderId;
        await kalshiSkill.getClient().cancelOrder(orderId);
        return { cancelled: true };
      }

      case 'check-order-status': {
        const orderId = task.params?.orderId;
        const order = await kalshiSkill.getClient().getOrder(orderId);
        return { order };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  async _executeSignal(signal, state, kalshiSkill, analyticsSkill) {
    // Recheck synchronously after any inter-order delay, immediately before POST.
    const check = this.context.registry.get('risk-manager')._checkSignal(signal, state);
    if(this.context.config?.ENABLE_TELEMETRY) require('../../../lib/research-telemetry').record('recordEvent','decision',{signal,check});
    if (!check.approved) return { signal: signal.ticker, status: 'blocked', reason: check.reason };
    const contracts = check.contracts;
    const priceDecimal = check.price;
    const priceCents = priceDecimal * 100;
    const cost = check.cost;

    // Snapshot market state
    const market = state.activeMarkets.find(m => m.ticker === signal.ticker);
    if (market) {
      analyticsSkill.logMarketSnapshotDirect(market, state.btcPrice.binance, 'pre_execution');
    }

    let submissionMarker = null;
    try {
      const clientOrderId = crypto.randomUUID ? crypto.randomUUID() : `bot-${Date.now()}`;
      
      // Kalshi V2 single-book representation:
      // Buying YES -> bid YES at price
      // Buying NO  -> ask YES at (1.00 - price)
      const isYes = signal.side.toLowerCase() === 'yes';
      const bookSide = isYes ? 'bid' : 'ask';
      const priceDollars = isYes 
        ? (priceCents / 100).toFixed(4)
        : ((100 - priceCents) / 100).toFixed(4);

      const orderData = {
        ticker: signal.ticker,
        client_order_id: clientOrderId,
        side: bookSide,
        count: Number(contracts).toFixed(2),
        price: priceDollars,
        time_in_force: 'good_till_canceled',
        self_trade_prevention_type: 'taker_at_cross',
        post_only: false,
        cancel_order_on_pause: false,
        reduce_only: false,
      };

      state.updateIntent({
        status: 'executing',
        message: `Executing ${signal.type}...`,
        action: `BUY ${signal.side.toUpperCase()} ${signal.ticker} x${contracts} @ ${priceCents}c`,
      });

      console.log(`[OrderExecutor] Sending V2 Order: ${signal.type} ${signal.ticker} (${bookSide.toUpperCase()} @ $${priceDollars}) x${contracts} | Edge: ${signal.edge.toFixed(1)}%`);
      console.log(`[OrderExecutor Payload]:`, JSON.stringify(orderData));

      submissionMarker = { orderId: `unconfirmed-${clientOrderId}`, clientOrderId, ticker: signal.ticker,
        side: signal.side, contracts, fillCount: 0, priceCents, priceDecimal, reservedCost: cost,
        placedAt: Date.now(), closeTime: signal.closeTime, signalUuid: signal.signalId, submissionUnknown: true };
      state.addPendingOrder(submissionMarker);
      state._entrySubmissionsInFlight ||= new Set();
      state._entrySubmissionsInFlight.add(submissionMarker.orderId);
      state.saveNow();
      const order = await kalshiSkill.getClient().placeOrder(orderData);
      const orderId = order.order_id || order.id;
      if (!orderId) throw new Error('Accepted order response missing identity');
      const fillCount = parseFloat(order.fill_count || 0);

      console.log(`[OrderExecutor ACCEPTED] Order ID: ${orderId} | Filled: ${fillCount}/${contracts}${fillCount === 0 ? ' | Waiting for a fill; no position opened' : ''}`);

      // Log order into analytics — `signal` still carries signal.signalId
      // (set in signal-generator.js), so db.logSignal() picks it up and
      // stores it as signals.signal_uuid, joining this row back to the
      // ml_features / ml_predictions rows logged earlier by ml-signal-scorer.
      try {
        const signalId = analyticsSkill.logSignalDirect(signal, true);
        analyticsSkill.logOrderDirect({
          order_id: orderId,
          client_order_id: clientOrderId,
          ticker: signal.ticker,
          side: signal.side,
          action: 'buy',
          price_cents: priceCents,
          count: contracts,
          status: fillCount > 0 ? 'executed' : 'resting',
          fill_count: fillCount,
          taker_fill_cost: order.taker_fill_cost || 0,
          taker_fees: order.taker_fees || 0,
          close_time: signal.closeTime,
        }, signalId);
      } catch (logErr) {
        // Non-fatal
      }

      // Add to pending orders
      const pendingOrder = {
        orderId,
        clientOrderId,
        ticker: signal.ticker,
        signalType: signal.type,
        signalUuid: signal.signalId || null,
        side: signal.side,
        contracts,
        fillCount,
        priceCents,
        priceDecimal,
        reservedCost: cost,
        edge: signal.edge,
        modelProb: signal.modelProb,
        reason: signal.reason,
        placedAt: Date.now(),
        closeTime: signal.closeTime,
        orderStatus: fillCount > 0 ? 'executed' : 'resting',
        isDualSide: signal.isDualSide || false,
      };

      state.removePendingOrder(submissionMarker.orderId);
      state._entrySubmissionsInFlight.delete(submissionMarker.orderId);
      this.orderManager.addPendingOrder(pendingOrder);
      submissionMarker = null;
      state.saveNow();

      // Deduct cost locally
      state.balance.available -= cost;
      if (state.balance.available < 0) state.balance.available = 0;

      state.stats.volumeTraded += cost;
      state.stats.totalEdge += signal.edge;
      state.stats.avgEdge = state.stats.totalEdge / (state.stats.totalTrades + state.openPositions.length || 1);

      state.logTrade({
        type: 'TRADE',
        action: 'BUY',
        side: signal.side,
        ticker: signal.ticker,
        contracts,
        price: priceCents,
        edge: signal.edge,
        signalType: signal.type,
        reason: signal.reason,
      });

      state.emitStats();

      // Schedule settlement check
      const timeToSettle = signal.closeTime - Date.now() + 60000;
      if (timeToSettle > 0) {
        const positionManager = this.context.registry.get('position-manager');
        positionManager.scheduleSettlement(orderId, timeToSettle);
      }

      // Refresh balance
      try { await kalshiSkill.getClient().fetchBalance(); }
      catch (err) { console.warn('[OrderExecutor] Post-order balance refresh failed:', err.message); }

      return { signal: signal.ticker, status: 'executed', orderId };
    } catch (err) {
      if (submissionMarker) {
        state._entrySubmissionsInFlight?.delete(submissionMarker.orderId);
        if (isDefiniteRejection(err)) {
          state.removePendingOrder(submissionMarker.orderId);
          state.safety?.halt(err.haltReason || 'exchange_account_unavailable');
          state.saveNow();
        } else {
        // A timeout or incomplete response is not proof of rejection. Keep
        // the persisted client ID for account reconciliation and stop entries.
        state.safety?.halt('entry_submission_unknown');
        }
      }
      const status = err.response?.status || 'UNKNOWN';
      const data = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      const detail = `${status} - ${data}`;

      console.error(`[OrderExecutor ERROR] ${isDefiniteRejection(err) ? 'Order not accepted' : 'Order outcome requires reconciliation'}:`, detail);

      return { signal: signal.ticker, status: 'error', error: detail };
    }
  }

  async stop() {
    if (this.orderManager) await this.orderManager.stop();
    await super.stop();
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = OrderExecutor;
