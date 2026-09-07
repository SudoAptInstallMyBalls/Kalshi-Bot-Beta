const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const BotState = require('#src/storage/bot-state');
const AnalyticsDB = require('#src/storage/analytics-db');
const split = require('#src/ml/training-split');

test('market grouping prevents duplicate contract labels from straddling splits', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ ticker: `m${i}`, ts: i * 100, outcome_ms: i * 100 + 50 }));
  const groups = split(rows.flatMap(r => [r, { ...r, ts: r.ts + 10 }]));
  const names = Object.values(groups).map(part => new Set(part.map(r => r.ticker)));
  assert.deepEqual(Object.values(groups).map(part => part.length), [14, 2, 4]);
  assert.ok([...names[0]].every(ticker => !names[1].has(ticker) && !names[2].has(ticker)));
});

test('labels resolved in a later split and labels without timestamps are excluded', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ ticker: `m${i}`, ts: i * 100, outcome_ms: i * 100 + 50 }));
  rows[6].outcome_ms = 800;
  const groups = split([...rows, { ticker: 'unknown', ts: 100 }]);
  assert.equal(groups.training.length, 6);
  assert.ok(!groups.training.some(r => r.ticker === 'm6'));
});

test('execution labels record when known; legacy labels with unknown timing are excluded', () => {
  const db = new AnalyticsDB(':memory:');
  try {
    db.writeMLBatch([{ ts: 1, signalUuid: 'new', ticker: 'm', signalType: 'DIRECTIONAL', features: Array(27).fill(0) },
      { ts: 1, signalUuid: 'old', ticker: 'old', signalType: 'DIRECTIONAL', features: Array(27).fill(0), label: 1 }], []);
    db.updateFeatureLabel('new', 1);
    const rows = db.getTrainingData();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ticker, 'm');
    assert.ok(rows[0].outcome_ms >= rows[0].ts);
  } finally { db.close(); }
});

test('failed durable state write throws and halts instead of allowing an untracked POST', t => {
  t.mock.method(BotState.prototype, '_loadState', () => {});
  t.mock.method(fs, 'existsSync', () => true);
  t.mock.method(fs, 'writeFileSync', () => { throw new Error('disk full'); });
  const state = new BotState();
  state.safety = { halt: reason => { state.haltReason = reason; } };
  assert.throws(() => state.saveNow(), /disk full/);
  assert.equal(state.persistenceFailed, true);
  assert.equal(state.haltReason, 'state_persistence_failed');
});
