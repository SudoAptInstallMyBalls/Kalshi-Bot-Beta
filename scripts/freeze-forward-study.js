const { freeze, verify, manifestPath, studyVersion } = require('../src/research/forward-study');

function main(args = process.argv.slice(2)) {
  let version, cutoff, verifyOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--study' && !version && args[i + 1]) version = studyVersion(args[++i]);
    else if (args[i] === '--cutoff' && !cutoff && args[i + 1]) cutoff = args[++i];
    else if (args[i] === '--verify' && !verifyOnly) verifyOnly = true;
    else throw Error('Usage: --study v2 [--cutoff future-ISO-timestamp | --verify]');
  }
  if (!version || (verifyOnly && cutoff)) throw Error('Specify --study; --verify cannot change the cutoff');
  const study = verifyOnly ? verify(version) : freeze({ version, cutoff });
  console.log(JSON.stringify({ studyId: study.id, cutoff: study.cutoff, manifest: manifestPath(version), verified: true }, null, 2));
  return study;
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
