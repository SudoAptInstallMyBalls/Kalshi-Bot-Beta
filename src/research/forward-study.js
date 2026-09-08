const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { root } = require('../config/paths');
const LEGACY_MANIFEST_SHA256 = 'e50d5693477e8c4fbc7919ebaf2afe2cd31a0891b1e4c9e41a086bad32c5f18d';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function studyVersion(value = 'v1') {
  if (!/^v[1-9]\d*$/.test(value)) throw Error('Study must be a version such as v1 or v2');
  return value;
}

function parseStudyArgs(args) {
  let version = 'v1', seen = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--study' || seen || !args[i + 1]) throw Error('Usage: --study v2');
    version = studyVersion(args[++i]); seen = true;
  }
  return version;
}

function policyFiles(repositoryRoot) {
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : entry.name.endsWith('.js') ? [path.relative(repositoryRoot, file).replaceAll('\\', '/')] : [];
  });
  // Pin transitive helpers, validation, entrypoints and dependency specifications.
  return [...walk(path.join(repositoryRoot, 'src')), 'package.json', 'package-lock.json',
    'config/research/research-config.json', 'scripts/run-forward-study.js', 'scripts/refresh-forward-data.js',
    'scripts/evaluate-settlement-models.js', 'scripts/evaluate-research-candidates.js',
    'scripts/freeze-forward-study.js'].sort();
}

function createStudyStore({ repositoryRoot = root, now = Date.now, listPolicyFiles = policyFiles } = {}) {
  function manifestPath(version = 'v1') {
    studyVersion(version);
    return path.join(repositoryRoot, 'config/research', version === 'v1' ? 'forward-study.json' : `forward-study-${version}.json`);
  }
  function outputPaths(version = 'v1') {
    studyVersion(version);
    const directory = path.join(repositoryRoot, 'data/research/forward-studies', `settlement-forward-${version}`);
    return { directory, lock: path.join(directory, 'refresh.pid'), latest: path.join(directory, 'latest.json'),
      refresh: path.join(directory, 'refresh.json'), evaluations: path.join(directory, 'evaluations'),
      candidates: path.join(directory, 'candidates') };
  }
  function read(version = 'v1') {
    const file = manifestPath(version), study = JSON.parse(fs.readFileSync(file, 'utf8'));
    const digest = sha256(JSON.stringify(study));
    const expected = version === 'v1' ? LEGACY_MANIFEST_SHA256 : fs.readFileSync(`${file}.sha256`, 'utf8').trim();
    if (digest !== expected) throw Error(`Study ${version} manifest changed; preserve its cutoff and declaration`);
    if (study.id !== `settlement-forward-${version}` || !Number.isFinite(Date.parse(study.cutoff)) || study.shadowOnly !== true) {
      throw Error(`Invalid study ${version} declaration`);
    }
    if (version !== 'v1' && (study.schemaVersion !== 2 || study.hashFormat !== 'sha256-utf8-lf' ||
        !(Date.parse(study.cutoff) > Date.parse(study.frozenAt)) || study.alreadyInspectedForwardMarkets !== 0)) {
      throw Error(`Invalid prospective study ${version}`);
    }
    return study;
  }
  function hashFiles(files, normalized) {
    return Object.fromEntries(files.map(file => {
      const absolute = path.resolve(repositoryRoot, file);
      if (!absolute.startsWith(path.resolve(repositoryRoot) + path.sep)) throw Error('Policy path outside repository');
      const bytes = fs.readFileSync(absolute);
      return [file, sha256(normalized ? bytes.toString('utf8').replace(/\r\n/g, '\n') : bytes)];
    }));
  }
  function verify(version = 'v1') {
    const study = read(version), files = Object.keys(study.policySha256).sort();
    if (version !== 'v1' && JSON.stringify(files) !== JSON.stringify(listPolicyFiles(repositoryRoot).sort())) {
      throw Error(`Frozen forward study ${version} file set changed; declare a new version`);
    }
    const current = hashFiles(files, version !== 'v1');
    const changed = files.filter(file => current[file] !== study.policySha256[file]);
    if (changed.length) throw Error(`Frozen forward study ${version} changed: ${changed.join(', ')}. Use its original source or declare a new version; do not overwrite its hashes.`);
    return study;
  }
  function freeze({ version, cutoff } = {}) {
    studyVersion(version);
    if (!version || version === 'v1') throw Error('The original v1 study cannot be recreated or overwritten');
    const file = manifestPath(version);
    if (fs.existsSync(file) || fs.existsSync(`${file}.sha256`)) throw Error(`Study ${version} already exists; use verify or a new version`);
    const frozenAt = now();
    const cutoffMs = cutoff === undefined ? Math.ceil((frozenAt + 900000) / 900000) * 900000 : Date.parse(cutoff);
    if (!Number.isFinite(cutoffMs) || cutoffMs <= frozenAt) throw Error('New study cutoff must be in the future, after its declaration');
    const study = { schemaVersion: 2, id: `settlement-forward-${version}`, parentStudy: 'settlement-forward-v1',
      frozenAt: new Date(frozenAt).toISOString(), cutoff: new Date(cutoffMs).toISOString(),
      alreadyInspectedForwardMarkets: 0, shadowOnly: true, hashFormat: 'sha256-utf8-lf',
      policySha256: hashFiles(listPolicyFiles(repositoryRoot).sort(), true),
      rule: 'Only markets opening at or after this cutoff are prospective results. Earlier data may supply as-of calibration. No threshold tuning, cutoff changes, candidate selection, or live promotion. Changed code requires a new version.',
      coinbase: { declaredAt: new Date(frozenAt).toISOString(), maximumEventAgeMs: 5000, maximumFutureSkewMs: 500,
        availability: 'max(original received_ms, original event_ms)',
        variants: ['coinbaseUsdAverage', 'coinbaseOpeningAverage', 'coinbaseBookMidpoint'] } };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Exclusive writes never replace a declaration. A partial write fails closed on read.
    fs.writeFileSync(file, JSON.stringify(study, null, 2) + '\n', { flag: 'wx' });
    fs.writeFileSync(`${file}.sha256`, sha256(JSON.stringify(study)) + '\n', { flag: 'wx' });
    return verify(version);
  }
  return { read, verify, freeze, manifestPath, outputPaths };
}

const store = createStudyStore();
module.exports = { ...store, filename: store.manifestPath('v1'), createStudyStore, studyVersion, parseStudyArgs };
