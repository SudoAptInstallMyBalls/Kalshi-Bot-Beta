const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { root } = require('../config/paths');
const cutoff = '2026-09-07T00:15:00Z';
const files = ['config/research/research-config.json', 'src/strategy/volatility.js', 'src/strategy/settlement-forecast.js',
  'src/research/proxy-reference.js', 'src/research/history-replay.js', 'src/research/settlement-evaluation.js',
  'src/agents/skills/analysis/probability-model.js', 'src/agents/skills/analysis/signal-generator.js',
  'src/agents/skills/trading/risk-manager.js', 'src/research/coinbase-shadow.js'];
const filename = path.join(root, 'config/research/forward-study.json');
function hashes() { return Object.fromEntries(files.map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')])); }
function freeze() {
  if (fs.existsSync(filename)) return verify();
  const study = { id: 'settlement-forward-v1', cutoff, frozenAt: new Date().toISOString(),
    alreadyInspectedForwardMarkets: 52, shadowOnly: true, policySha256: hashes(),
    rule: 'No threshold tuning, model selection, live promotion, or moving the cutoff. Changed policy needs a separately versioned study.',
    coinbase: { declaredAt: new Date().toISOString(), maximumEventAgeMs: 5000, variants: ['coinbaseUsdAverage', 'coinbaseOpeningAverage'] } };
  fs.writeFileSync(filename, JSON.stringify(study, null, 2) + '\n', { flag: 'wx' });
  return study;
}
function verify() {
  const study = JSON.parse(fs.readFileSync(filename, 'utf8')), current = hashes();
  if (study.cutoff !== cutoff || Object.keys(current).some(f => study.policySha256[f] !== current[f])) throw Error('Frozen forward study changed. Stop and review; do not retune or overwrite the study.');
  return study;
}
module.exports = { freeze, verify, filename };
