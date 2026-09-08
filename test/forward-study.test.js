const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { root } = require('#src/config/paths');
const { createStudyStore, parseStudyArgs, read, verify } = require('#src/research/forward-study');
const { main: runStudy } = require('../scripts/run-forward-study');
const { evaluateForecasts } = require('#src/research/settlement-evaluation');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'study-version-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'src/policy.js'), 'module.exports = 1;\n');
  let clock = Date.parse('2026-09-08T00:00:00Z');
  const store = createStudyStore({ repositoryRoot: directory, now: () => clock,
    listPolicyFiles: () => fs.readdirSync(path.join(directory, 'src')).map(name => `src/${name}`) });
  return { directory, store, advance: ms => { clock += ms; }, now: () => clock,
    change: () => fs.writeFileSync(path.join(directory, 'src/policy.js'), 'module.exports = 2;\n') };
}

test('registered v3 verifies the current checkout and pins new helpers and study entrypoints', () => {
  assert.throws(() => verify('v2'), /changed/);
  const study = verify('v3');
  assert.ok(Date.parse(study.cutoff) > Date.parse(study.frozenAt));
  assert.equal(study.alreadyInspectedForwardMarkets, 0);
  for (const file of ['src/config/defaults.js', 'src/research/replay-registry.js',
    'src/research/forward-study.js', 'scripts/run-forward-study.js', 'scripts/evaluate-settlement-models.js']) {
    assert.match(study.policySha256[file], /^[a-f0-9]{64}$/);
  }
});

test('version parser requires valid explicit selectors and refuses duplicates and path traversal', () => {
  assert.equal(parseStudyArgs([]), 'v1');
  assert.equal(parseStudyArgs(['--study', 'v2']), 'v2');
  for (const args of [['--study'], ['--study', '../v2'], ['--study', 'v0'], ['--study', 'v2', '--study', 'v3'], ['--cutoff', 'now']]) {
    assert.throws(() => parseStudyArgs(args));
  }
});

test('new versions declare a future cutoff, pin source and never overwrite earlier manifests', t => {
  const { store, now, change, advance } = fixture(t);
  const first = store.freeze({ version: 'v2' });
  assert.equal(first.alreadyInspectedForwardMarkets, 0);
  assert.ok(Date.parse(first.cutoff) >= now() + 900000);
  assert.deepEqual(store.verify('v2'), first);
  const before = fs.readFileSync(store.manifestPath('v2'));
  assert.throws(() => store.freeze({ version: 'v2' }), /already exists/);
  change();
  assert.throws(() => store.verify('v2'), /v2 changed: src\/policy.js/);
  advance(1000);
  const next = store.freeze({ version: 'v3' });
  assert.notDeepEqual(next.policySha256, first.policySha256);
  assert.deepEqual(store.verify('v3'), next);
  assert.deepEqual(fs.readFileSync(store.manifestPath('v2')), before);
  assert.throws(() => store.verify('v2'), /v2 changed/);
  fs.appendFileSync(path.join(path.dirname(store.manifestPath('v2')), '../../src/policy.js'), '// changed again');
  assert.throws(() => store.verify('v3'), /v3 changed/);
});

test('new study refuses retrospective cutoffs, missing versions and legacy refreezing', t => {
  const { store, now } = fixture(t);
  for (const cutoff of ['bad', new Date(now()).toISOString(), new Date(now() - 1).toISOString()]) {
    assert.throws(() => store.freeze({ version: 'v2', cutoff }), /future/);
  }
  assert.throws(() => store.freeze(), /cannot be recreated/);
  assert.throws(() => store.freeze({ version: 'v1' }), /cannot be recreated/);
  assert.equal(fs.existsSync(store.manifestPath('v2')), false);
});

test('declaration edits, added source files and removed source files fail verification', t => {
  const { store, directory } = fixture(t);
  store.freeze({ version: 'v2' });
  const file = store.manifestPath('v2'), original = fs.readFileSync(file);
  const edited = JSON.parse(original); edited.cutoff = '2027-01-01T00:00:00Z';
  fs.writeFileSync(file, JSON.stringify(edited));
  assert.throws(() => store.verify('v2'), /manifest changed/);
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(directory, 'src/helper.js'), 'module.exports = 1;');
  assert.throws(() => store.verify('v2'), /file set changed/);
  fs.unlinkSync(path.join(directory, 'src/helper.js'));
  fs.unlinkSync(path.join(directory, 'src/policy.js'));
  assert.throws(() => store.verify('v2'), /file set changed/);
});

test('new hashes tolerate checkout line endings but still reject code changes', t => {
  const { store, directory } = fixture(t);
  store.freeze({ version: 'v2' });
  fs.writeFileSync(path.join(directory, 'src/policy.js'), 'module.exports = 1;\r\n');
  assert.equal(store.verify('v2').id, 'settlement-forward-v2');
});

