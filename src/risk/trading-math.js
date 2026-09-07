// Dollar units throughout. Fee rate remains explicit for series-specific schedules.
function takerFee(count, price, rate = 0.07) {
  if (![count, price, rate].every(Number.isFinite) || count < 0 || price < 0 || price > 1 || rate < 0) throw new Error('Invalid fee inputs');
  return Math.ceil(rate * count * price * (1 - price) * 100 - 1e-10) / 100;
}
function orderCost(count, price, rate = 0.07) { return count * price + takerFee(count, price, rate); }
function affordableContracts(budget, price, rate = 0.07) {
  if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(price) || price <= 0 || price >= 1) return 0;
  let lo = 0, hi = Math.floor(budget / price);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (orderCost(mid, price, rate) <= budget + 1e-10) lo = mid; else hi = mid - 1;
  }
  return lo;
}
module.exports = { takerFee, orderCost, affordableContracts };
