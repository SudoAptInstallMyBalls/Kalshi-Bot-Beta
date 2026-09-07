// Exit decisions shared by the live skill and historical replay. No order submission.
function generateExitSignals(policy, openPositions, kalshiMarkets, now = Date.now()) {
    const signals = [];

    for (const pos of openPositions) {
      // NOTE: this exemption path has no producer in this file — DUAL_SIDE
      // signals aren't generated anywhere, so isDualSide is never true today.
      // Left in place for forward-compatibility; do not rely on it as a
      // safety mechanism until a DUAL_SIDE producer exists and its
      // interaction with OrderExecutor's leg-cancellation logic is confirmed.
      if (pos.isDualSide && pos.dualSideComplete === true) {
        continue;
      }

      const market = kalshiMarkets.find(m => m.ticker === pos.ticker);
      if (!market) continue;
      if (market.quoteStale) continue;

      // Executable BID is market reality
      const currentValue = pos.side === 'yes' ? market.yesBid : market.noBid;
      const entryPrice = pos.priceDecimal;

      if (!currentValue || currentValue <= 0 || !entryPrice) continue;

      // Accurate contract count: ignore unfilled placeholder positions
      const contracts = (pos.filledContracts != null && pos.filledContracts > 0)
        ? pos.filledContracts
        : (pos.contracts || 0);

      if (contracts <= 0) continue;

      const timeRemaining = pos.closeTime - now;

      const openedAt = pos.placedAt || pos.entryTime || pos.openedAt || pos.createdAt || pos.timestamp || now;
      const holdTime = now - openedAt;

      const profitPct = ((currentValue - entryPrice) / entryPrice) * 100;
      const lossPct = ((entryPrice - currentValue) / entryPrice) * 100;
      const unrealizedPnL = (currentValue - entryPrice) * contracts;

      // ----------------------------------------------------
      // 1. EMERGENCY DOLLAR STOP (tail backstop — worse than the soft stop
      //    for max-size positions, so it fires only when the soft stop's
      //    40%-with-grace-period wouldn't have caught it fast enough)
      // ----------------------------------------------------
      const pastEmergencyGrace = holdTime >= policy.emergencyStopGraceMs;
      const emergencyDollarStop = pastEmergencyGrace && unrealizedPnL <= -Math.abs(policy.maxLossPerPosition);

      if (emergencyDollarStop) {
        signals.push({
          type: 'STOP_LOSS', orderId: pos.orderId, ticker: pos.ticker, side: pos.side,
          sellPriceCents: Math.round(currentValue * 100), sellPriceDecimal: currentValue,
          contracts, profitPct, unrealizedPnL,
          reason: `EMERGENCY STOP: -$${Math.abs(unrealizedPnL).toFixed(2)} loss limit breached`,
          priority: 'CRITICAL', executionMode: 'taker',
        });
        continue;
      }

      // ----------------------------------------------------
      // 2. SOFT PERCENTAGE STOP (primary lever — waits past 30s spread noise)
      // ----------------------------------------------------
      const pastGracePeriod = holdTime >= policy.stopLossGracePeriodMs;
      const allowedBeforeSettlement = timeRemaining > policy.stopLossMinTimeRemaining;
      const percentageStop = lossPct >= policy.stopLossPct;

      if (pastGracePeriod && allowedBeforeSettlement && percentageStop) {
        signals.push({
          type: 'STOP_LOSS', orderId: pos.orderId, ticker: pos.ticker, side: pos.side,
          sellPriceCents: Math.round(currentValue * 100), sellPriceDecimal: currentValue,
          contracts, profitPct, unrealizedPnL,
          reason: `Stop loss: position down -${lossPct.toFixed(1)}% after ${Math.round(holdTime / 1000)}s`,
          priority: 'HIGH', executionMode: 'taker',
        });
        continue;
      }

      // ----------------------------------------------------
      // 3. QUICK SCALP (+25% gain, takes instant money)
      // ----------------------------------------------------
      if (policy.enableScalping && profitPct >= policy.scalpQuickProfitPct) {
        signals.push({
          type: 'SCALP_TAKE_PROFIT', orderId: pos.orderId, ticker: pos.ticker, side: pos.side,
          sellPriceCents: Math.round(currentValue * 100), sellPriceDecimal: currentValue,
          contracts, profitPct, unrealizedPnL,
          reason: `Quick scalp: +${profitPct.toFixed(1)}% profit`,
          priority: 'HIGH', executionMode: 'taker',
        });
        continue;
      }

      // ----------------------------------------------------
      // 4. STANDARD SCALP (+15% gain after 15s hold, no dead zone)
      // ----------------------------------------------------
      const pastMinHold = holdTime >= policy.scalpMinHoldMs;
      if (policy.enableScalping && pastMinHold && profitPct >= policy.scalpTakeProfitPct) {
        signals.push({
          type: 'SCALP_TAKE_PROFIT', orderId: pos.orderId, ticker: pos.ticker, side: pos.side,
          sellPriceCents: Math.round(currentValue * 100), sellPriceDecimal: currentValue,
          contracts, profitPct, unrealizedPnL,
          reason: `Scalp exit: +${profitPct.toFixed(1)}% profit after ${Math.round(holdTime / 1000)}s`,
          priority: 'MEDIUM', executionMode: 'taker',
        });
        continue;
      }

      // ----------------------------------------------------
      // 5. LATE-CONTRACT LOCK (last 3 mins, not last 45s: take >=10% to dodge pin risk)
      // ----------------------------------------------------
      if (timeRemaining <= 180 * 1000 && timeRemaining >= 45 * 1000 && profitPct >= 10) {
        signals.push({
          type: 'TAKE_PROFIT', orderId: pos.orderId, ticker: pos.ticker, side: pos.side,
          sellPriceCents: Math.round(currentValue * 100), sellPriceDecimal: currentValue,
          contracts, profitPct, unrealizedPnL,
          reason: `Late-contract lock: +${profitPct.toFixed(1)}% with ${Math.round(timeRemaining / 1000)}s left`,
          priority: 'MEDIUM', executionMode: 'taker',
        });
        continue;
      }

      // ----------------------------------------------------
      // 6. STANDARD TAKE-PROFIT (+35% runner)
      // ----------------------------------------------------
      const maxGain = 1 - entryPrice;
      const gainFraction = maxGain > 0 ? (currentValue - entryPrice) / maxGain : 0;

      if (profitPct >= policy.takeProfitPct || gainFraction >= policy.takeProfitGainFraction) {
        signals.push({
          type: 'TAKE_PROFIT', orderId: pos.orderId, ticker: pos.ticker, side: pos.side,
          sellPriceCents: Math.round(currentValue * 100), sellPriceDecimal: currentValue,
          contracts, profitPct, unrealizedPnL,
          reason: `Take profit: bought@${(entryPrice * 100).toFixed(0)}c sell@${(currentValue * 100).toFixed(0)}c (+${profitPct.toFixed(1)}%)`,
          priority: 'NORMAL', executionMode: 'taker',
        });
      }
    }

    return signals;
  }

module.exports = { generateExitSignals };
