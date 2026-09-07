// Recovery for the explicit 404 user_not_found incident in the supplied log.
// This is NOT a general timeout recovery tool and never submits orders/transfers.
const fs = require('fs');
const path = require('path');
const net = require('net');
const KalshiClient = require('#src/exchange/kalshi-client');
const root = require('#src/config/paths').root;
const incident = { clientOrderId: '0b20ee95-d1d9-4b8c-98b0-651a94889701', ticker: 'KXBTC15M-26SEP060915-15' };

function validateState(state) {
  const pending = state.pendingOrders;
  if (!Array.isArray(pending) || pending.length !== 1 ||
      pending[0].clientOrderId !== incident.clientOrderId || pending[0].ticker !== incident.ticker ||
      pending[0].orderId !== `unconfirmed-${incident.clientOrderId}` || !pending[0].submissionUnknown ||
      Number(pending[0].fillCount) !== 0 || !Array.isArray(state.openPositions) || state.openPositions.length ||
      state.stats?.totalTrades !== 0) throw new Error('State differs from verified rejection; manual reconciliation required');
}
async function requireStopped(port) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); reject(new Error('Stop npm run demo with Ctrl+C before repairing state')); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Cannot verify demo is stopped')); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
  });
}
async function main(args = process.argv.slice(2)) {
  if (args.some(a => a !== '--apply')) throw new Error('Usage: node scripts/repair-demo-submission.js [--apply]');
  const config = require('dotenv').parse(fs.readFileSync(path.join(root, '.env.demo')));
  delete process.env.KALSHI_PRIVATE_KEY_BASE64;
  config.KALSHI_API_BASE = 'https://external-api.demo.kalshi.co';
  config.KALSHI_PRIVATE_KEY_PATH = path.resolve(root, config.KALSHI_PRIVATE_KEY_PATH);
  const statePath = path.join(root, 'data/demo/state.json');
  if (args.includes('--apply')) await requireStopped(Number(config.PORT || 3334));
  const original = fs.readFileSync(statePath, 'utf8');
  const state = JSON.parse(original);
  validateState(state);
  const client = new KalshiClient(config, {});
  // No status or shard filter: check all orders/fills for this exact market.
  for (const [endpoint, field] of [['orders', 'orders'], ['fills', 'fills']]) {
    const { data } = await client.get(`/trade-api/v2/portfolio/${endpoint}?ticker=${encodeURIComponent(incident.ticker)}&limit=1000`);
    if (!Array.isArray(data[field]) || data[field].length || data.cursor) throw new Error(`${endpoint} not empty or incomplete; preserving state`);
  }
  const positions = await client.fetchPositions('KXBTC15M');
  if (positions.some(p => !Number.isFinite(Number(p.position_fp ?? p.position)) || Number(p.position_fp ?? p.position) !== 0)) {
    throw new Error('Remote positions need reconciliation; preserving state');
  }
  const { data: balance } = await client.get('/trade-api/v2/portfolio/balance');
  console.log(JSON.stringify({ demo: true, rejectedClientOrderId: incident.clientOrderId,
    ordersAndFillsEmpty: true, positionsFlat: true, exchangeBalances: balance.balance_breakdown }, null, 2));
  if (!args.includes('--apply')) { console.log('Read-only check complete. Stop demo, then run with --apply to remove only this rejected marker.'); return; }
  await requireStopped(Number(config.PORT || 3334));
  if (fs.readFileSync(statePath, 'utf8') !== original) throw new Error('State changed during checks; refusing repair');
  const backup = statePath + `.before-rejection-repair-${Date.now()}.bak`;
  fs.writeFileSync(backup, original, { flag: 'wx' });
  state.pendingOrders = [];
  state._savedAt = new Date().toISOString();
  fs.writeFileSync(statePath + '.repair.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(statePath + '.repair.tmp', statePath);
  console.log(`Rejected marker removed. Original state backed up at ${backup}. No orders or transfers sent.`);
}
if (require.main === module) main().catch(e => { console.error('[Demo repair]', e.response?.data?.error?.message || e.code || e.message); process.exitCode = 1; });
module.exports = { validateState, requireStopped };
