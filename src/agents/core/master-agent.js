/**
 * MasterAgent — Top-level agent that owns the entire bot lifecycle.
 *
 * Responsibilities:
 *  1. Registers all skills with the SkillRegistry
 *  2. Resolves dependencies and initializes skills in topological order
 *  3. Configures the Orchestrator with routes and workflows
 *  4. Runs the main trading loop (scan → analyze → decide → execute)
 *  5. Handles graceful shutdown
 *
 * The MasterAgent is the single entry point — server.js creates it
 * and calls start()/stop(). Everything else is orchestrated through skills.
 */

const EventEmitter = require('events');
const SkillRegistry = require('#src/agents/core/skill-registry');
const Orchestrator = require('#src/agents/core/orchestrator');
const TradingSafety = require('#src/risk/trading-safety');

// Market Data Skills
const BinancePriceFeed = require('#src/agents/skills/market-data/binance-price-feed');
const PolymarketPriceFeed = require('#src/agents/skills/market-data/polymarket-price-feed');
const RedstonePriceFeed = require('#src/agents/skills/market-data/redstone-price-feed');
const KalshiMarketData = require('#src/agents/skills/market-data/kalshi-market-data');

// Analysis Skills
const ProbabilityModel = require('#src/agents/skills/analysis/probability-model');
const TrendAnalysis = require('#src/agents/skills/analysis/trend-analysis');
const SignalGenerator = require('#src/agents/skills/analysis/signal-generator');
const MLSignalScorer = require('#src/agents/skills/analysis/ml-signal-scorer');

// Trading Skills
const RiskManager = require('#src/agents/skills/trading/risk-manager');
const OrderExecutor = require('#src/agents/skills/trading/order-executor');
const PositionManager = require('#src/agents/skills/trading/position-manager');

// Infrastructure Skills
const StateManager = require('#src/agents/skills/infrastructure/state-manager');
const AnalyticsRecorder = require('#src/agents/skills/infrastructure/analytics-recorder');

