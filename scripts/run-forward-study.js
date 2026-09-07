const fs = require('fs');
const path = require('path');
const { root } = require('../src/config/paths');
const { verify } = require('../src/research/forward-study');
async function main() {
  const study = verify(), lock = path.join(root, 'data/research/forward-study.pid');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    try { process.kill(pid, 0); throw Error(`Forward refresh already running: ${pid}`); }
    catch (e) { if (e.code !== 'ESRCH') throw e; fs.unlinkSync(lock); }
  }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  try {
    await require('./refresh-forward-data').refresh();
    const result = await require('./evaluate-settlement-models').main(['--forward-after', study.cutoff, '--coinbase-shadow']);
    fs.writeFileSync(path.join(root, 'data/research/latest-forward-study.json'), JSON.stringify({ directory: result.directory, studyId: study.id, completedAt: new Date().toISOString() }, null, 2));
  } finally { if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); }
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
module.exports = { main };
