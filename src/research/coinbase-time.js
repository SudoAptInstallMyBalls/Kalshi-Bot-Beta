// Preserve exchange and receipt timestamps. Small clock skew is tolerated only
// at ingestion; research cannot use a sample until BOTH timestamps have passed.
const MAX_FUTURE_SKEW_MS = 500;
const MAX_EVENT_AGE_MS = 5000;
const availableAt = row => Math.max(row.received_ms, row.event_ms);
const usableAt = (row, now) => Boolean(row) && availableAt(row) <= now &&
  now - row.event_ms <= MAX_EVENT_AGE_MS && now - row.received_ms <= MAX_EVENT_AGE_MS;
module.exports = { MAX_FUTURE_SKEW_MS, MAX_EVENT_AGE_MS, availableAt, usableAt };
