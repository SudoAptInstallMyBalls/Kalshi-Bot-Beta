/**
 * SQLite Analytics Ledger
 *
 * Append-only structured logging for signals, orders, fills, market
 * snapshots — AND now the local ML training pipeline (features/predictions/
 * labels). Everything lives in
 * the same on-disk SQLite file, so there's no separate cloud dependency and
 * no remote connection ambiguity.
 *
 * Linking model:
 *   Every signal gets a `signalId` (UUID) at the moment it's generated
 *   (see signal-generator.js). That same UUID is threaded through:
 *     - ml_features.signal_uuid   (written when ML scores the signal)
 *     - ml_predictions.signal_uuid
 *     - signals.signal_uuid       (written when the order is placed)
 *     - the open position (position.signalUuid)
 *   When a position closes (take-profit, stop-loss, or settlement), the
 *   caller looks up position.signalUuid and calls back into the ML pipeline
 *   to write the outcome label. See mlPipeline.recordOutcome().
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = process.env.BOT_DATA_DIR ? path.resolve(process.env.BOT_DATA_DIR) : require('#src/config/paths').dataDir;
const DB_PATH = path.join(DB_DIR, 'analytics.db');

class AnalyticsDB {
  constructor(dbPath = DB_PATH) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this._createTables();
    this._migrateColumns();
    this._prepareStatements();
  }

  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,
        type          TEXT NOT NULL,
        ticker        TEXT NOT NULL,
        side          TEXT NOT NULL,
        price_cents   INTEGER,
        edge          REAL,
        model_prob    REAL,
        contracts     INTEGER,
        execution_mode TEXT,
        reason        TEXT,
        executed      INTEGER DEFAULT 0,
        blocked_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS orders (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              INTEGER NOT NULL,
        order_id        TEXT UNIQUE NOT NULL,
        client_order_id TEXT,
        signal_id       INTEGER REFERENCES signals(id),
        ticker          TEXT NOT NULL,
        side            TEXT NOT NULL,
        action          TEXT NOT NULL,
        price_cents     INTEGER,
        count           INTEGER,
        status          TEXT,
        fill_count      INTEGER DEFAULT 0,
        taker_fill_cost INTEGER DEFAULT 0,
        taker_fees      INTEGER DEFAULT 0,
        close_time      INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fills (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        order_id    TEXT NOT NULL,
        ticker      TEXT NOT NULL,
        side        TEXT NOT NULL,
        fill_count  INTEGER,
        prev_fills  INTEGER,
        new_fills   INTEGER,
        source      TEXT
      );

      CREATE TABLE IF NOT EXISTS market_snapshots (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,
        ticker        TEXT NOT NULL,
        yes_bid       INTEGER,
        yes_ask       INTEGER,
        no_bid        INTEGER,
        no_ask        INTEGER,
        btc_price     REAL,
        time_remaining_s INTEGER,
        context       TEXT
      );

      CREATE TABLE IF NOT EXISTS ml_features (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,
        signal_uuid   TEXT,
        ticker        TEXT,
        signal_type   TEXT,
        features      TEXT NOT NULL,   -- JSON-encoded numeric array
        label         INTEGER          -- NULL until settlement; 1=won, 0=lost
      );

      CREATE TABLE IF NOT EXISTS ml_predictions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                INTEGER NOT NULL,
        signal_uuid       TEXT,
        model_version     TEXT,
        confidence        REAL,
        predicted_outcome INTEGER,
        features_hash     TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker);
      CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
      CREATE INDEX IF NOT EXISTS idx_orders_ticker ON orders(ticker);
      CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);
      CREATE INDEX IF NOT EXISTS idx_fills_order_id ON fills(order_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_ticker ON market_snapshots(ticker);
      CREATE INDEX IF NOT EXISTS idx_ml_features_uuid ON ml_features(signal_uuid);
      CREATE INDEX IF NOT EXISTS idx_ml_features_label ON ml_features(label);
      CREATE INDEX IF NOT EXISTS idx_ml_predictions_uuid ON ml_predictions(signal_uuid);
    `);
  }

  /**
   * Additive migration for existing databases created before this file's
   * schema grew the signal_uuid / outcome columns. SQLite has no
   * "ADD COLUMN IF NOT EXISTS" on older versions, so check first.
   */
  _migrateColumns() {
    this._addColumnIfMissing('signals', 'signal_uuid TEXT');
    this._addColumnIfMissing('signals', 'outcome_won INTEGER');
    this._addColumnIfMissing('signals', 'outcome_pnl REAL');
    this._addColumnIfMissing('signals', 'settled_at INTEGER');
    this._addColumnIfMissing('ml_features', 'outcome_ts INTEGER');
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_signals_uuid ON signals(signal_uuid);`);
  }

  _addColumnIfMissing(table, columnDef) {
    const columnName = columnDef.split(' ')[0];
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === columnName)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    }
  }

  _prepareStatements() {
    this._insertSignal = this.db.prepare(`
      INSERT INTO signals (ts, type, ticker, side, price_cents, edge, model_prob,
                           contracts, execution_mode, reason, executed, blocked_reason, signal_uuid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._insertOrder = this.db.prepare(`
      INSERT INTO orders (ts, order_id, client_order_id, signal_id, ticker, side,
                          action, price_cents, count, status, fill_count,
                          taker_fill_cost, taker_fees, close_time, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._updateOrder = this.db.prepare(`
      UPDATE orders SET status = ?, fill_count = ?, taker_fill_cost = ?,
                        taker_fees = ?, updated_at = ?
      WHERE order_id = ?
    `);

    this._insertFill = this.db.prepare(`
      INSERT INTO fills (ts, order_id, ticker, side, fill_count, prev_fills, new_fills, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._insertSnapshot = this.db.prepare(`
      INSERT INTO market_snapshots (ts, ticker, yes_bid, yes_ask, no_bid, no_ask,
                                    btc_price, time_remaining_s, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._insertMLFeature = this.db.prepare(`
      INSERT INTO ml_features (ts, signal_uuid, ticker, signal_type, features, label, outcome_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this._updateMLFeatureLabel = this.db.prepare(`
      UPDATE ml_features SET label = ?, outcome_ts = ?
      WHERE signal_uuid = ? AND label IS NULL
    `);

    this._selectTrainingData = this.db.prepare(`
      SELECT * FROM (
        SELECT id, ts, ticker, outcome_ts, features, label FROM ml_features
        WHERE label IS NOT NULL AND outcome_ts IS NOT NULL ORDER BY ts DESC, id DESC LIMIT ?
      ) ORDER BY ts ASC, id ASC
    `);

    this._insertMLPrediction = this.db.prepare(`
      INSERT INTO ml_predictions (ts, signal_uuid, model_version, confidence, predicted_outcome, features_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this._updateSignalOutcome = this.db.prepare(`
      UPDATE signals SET outcome_won = ?, outcome_pnl = ?, settled_at = ?
      WHERE signal_uuid = ?
    `);

    this._selectRecentSignals = this.db.prepare(`
      SELECT * FROM signals WHERE ticker = ? AND ts >= ? ORDER BY ts DESC LIMIT 50
    `);

    this._selectSettledSignalsSince = this.db.prepare(`
      SELECT type, outcome_won, outcome_pnl, edge FROM signals
      WHERE settled_at IS NOT NULL AND ts >= ?
    `);
  }

  // ===== Signals =====

  /**
   * Log a signal (generated or blocked). If `signal.signalId` is present
   * (set at generation time in signal-generator.js) it's stored as
   * signal_uuid so ml_features / ml_predictions / orders can all be joined
   * back to this row later.
   */
  logSignal(signal, executed = false, blockedReason = null) {
    try {
      const result = this._insertSignal.run(
        Date.now(),
        signal.type,
        signal.ticker,
        signal.side,
        signal.priceCents,
        signal.edge,
        signal.modelProb,
        signal.contracts,
        signal.executionMode || 'taker',
        signal.reason,
        executed ? 1 : 0,
        blockedReason,
        signal.signalId || null
      );
      return result.lastInsertRowid;
    } catch (err) {
      console.error('[DB] logSignal error:', err.message);
      return null;
    }
  }

  updateSignalOutcome(signalUuid, { won, pnl }) {
    if (!signalUuid) return;
    try {
      this._updateSignalOutcome.run(won ? 1 : 0, pnl, Date.now(), signalUuid);
    } catch (err) {
      console.error('[DB] updateSignalOutcome error:', err.message);
    }
  }

  getRecentSignals(ticker, hours = 24) {
    try {
      const since = Date.now() - hours * 3600000;
      return this._selectRecentSignals.all(ticker, since) || [];
    } catch (err) {
      console.error('[DB] getRecentSignals error:', err.message);
      return [];
    }
  }

  getStrategyPerformance(days = 7) {
    try {
      const since = Date.now() - days * 86400000;
      const rows = this._selectSettledSignalsSince.all(since) || [];
      const stats = {};
      for (const s of rows) {
        if (!stats[s.type]) stats[s.type] = { wins: 0, losses: 0, pnl: 0, totalEdge: 0, count: 0 };
        const st = stats[s.type];
        st.count++;
        if (s.outcome_won) st.wins++; else st.losses++;
        st.pnl += s.outcome_pnl || 0;
        st.totalEdge += s.edge || 0;
      }
      return stats;
    } catch (err) {
      console.error('[DB] getStrategyPerformance error:', err.message);
      return {};
    }
  }

  // ===== Orders / Fills / Snapshots (unchanged behavior) =====

  logOrder(order, signalId = null) {
    try {
      const now = Date.now();
      this._insertOrder.run(
        now,
        order.order_id,
        order.client_order_id || null,
        signalId,
        order.ticker,
        order.side,
        order.action || 'buy',
        order.price_cents || 0,
        order.count || 0,
        order.status || 'pending',
        order.fill_count || 0,
        order.taker_fill_cost || 0,
        order.taker_fees || 0,
        order.close_time || null,
        now,
        now
      );
    } catch (err) {
      console.error('[DB] logOrder error:', err.message);
    }
  }

  updateOrder(orderId, status, fillCount, takerFillCost = 0, takerFees = 0) {
    try {
      this._updateOrder.run(status, fillCount, takerFillCost, takerFees, Date.now(), orderId);
    } catch (err) {
      console.error('[DB] updateOrder error:', err.message);
    }
  }

  logFill(orderId, ticker, side, fillCount, prevFills, source = 'poll') {
    try {
      this._insertFill.run(
        Date.now(), orderId, ticker, side, fillCount, prevFills, fillCount - prevFills, source
      );
    } catch (err) {
      console.error('[DB] logFill error:', err.message);
    }
  }

  logMarketSnapshot(market, btcPrice, context = 'execution') {
    try {
      const now = Date.now();
      const timeRemaining = market.closeTime ? Math.floor((market.closeTime - now) / 1000) : null;
      this._insertSnapshot.run(
        now, market.ticker,
        market.yesBidCents || Math.round((market.yesBid || 0) * 100),
        market.yesAskCents || Math.round((market.yesAsk || 0) * 100),
        market.noBidCents || Math.round((market.noBid || 0) * 100),
        market.noAskCents || Math.round((market.noAsk || 0) * 100),
        btcPrice || null, timeRemaining, context
      );
    } catch (err) {
      console.error('[DB] logMarketSnapshot error:', err.message);
    }
  }

  // ===== ML Pipeline =====

  /**
   * Log a feature vector for a signal. `label` is null until the position
   * settles — see updateFeatureLabel().
   */
  logFeatures({ signalUuid, ticker, signalType, features, label = null }) {
    try {
      this._insertMLFeature.run(
        Date.now(), signalUuid || null, ticker || null, signalType || null,
        JSON.stringify(features), label, label == null ? null : Date.now()
      );
    } catch (err) {
      console.error('[DB] logFeatures error:', err.message);
    }
  }

  /**
   * Write the outcome label back onto the ml_features row for this signal.
   * This is the piece that was missing entirely before: without this call,
   * getTrainingData() always returns zero rows and the model can never train.
   */
  updateFeatureLabel(signalUuid, label) {
    if (!signalUuid) return false;
    try {
      const result = this._updateMLFeatureLabel.run(label, Date.now(), signalUuid);
      return result.changes > 0;
    } catch (err) {
      console.error('[DB] updateFeatureLabel error:', err.message);
      return false;
    }
  }

  getTrainingData(limit = 10000) {
    try {
      const rows = this._selectTrainingData.all(limit) || [];
      return rows.map(r => ({ ts: r.ts, ticker: r.ticker, outcome_ms: r.outcome_ts, features: JSON.parse(r.features), label: r.label }));
    } catch (err) {
      console.error('[DB] getTrainingData error:', err.message);
      return [];
    }
  }

  logPrediction({ signalUuid, modelVersion, confidence, predictedOutcome, featuresHash }) {
    try {
      this._insertMLPrediction.run(
        Date.now(), signalUuid || null, modelVersion, confidence, predictedOutcome, featuresHash
      );
    } catch (err) {
      console.error('[DB] logPrediction error:', err.message);
    }
  }

  // Do not swallow row errors here: the wrapper must roll back the entire
  // batch so the write-behind queue can retry without duplicates or loss.
  writeMLBatch(features, predictions) {
    this.db.transaction(() => {
      for (const r of features) {
        this._insertMLFeature.run(r.ts, r.signalUuid, r.ticker, r.signalType,
          JSON.stringify(r.features), r.label ?? null, r.outcomeTs ?? null);
      }
      for (const r of predictions) {
        this._insertMLPrediction.run(r.ts, r.signalUuid, r.modelVersion,
          r.confidence, r.predictedOutcome, r.featuresHash);
      }
    })();
  }

  close() {
    try {
      this.db.close();
    } catch (err) {
      // ignore
    }
  }
}

module.exports = AnalyticsDB;
