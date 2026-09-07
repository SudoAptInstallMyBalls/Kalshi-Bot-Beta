function isEntryTime(now, market, startMs, endMs, closeBufferMs) {
  const elapsed = now - market.openTime;
  return elapsed >= startMs && elapsed <= endMs && market.closeTime - now >= closeBufferMs;
}
module.exports = { isEntryTime };
