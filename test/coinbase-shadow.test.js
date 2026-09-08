const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { CoinbaseRecorder } = require('../src/research/coinbase-recorder.js');
const { evaluateCoinbaseShadow } = require('../src/research/coinbase-shadow.js');

const TEST_DB = path.join(__dirname, 'test-coinbase.sqlite');

function cleanupDb() {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + ext); } catch {}
  }
}

describe('CoinbaseRecorder: record() ingestion invariants', () => {
  let recorder;

  beforeEach(() => {
    cleanupDb();
    recorder = new CoinbaseRecorder(TEST_DB);
  });

  afterEach(() => {
    recorder.db.close();
    cleanupDb();
  });

  it('rejects ticks with wrong product_id or message type', () => {
    const wrongProduct = {
      type: 'ticker',
      product_id: 'ETH-USD',
      price: '3200.50',
      best_bid: '3200.00',
      best_ask: '3201.00',
      time: '2026-09-07T12:00:00.000Z'
    };
    assert.equal(recorder.record(wrongProduct, Date.parse('2026-09-07T12:00:00.100Z')), false);

    const wrongType = {
      type: 'heartbeat',
      product_id: 'BTC-USD',
      price: '65000.00',
      best_bid: '64995.00',
      best_ask: '65005.00',
      time: '2026-09-07T12:00:01.000Z'
    };
    assert.equal(recorder.record(wrongType, Date.parse('2026-09-07T12:00:01.100Z')), false);

    const count = recorder.db.prepare('SELECT count(*) as count FROM proxy_ticks').get().count;
    assert.equal(count, 0);
  });

  it('rejects ticks beyond the bounded future-clock tolerance', () => {
    const futureTick = {
      type: 'ticker',
      product_id: 'BTC-USD',
      price: '65000.00',
      best_bid: '64999.00',
      best_ask: '65001.00',
      time: '2026-09-07T12:00:05.000Z'
    };
    const receivedMs = Date.parse('2026-09-07T12:00:04.000Z');
    assert.equal(recorder.record(futureTick, receivedMs), false);

    const count = recorder.db.prepare('SELECT count(*) as count FROM proxy_ticks').get().count;
    assert.equal(count, 0);
  });

  it('rejects stale receipt latency (>5000ms delay)', () => {
    const eventTime = '2026-09-07T12:00:00.000Z';
    const eventMs = Date.parse(eventTime);

    const staleTick = {
      type: 'ticker',
      product_id: 'BTC-USD',
      price: '65000.00',
      best_bid: '64999.00',
      best_ask: '65001.00',
      time: eventTime
    };

    assert.equal(recorder.record(staleTick, eventMs + 5001), false);
    assert.equal(recorder.record(staleTick, eventMs + 1200), true);

    const count = recorder.db.prepare('SELECT count(*) as count FROM proxy_ticks').get().count;
    assert.equal(count, 1);
  });

  it('rejects non-monotonic event_ms', () => {
    const tick1 = {
      type: 'ticker',
      product_id: 'BTC-USD',
      price: '65000.00',
      best_bid: '64999.00',
      best_ask: '65001.00',
      time: '2026-09-07T12:00:02.000Z'
    };
    const tick2Outdated = {
      type: 'ticker',
      product_id: 'BTC-USD',
      price: '65010.00',
      best_bid: '65009.00',
      best_ask: '65011.00',
      time: '2026-09-07T12:00:01.999Z'
    };
    const tick3Monotonic = {
      type: 'ticker',
      product_id: 'BTC-USD',
      price: '65020.00',
      best_bid: '65019.00',
      best_ask: '65021.00',
      time: '2026-09-07T12:00:03.000Z'
    };

    assert.equal(recorder.record(tick1, Date.parse('2026-09-07T12:00:02.200Z')), true);
    assert.equal(recorder.record(tick2Outdated, Date.parse('2026-09-07T12:00:02.300Z')), false);
    assert.equal(recorder.record(tick3Monotonic, Date.parse('2026-09-07T12:00:03.200Z')), true);

    const count = recorder.db.prepare('SELECT count(*) as count FROM proxy_ticks').get().count;
    assert.equal(count, 2);
  });

  it('confirms receipt-second deduplication using INSERT OR IGNORE', () => {
    const tickA = {
      type: 'ticker',
      product_id: 'BTC-USD',
      price: '65000.00',
      best_bid: '64999.00',
      best_ask: '65001.00',
      time: '2026-09-07T12:00:00.100Z'
    };
    const tickB = {
      type: 'ticker',
      product_id: 'BTC-USD',
      price: '65005.00',
      best_bid: '65004.00',
      best_ask: '65006.00',
      time: '2026-09-07T12:00:00.500Z'
    };
    const tickNextSecond = {
      type: 'ticker',
      product_id: 'BTC-USD',
      price: '65010.00',
      best_bid: '65009.00',
      best_ask: '65011.00',
      time: '2026-09-07T12:00:01.100Z'
    };

    assert.equal(recorder.record(tickA, Date.parse('2026-09-07T12:00:00.200Z')), true);
    assert.equal(recorder.record(tickB, Date.parse('2026-09-07T12:00:00.800Z')), false);
    assert.equal(recorder.db.prepare('SELECT count(*) as count FROM proxy_ticks').get().count, 1);

    assert.equal(recorder.record(tickNextSecond, Date.parse('2026-09-07T12:00:01.200Z')), true);
    assert.equal(recorder.db.prepare('SELECT count(*) as count FROM proxy_ticks').get().count, 2);
  });
});

