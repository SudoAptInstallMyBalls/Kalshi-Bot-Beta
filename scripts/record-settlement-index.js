// Feed this process the one-second BRTI observations supplied by your authorized provider adapter.
// No undocumented exchange endpoint, substitute index or credentials are assumed.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { IndexRecorder } = require('../src/market-data/settlement-reference');
const { dataDir } = require('../src/config/paths');
async function main(args = process.argv.slice(2)) {
  let historical = false, input, out;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--historical') historical = true;
    else if (args[i] === '--input' && args[i + 1]) input = args[++i];
    else if (args[i] === '--out' && args[i + 1]) out = args[++i];
    else throw Error('Usage: record-settlement-index.js [--input file.jsonl] [--out db.sqlite] [--historical]');
  }
  out ||= path.join(process.env.BOT_DATA_DIR || dataDir, historical ? 'settlement-index-history.sqlite' : 'settlement-index.sqlite');
  if (input && path.resolve(input) === path.resolve(out)) throw Error('Input and output must differ');
  if (!input && process.stdin.isTTY) throw Error('Pipe authorized BRTI JSONL observations to stdin or specify --input');
  const recorder = new IndexRecorder(out, { historical });
  const stream = input ? fs.createReadStream(input) : process.stdin;
  let count = 0;
  try {
    for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
      if (line.trim()) count += Number(recorder.record(JSON.parse(line)));
    }
    console.log(JSON.stringify({ recorded: count, output: path.resolve(out), historical }));
  } finally { recorder.close(); if (input) stream.destroy(); }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
