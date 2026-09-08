// Normalize current fixed-point API fields into the legacy numeric units used
// by the local execution ledger. Preserve the original dollar/fp fields too.
function normalizeOrder(order) {
  const value = { ...order };
  for (const name of ['fill_count', 'remaining_count', 'initial_count']) {
    if (order[`${name}_fp`] != null) value[name] = Number(order[`${name}_fp`]);
    else if (order[name] != null) value[name] = Number(order[name]);
  }
  for (const name of ['taker_fill_cost', 'maker_fill_cost', 'taker_fees', 'maker_fees']) {
    if (order[`${name}_dollars`] != null) value[name] = Number(order[`${name}_dollars`]) * 100;
    else if (order[name] != null) value[name] = Number(order[name]);
  }
  return value;
}
class ExecutionDataError extends Error {
  constructor(code, message) { super(message); this.name = 'ExecutionDataError'; this.code = code; }
}
function executionTotals(order) {
  const o = normalizeOrder(order);
  const filled = Number(o.fill_count);
  if (!Number.isFinite(filled) || filled < 0) throw new ExecutionDataError('INVALID_FILL_COUNT', 'Order fill count unavailable');
  if (!filled) return { filled, gross: 0, fees: 0 };
  if (o.taker_fill_cost == null && o.maker_fill_cost == null) throw new ExecutionDataError('MISSING_FILL_COST', 'Actual fill costs unavailable');
  if (o.taker_fees == null && o.maker_fees == null) throw new ExecutionDataError('MISSING_FILL_FEES', 'Actual fill fees unavailable');
  const parts = ['taker_fill_cost', 'maker_fill_cost', 'taker_fees', 'maker_fees'].map(k => Number(o[k] ?? 0));
  if (!parts.every(v => Number.isFinite(v) && v >= 0)) throw new ExecutionDataError('INVALID_EXECUTION_AMOUNTS', 'Invalid execution amounts');
  return { filled, gross: parts[0] + parts[1], fees: parts[2] + parts[3] };
}
module.exports = { normalizeOrder, executionTotals, ExecutionDataError };
