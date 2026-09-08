const fs = require('fs');
const studyStore = require('../src/research/forward-study');
async function main(args = process.argv.slice(2), { store = studyStore,
  refreshData = options => require('./refresh-forward-data').refresh(options),
  evaluate = options => require('./evaluate-settlement-models').main(options), now = Date.now } = {}) {
  const version = studyStore.parseStudyArgs(args), study = store.verify(version), outputs = store.outputPaths(version);
  if (now() < Date.parse(study.cutoff)) {
    const waiting = { studyId: study.id, status: 'waiting_for_cutoff', cutoff: study.cutoff };
    console.log(JSON.stringify(waiting));
    return waiting;
  }
  fs.mkdirSync(outputs.directory, { recursive: true });
  const lock = outputs.lock;
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    try { process.kill(pid, 0); throw Error(`Forward refresh already running: ${pid}`); }
    catch (e) { if (e.code !== 'ESRCH') throw e; fs.unlinkSync(lock); }
  }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  try {
    await refreshData({ version });
    store.verify(version);
    const result = await evaluate(['--study', version, '--coinbase-shadow']);
    store.verify(version);
    const report = { directory: result.directory, studyId: study.id, cutoff: study.cutoff, completedAt: new Date(now()).toISOString() };
    fs.writeFileSync(outputs.latest, JSON.stringify(report, null, 2));
    return report;
  } finally { if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); }
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
module.exports = { main };
