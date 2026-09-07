function settlementNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value.trim())) return null;
  const n = Number(value.trim().replaceAll(',', ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}
module.exports = { settlementNumber };