test('legacy declaration stays byte-identical and v1 still rejects source mismatches', t => {
  const { store, directory } = fixture(t);
  fs.mkdirSync(path.dirname(store.manifestPath('v1')), { recursive: true });
  const original = fs.readFileSync(path.join(root, 'config/research/forward-study.json'));
  fs.writeFileSync(store.manifestPath('v1'), original);
  const legacy = read('v1');
  for (const file of Object.keys(legacy.policySha256)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), 'changed legacy code');
  }
  assert.equal(store.read('v1').id, 'settlement-forward-v1');
  assert.throws(() => store.verify('v1'), /Frozen forward study v1 changed/);
  assert.throws(() => store.freeze({ version: 'v1' }), /cannot be recreated/);
  assert.deepEqual(fs.readFileSync(store.manifestPath('v1')), original);
});

test('runner waits before the cutoff without fetching data or overwriting any report', async t => {
  const { store, now } = fixture(t);
  store.freeze({ version: 'v2' });
  const unexpected = () => { throw Error('Should not run'); };
  const result = await runStudy(['--study', 'v2'], { store, now, refreshData: unexpected, evaluate: unexpected });
  assert.equal(result.status, 'waiting_for_cutoff');
  assert.equal(fs.existsSync(store.outputPaths('v2').directory), false);
});

test('runner selects the same version for refresh and evaluation and isolates results', async t => {
  const { store, now, advance } = fixture(t);
  store.freeze({ version: 'v2' });
  store.freeze({ version: 'v3' });
  advance(3600000);
  const calls = [];
  for (const version of ['v2', 'v3']) {
    const result = await runStudy(['--study', version], { store, now,
      refreshData: async options => { calls.push(options); },
      evaluate: async args => { calls.push(args); return { directory: path.join(store.outputPaths(version).evaluations, 'report') }; } });
    assert.equal(result.studyId, `settlement-forward-${version}`);
    assert.equal(fs.existsSync(store.outputPaths(version).lock), false);
    assert.equal(JSON.parse(fs.readFileSync(store.outputPaths(version).latest)).studyId, result.studyId);
  }
  assert.deepEqual(calls, [{ version: 'v2' }, ['--study', 'v2', '--coinbase-shadow'],
    { version: 'v3' }, ['--study', 'v3', '--coinbase-shadow']]);
  assert.notEqual(store.outputPaths('v1').latest, store.outputPaths('v2').latest);
});

test('runner rechecks source after refresh and never advances latest on failure', async t => {
  const { store, now, advance, change } = fixture(t);
  store.freeze({ version: 'v2' }); advance(3600000);
  const outputs = store.outputPaths('v2');
  fs.mkdirSync(outputs.directory, { recursive: true });
  fs.writeFileSync(outputs.latest, 'old report');
  await assert.rejects(runStudy(['--study', 'v2'], { store, now, refreshData: async () => change(),
    evaluate: () => { throw Error('Must not evaluate drifted code'); } }), /v2 changed/);
  assert.equal(fs.readFileSync(outputs.latest, 'utf8'), 'old report');
  assert.equal(fs.existsSync(outputs.lock), false);
});

test('prospective forecast scores exclude earlier markets but retain prior calibration context', () => {
  const cutoff = Date.parse('2026-09-08T01:00:00Z');
  const markets = [-900000, 0, 900000].map((delta, i) => ({ ticker: `KXBTC15M-${i}`, floor_strike: 100,
    open_time: new Date(cutoff + delta).toISOString(), close_time: new Date(cutoff + delta + 900000).toISOString(),
    result: 'yes', raw_json: JSON.stringify({ strike_type: 'greater_or_equal' }) }));
  const spot = Array.from({ length: 121 }, (_, i) => ({ available_ms: cutoff - 3600000 + i * 60000, close: 100 + Math.sin(i) }));
  const history = { prepare: sql => ({ all: ticker => sql.includes('FROM markets') ? markets :
    Array.from({ length: 15 }, (_, i) => ({ end_period_ts: Date.parse(markets.find(m => m.ticker === ticker).open_time) / 1000 + (i + 1) * 60,
      yes_bid_close: .49, yes_ask_close: .51 })) }) };
  const result = evaluateForecasts(history, spot, { forwardOnly: true, forwardAfter: cutoff });
  assert.equal(result.markets, 2);
  assert.ok(result.rows.length > 0);
  assert.ok(result.rows.every(row => row.openTime >= cutoff));
  assert.equal(result.all.commonMarkets, result.forward.comparison.commonMarkets);
  assert.equal(result.freshDataAfter, new Date(cutoff).toISOString());
  assert.throws(() => evaluateForecasts(history, spot, { forwardOnly: true }), /requires a cutoff/);
});