class MasterAgent extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.registry = new SkillRegistry();
    this.orchestrator = new Orchestrator(this.registry);

    this.running = false;
    const ScheduledTask = require('./scheduled-task');
    const tasks = require('./periodic-tasks');
    this._periodicTasks = Object.fromEntries(Object.entries({ Scan: 2000, TakeProfit: 3000, Discovery: 15000, BalanceRefresh: 15000 })
      .map(([name, interval]) => [name, new ScheduledTask(() => tasks[`run${name}`](this), interval)]));
    this._scanDone = Promise.resolve();
    this._takeProfitDone = Promise.resolve();

    this._registerSkills();
    this.state.safety = new TradingSafety(this.state, config);
    this._configureRoutes();
    this._configureWorkflows();
  }

  /**
   * Access the state manager skill (used by server.js for snapshot/save).
   */
  get state() {
    const sm = this.registry.get('state-manager');
    return sm ? sm.botState : null;
  }

  // ===== Skill Registration =====

  _registerSkills() {
    // Infrastructure (no dependencies — initialized first)
    this.registry.register(new StateManager());
    this.registry.register(new AnalyticsRecorder());

    // Market Data (depends on state-manager)
    this.registry.register(new BinancePriceFeed());
    this.registry.register(new PolymarketPriceFeed());
    this.registry.register(new RedstonePriceFeed());
    this.registry.register(new KalshiMarketData());

    // Analysis (depends on market data skills)
    this.registry.register(new TrendAnalysis());
    this.registry.register(new ProbabilityModel());
    this.registry.register(new SignalGenerator());
    this.registry.register(new MLSignalScorer());

    // Trading (depends on analysis + market data)
    this.registry.register(new RiskManager());
    this.registry.register(new OrderExecutor());
    this.registry.register(new PositionManager());
  }

  // ===== Route Configuration =====

  _configureRoutes() {
    const o = this.orchestrator;

    // Direct routes — action → skill
    o.route('fetch-balance', 'kalshi-market-data');
    o.route('discover-markets', 'kalshi-market-data');
    o.route('refresh-markets', 'kalshi-market-data');
    o.route('fetch-market', 'kalshi-market-data');
    o.route('reconcile-positions', 'kalshi-market-data');

    o.route('get-binance-price', 'binance-price-feed');
    o.route('get-volatility', 'binance-price-feed');

    o.route('get-polymarket-price', 'polymarket-price-feed');

    o.route('get-redstone-price', 'redstone-price-feed');

    o.route('calculate-probability', 'probability-model');
    o.route('get-trend', 'trend-analysis');

    o.route('generate-signals', 'signal-generator');
    o.route('generate-take-profit-signals', 'signal-generator');

    o.route('score-signal', 'ml-signal-scorer');
    o.route('score-signals', 'ml-signal-scorer');
    o.route('train-model', 'ml-signal-scorer');
    o.route('get-ml-status', 'ml-signal-scorer');

    o.route('check-risk', 'risk-manager');
    o.route('check-position-limits', 'risk-manager');
    o.route('check-balance', 'risk-manager');

    o.route('place-order', 'order-executor');
    o.route('cancel-order', 'order-executor');
    o.route('check-order-status', 'order-executor');

    o.route('take-profit', 'position-manager');
    o.route('settle-position', 'position-manager');

    o.route('save-state', 'state-manager');
    o.route('get-snapshot', 'state-manager');

    o.route('log-signal', 'analytics-recorder');
    o.route('log-order', 'analytics-recorder');
    o.route('log-market-snapshot', 'analytics-recorder');

    // Parallel routes — fetch all price feeds at once
    o.parallel('refresh-all-prices', [
      'binance-price-feed',
      'polymarket-price-feed',
      'redstone-price-feed',
    ]);
  }

  // ===== Workflow Configuration =====

  _configureWorkflows() {
    const o = this.orchestrator;

    // Main scan-and-trade workflow — each step's result merges into ctx for the next
    o.workflow('scan-and-trade', {
      steps: [
        {
          action: 'refresh-markets',
          skill: 'kalshi-market-data',
        },
        {
          action: 'generate-signals',
          skill: 'signal-generator',
        },
        {
          action: 'score-signals',
          skill: 'ml-signal-scorer',
          condition: (ctx) => ctx.signals && ctx.signals.length > 0,
        },
        {
          action: 'evaluate-signals',
          skill: 'risk-manager',
          condition: (ctx) => {
            // Use ML-scored signals if available, otherwise fall back to raw signals
            const sigs = ctx.scoredSignals || ctx.signals;
            return sigs && sigs.length > 0;
          },
        },
        {
          action: 'execute-signals',
          skill: 'order-executor',
          condition: (ctx) => ctx.approvedSignals && ctx.approvedSignals.length > 0,
        },
      ],
    });

    // Take-profit workflow
    o.workflow('check-take-profit', {
      steps: [
        {
          action: 'generate-take-profit-signals',
          skill: 'signal-generator',
        },
        {
          action: 'execute-take-profit',
          skill: 'position-manager',
          condition: (ctx) => ctx.takeProfitSignals && ctx.takeProfitSignals.length > 0,
        },
      ],
    });

    // Startup workflow
    o.workflow('startup', {
      steps: [
        { action: 'fetch-balance', skill: 'kalshi-market-data' },
        { action: 'reconcile-positions', skill: 'kalshi-market-data' },
        { action: 'discover-markets', skill: 'kalshi-market-data' },
      ],
    });
  }

  // ===== Lifecycle =====

  async start() {
    if (this.state.safety.haltReason) throw new Error(`Resolve ${this.state.safety.haltReason} and restart the process`);
    this.state.safety.entriesEnabled = true;
    this.running = true;
    this.log('MasterAgent starting — initializing skills');
    const defaults = require('#src/config/defaults');
    const effective = { ...defaults, ...Object.fromEntries(Object.entries(this.config).filter(([, value]) => typeof value === 'number' || typeof value === 'boolean')) };
    effective.MAX_LOSS_PER_POSITION = this.config.MAX_LOSS_PER_POSITION ?? Math.min(3, effective.MAX_POSITION_SIZE * 0.60);
    this.log(`Effective strategy/risk config: ${JSON.stringify(effective)}`);

    const stateManager = this.registry.get('state-manager');
    stateManager.botState.updateIntent({
      status: 'initializing',
      message: 'Initializing agent skills...',
    });

    // Build shared context for all skills
    const context = {
      config: this.config,
      registry: this.registry,
      orchestrator: this.orchestrator,
    };

    // Initialize skills in dependency order
    const initOrder = this.registry.getInitOrder();
    this.log(`Init order: ${initOrder.join(' → ')}`);

    for (const skillName of initOrder) {
      const skill = this.registry.get(skillName);
      try {
        await skill.initialize(context);
        this.log(`  initialized ${skillName}`);
      } catch (err) {
        this.log(`  ${skillName} failed: ${err.message}`, 'ERROR');
        throw err;
      }
    }

    // Start all skills
    for (const skillName of initOrder) {
      const skill = this.registry.get(skillName);
      try {
        await skill.start();
      } catch (err) {
        this.log(`  ${skillName} start failed: ${err.message}`, 'ERROR');
      }
    }

    this.log('All skills started');

    // Run startup workflow: fetch balance → reconcile positions → discover markets
    stateManager.botState.updateIntent({
      status: 'initializing',
      message: 'Connecting to Kalshi...',
    });

    const startupResult = await this.orchestrator.dispatch({
      action: 'startup',
      workflow: 'startup',
      params: {},
    });

    if (!startupResult.success) {
      this.log(`Startup workflow failed: ${JSON.stringify(startupResult)}`, 'WARN');
      this.log('Continuing anyway — periodic refresh will retry Kalshi connection', 'WARN');
    } else {
      const balance = stateManager.botState.balance;
      this.log(`Kalshi connected. Balance: $${balance.total.toFixed(2)}`);
      this.log(`Tracking ${stateManager.botState.activeMarkets.length} markets (${this.config.SERIES_TICKER})`);
    }

    // Wait for Binance price feed
    stateManager.botState.updateIntent({
      status: 'waiting',
      message: 'Waiting for Binance price feed...',
    });

    try {
      await this._waitForPrice();
    } catch (err) {
      stateManager.botState.updateIntent({
        status: 'error',
        message: 'Binance price feed unavailable; trading remains stopped',
      });
      this.log(`Startup aborted: ${err.message}`, 'ERROR');
      await this.stop();
      throw err;
    }

    // Start periodic auto-trade loops
    for (const task of Object.values(this._periodicTasks)) task.start();

    stateManager.botState.updateIntent({
      status: 'scanning',
      message: 'Scanning for opportunities...',
    });

    this.log('Engine running. All systems active.');
    return stateManager.botState;
  }

  async _waitForPrice(timeoutMs = 15000) {
    const stateManager = this.registry.get('state-manager');
    const validPrice = () => {
      const price = Number(stateManager.botState.btcPrice.binance);
      return Number.isFinite(price) && price > 0 ? price : null;
    };

    const initial = validPrice();
    if (initial) {
      this.log(`BTC price: $${initial.toFixed(2)}`);
      return initial;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, price) => {
        if (settled) return;
        settled = true;
        clearInterval(check);
        clearTimeout(timeout);
        if (err) reject(err);
        else resolve(price);
      };

      const check = setInterval(() => {
        const price = validPrice();
        if (price) {
          this.log(`BTC price: $${price.toFixed(2)}`);
          finish(null, price);
        }
      }, 500);

      const timeout = setTimeout(() => {
        finish(new Error(`No valid Binance BTC price received within ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  // ===== Periodic Auto-Trade Runners =====

  _scanRunning = false;

  /**
   * Main auto-trade loop. Runs every 2 seconds:
   *   refresh markets → generate signals → risk check → execute orders
   */
  _runScan() {
    return this._periodicTasks?.Scan.run() ?? require("./periodic-tasks").runScan(this);
  }

  /**
   * Take-profit loop. Runs every 3 seconds for open positions.
   * Sells positions that hit >15% gain or >50% of max possible gain.
   */
  _runTakeProfit() {
    return this._periodicTasks?.TakeProfit.run() ?? require("./periodic-tasks").runTakeProfit(this);
  }

  /**
   * Market discovery. Runs every 15 seconds.
   * Finds new active contracts in the KXBTC15M series.
   */
  _runDiscovery() {
    return this._periodicTasks?.Discovery.run() ?? require("./periodic-tasks").runDiscovery(this);
  }

  /**
   * Balance refresh. Runs every 15 seconds.
   */
  _runBalanceRefresh() {
    return this._periodicTasks?.BalanceRefresh.run() ?? require("./periodic-tasks").runBalanceRefresh(this);
  }

  // ===== Shutdown =====

  async stop() {
    this.running = false;
    this.state.safety.entriesEnabled = false;

    await Promise.all(Object.values(this._periodicTasks || {}).map(task => task.stop()));

    // Drain work already in flight before stopping the scorer's write buffer.
    await Promise.all([this._scanDone, this._takeProfitDone]);

    // Stop all skills in reverse init order
    const initOrder = this.registry.getInitOrder();
    for (const skillName of [...initOrder].reverse()) {
      try {
        const skill = this.registry.get(skillName);
        if (skill && typeof skill.stop === 'function') {
          await Promise.resolve(skill.stop());
        }
      } catch (err) {
        this.log(`  ${skillName} stop failed: ${err.message}`, 'WARN');
      }
    }

    const stateManager = this.registry.get('state-manager');
    if (stateManager) {
      stateManager.botState.updateIntent({ status: 'stopped', message: 'Bot stopped' });
      const stats = stateManager.botState.stats;
      this.log(`Shutdown. Trades: ${stats.totalTrades} | P&L: $${stats.totalPnL.toFixed(2)}`);
    }
  }

  // ===== Logging =====

  log(msg, level = 'INFO') {
    const ts = new Date().toISOString();
    const colors = { INFO: '\x1b[36m', SUCCESS: '\x1b[32m', ERROR: '\x1b[31m', WARN: '\x1b[33m' };
    console.log(`${colors[level] || ''}[${ts}] [MasterAgent] [${level}]\x1b[0m ${msg}`);

    const stateManager = this.registry.get('state-manager');
    if (stateManager && stateManager.botState) {
      stateManager.botState.logTrade({
        type: 'LOG',
        level,
        message: `[MasterAgent] ${msg}`,
      });
    }
  }
}

module.exports = MasterAgent;