describe('evaluateCoinbaseShadow: missing reasons & settlement average', () => {
  let historyDb;
  let coinbaseDb;

  const baseTs = 1788782400000;
  const openTime = baseTs - 5 * 60000;
  const closeTime = baseTs + 10 * 60000;

  beforeEach(() => {
    historyDb = new Database(':memory:');
    historyDb.exec(`
      CREATE TABLE markets (
        ticker TEXT PRIMARY KEY,
        open_time TEXT NOT NULL,
        close_time TEXT NOT NULL,
        floor_strike REAL NOT NULL,
        expiration_value TEXT,
        result TEXT
      );
    `);

    coinbaseDb = new Database(':memory:');
    coinbaseDb.exec(`
      CREATE TABLE proxy_ticks (
        second_ms INTEGER PRIMARY KEY,
        event_ms INTEGER NOT NULL,
        received_ms INTEGER NOT NULL,
        price REAL NOT NULL,
        bid REAL NOT NULL,
        ask REAL NOT NULL,
        source TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );
    `);
  });

  afterEach(() => {
    historyDb.close();
    coinbaseDb.close();
  });

  function insertMarket({ ticker = 'KXBTC15M-TEST-0', open = openTime, close = closeTime, strike = 65000, expVal = '65200' } = {}) {
    historyDb.prepare(`
      INSERT INTO markets (ticker, open_time, close_time, floor_strike, expiration_value, result)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ticker, new Date(open).toISOString(), new Date(close).toISOString(), strike, expVal, 'yes');
  }

  function insertTick(secondMs, price = 65000.0, lagMs = 100) {
    coinbaseDb.prepare(`
      INSERT OR IGNORE INTO proxy_ticks VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(secondMs, secondMs - lagMs, secondMs, price, price - 1, price + 1, 'coinbase:BTC-USD:ticker', '{}');
  }

  function populateCompletedMinutes(endTs, minutes = 20, basePrice = 65000.0) {
    // completedMinutes requires ticks within the final 5s of each minute (avail - tick <= 5000)
    for (let i = 0; i < minutes; i++) {
      const avail = endTs - (minutes - 1 - i) * 60000;
      const t = avail - 1000;
      insertTick(t, basePrice + (i % 2 === 0 ? 10 : -10));
    }
  }

  it('classifies settlement_window_unobserved when decision ts is within final 60s of close', () => {
    insertMarket();
    const baselineRows = [{
      ticker: 'KXBTC15M-TEST-0',
      openTime,
      closeTime,
      ts: closeTime - 30000
    }];

    const report = evaluateCoinbaseShadow(historyDb, coinbaseDb, baselineRows, 0);
    assert.equal(report.missing.settlement_window_unobserved, 1);
  });

  it('classifies missing_or_stale_coinbase when ticks are absent or stale', () => {
    insertMarket();
    const baselineRows = [{
      ticker: 'KXBTC15M-TEST-0',
      openTime,
      closeTime,
      ts: baseTs
    }];

    const report = evaluateCoinbaseShadow(historyDb, coinbaseDb, baselineRows, 0);
    assert.equal(report.missing.missing_or_stale_coinbase, 1);
  });

  it('classifies coinbase_volatility_gap when minute volatility cannot be formed', () => {
    insertMarket();
    // Only 2 ticks: insufficient completed minutes -> sigma === null
    insertTick(openTime, 65000.0);
    insertTick(baseTs, 65020.0);

    const baselineRows = [{
      ticker: 'KXBTC15M-TEST-0',
      openTime,
      closeTime,
      ts: baseTs
    }];

    const report = evaluateCoinbaseShadow(historyDb, coinbaseDb, baselineRows, 0);
    assert.equal(report.missing.coinbase_volatility_gap, 1);
  });

  it('classifies forecast_unavailable when forecast model is not ready', () => {
    // Valid 20 completed minutes for sigma, but strike: 0 causes averageForecast to return ready: false
    insertMarket({ strike: 0 });
    populateCompletedMinutes(baseTs, 20);
    insertTick(openTime, 65000.0);
    insertTick(baseTs, 65000.0);

    const baselineRows = [{
      ticker: 'KXBTC15M-TEST-0',
      openTime,
      closeTime,
      ts: baseTs
    }];

    const report = evaluateCoinbaseShadow(historyDb, coinbaseDb, baselineRows, 0);
    assert.equal(report.missing.forecast_unavailable, 1);
  });

  it('skips settlement average calculation when samples.length !== 60', () => {
    insertMarket();
    // Populate only 40 samples (terminal 20-second gap > 5000ms latency breaks observation)
    for (let i = 0; i < 40; i++) {
      const t = closeTime - 60000 + i * 1000;
      insertTick(t, 65150.0);
    }

    const report = evaluateCoinbaseShadow(historyDb, coinbaseDb, [], 0);
    assert.equal(report.settlements.length, 0, 'Settlement must be skipped if samples.length !== 60');
  });

  it('computes full settlement average when samples.length === 60', () => {
    insertMarket({ strike: 65000, expVal: '65200' });
    // Populate full 60 contiguous 1-second samples
    for (let i = 0; i < 60; i++) {
      const t = closeTime - 60000 + i * 1000;
      insertTick(t, 65200.0);
    }

    const report = evaluateCoinbaseShadow(historyDb, coinbaseDb, [], 0);
    assert.equal(report.settlements.length, 1);
    assert.equal(report.settlements[0].ticker, 'KXBTC15M-TEST-0');
    assert.equal(report.settlements[0].coinbaseAverage, 65200.0);
    assert.equal(report.settlements[0].official, 65200.0);
    assert.equal(report.settlements[0].errorBps, 0);
  });
});