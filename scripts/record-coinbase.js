const fs = require('fs');
const path = require('path');
const { root } = require('../src/config/paths');
const { CoinbaseRecorder } = require('../src/research/coinbase-recorder');
function main(args = process.argv.slice(2)) {
  let seconds = 0;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--seconds' || !Number.isInteger(Number(args[1])) || Number(args[1]) <= 0) throw Error('Usage: record-coinbase.js [--seconds positive-integer]');
    seconds = Number(args[1]);
  }
  const dir = path.join(root, 'data/research/free-feed'); fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'recorder.pid');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    try { process.kill(pid, 0); throw Error(`Recorder lock held by PID ${pid}`); }
    catch (e) { if (e.code !== 'ESRCH') throw e; fs.unlinkSync(lock); }
  }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  let recorder, timer, stopped = false;
  const stop = () => {
    if (stopped) return; stopped = true; clearTimeout(timer);
    recorder?.stop();
    if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock);
  };
  try {
    recorder = new CoinbaseRecorder(path.join(dir, 'coinbase.sqlite'));
    recorder.start();
    console.log(JSON.stringify({ pid: process.pid, source: 'coinbase:BTC-USD:ticker', shadowOnly: true, started: new Date().toISOString() }));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    if (seconds) timer = setTimeout(stop, seconds * 1000);
    return { stop };
  } catch (e) { stop(); throw e; }
}
if (require.main === module) { try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
module.exports = { main };
