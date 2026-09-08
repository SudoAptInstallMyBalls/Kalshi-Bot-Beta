// Loop bodies accept an injected owner (state, orchestrator, config, log).
async function runScan(agent) {
  if (agent._scanRunning || !agent.running) return;
  const safety = agent.state.safety.check();
  if (!safety.approved) {
    agent.state.safety.publish(safety.reason);
    return;
  }
  agent._scanRunning = true;
  let scanDone;
  agent._scanDone = new Promise(resolve => { scanDone = resolve; });

  const state = agent.state;

  try {
    const result = await agent.orchestrator.dispatch({
      action: 'scan-and-trade',
      workflow: 'scan-and-trade',
      params: {},
    });

    if (!result.success) {
      if (result.failedStep) {
        agent.log(`Scan workflow failed at step '${result.failedStep}': ${result.stepResults?.find(s => !s.success)?.error || 'unknown'}`, 'ERROR');
      }
      return;
    }

    // Extract results from workflow context to update UI intent
    const ctx = result.context || {};
    const signals = ctx.signals || [];
    const executedSignals = ctx.executedSignals || [];
    const totalExecuted = ctx.totalExecuted || 0;
    const afterScan = state.safety.check();
    if (!afterScan.approved) {
      state.safety.publish(afterScan.reason);
      return;
    }

    if (signals.length > 0) {
      const best = signals[0];
      state.updateIntent({
        status: totalExecuted > 0 ? 'executing' : 'signal_detected',
        message: totalExecuted > 0
          ? `Executed ${totalExecuted} trade(s)`
          : `${best.type}: ${best.reason}`,
        lastSignal: best,
        modelProbability: best.modelProb,
        currentEdge: best.edge,
        action: `BUY ${best.side.toUpperCase()} @ ${best.priceCents}c`,
      });

      // Log signal activity
      if (totalExecuted > 0) {
        for (const exec of executedSignals) {
          if (exec.status === 'executed') {
            agent.log(`Order accepted: ${exec.signal} → ${exec.orderId} (fills tracked separately)`, 'SUCCESS');
          } else if (exec.status === 'blocked') {
            agent.log(`Blocked: ${exec.signal} (${exec.reason})`, 'WARN');
          } else if (exec.status === 'error') {
            agent.log(`Execution error: ${exec.signal} — ${exec.error}`, 'ERROR');
          }
        }
      }
    } else {
      const labels = require('#src/risk/rejection-reasons').rejectionLabels(agent.config);
      const reasons = Object.entries(ctx.diagnostics || {}).filter(([, n]) => n > 0)
        .map(([key]) => labels[key] || key);
      state.updateIntent({
        status: 'scanning',
        message: reasons.length ? `No entry: ${reasons.join('; ')}` : 'Scanning for opportunities...',
        currentEdge: null,
        action: null,
      });
    }
  } catch (err) {
    agent.log(`Scan error: ${err.message}`, 'ERROR');
  } finally {
    agent._scanRunning = false;
    scanDone();
  }
}

async function runTakeProfit(agent) {
  if (!agent.running || agent._takeProfitRunning || agent.state.safety.authFailed) return;
  const state = agent.state;
  if (!state || state.openPositions.length === 0) return;
  agent._takeProfitRunning = true;
  let takeProfitDone;
  agent._takeProfitDone = new Promise(resolve => { takeProfitDone = resolve; });

  try {
    // Pausing entry scans must not strand exits with stale cached quotes.
    if (!state.safety.check().approved) {
      await agent.orchestrator.dispatch({ action: 'refresh-markets', params: {} });
    }
    const result = await agent.orchestrator.dispatch({
      action: 'check-take-profit',
      workflow: 'check-take-profit',
      params: {},
    });

    if (!result.success) return;

    const ctx = result.context || {};
    const tpSignals = ctx.takeProfitSignals || [];
    const tpResults = ctx.results || [];

    for (let i = 0; i < tpResults.length; i++) {
      const tp = tpSignals[i];
      const res = tpResults[i];
      if (!tp) continue;

      if (res.status === 'sold') {
        state.updateIntent({
          status: 'taking_profit',
          message: `Take profit on ${tp.ticker}`,
          action: `SELL ${tp.side.toUpperCase()} @ ${tp.sellPriceCents}c`,
        });
        agent.log(
          `Take profit: ${tp.ticker} ${tp.side} @ ${tp.sellPriceCents}c (+${tp.profitPct.toFixed(1)}%) | P&L: ${res.pnl >= 0 ? '+' : ''}$${res.pnl.toFixed(2)}`,
          res.pnl >= 0 ? 'SUCCESS' : 'WARN'
        );
      } else if (res.status === 'error') {
        agent.log(`Take profit error: ${tp.ticker} — ${res.error}`, 'ERROR');
      }
    }
  } catch (err) {
    agent.log(`Take profit error: ${err.message}`, 'ERROR');
  } finally {
    agent._takeProfitRunning = false;
    takeProfitDone();
  }
}

async function runDiscovery(agent) {
  if (!agent.running || agent.state.safety.authFailed) return;
  try {
    const result = await agent.orchestrator.dispatch({ action: 'discover-markets', params: {} });
    if (result.success && result.count > 0) {
      agent.log(`Tracking ${result.count} markets (${agent.config.SERIES_TICKER})`);
    }
  } catch (err) {
    agent.log(`Discovery error: ${err.message}`, 'ERROR');
  }
}

async function runBalanceRefresh(agent) {
  if (!agent.running || agent.state.safety.authFailed) return;
  try {
    await agent.orchestrator.dispatch({ action: 'fetch-balance', params: {} });
  } catch (err) {
    agent.log(`Balance refresh error: ${err.message}`, 'WARN');
  }
}
module.exports = { runScan, runTakeProfit, runDiscovery, runBalanceRefresh };
