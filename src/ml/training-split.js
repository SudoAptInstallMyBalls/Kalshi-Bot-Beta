// Group by contract, then purge labels not yet known at the next split's start.
function chronologicalSplit(data) {
  const groups = new Map();
  for (const row of data) {
    if (!row.ticker || !Number.isFinite(row.ts) || !Number.isFinite(row.outcome_ms) || row.outcome_ms < row.ts) continue;
    if (!groups.has(row.ticker)) groups.set(row.ticker, []);
    groups.get(row.ticker).push(row);
  }
  const ordered = [...groups.values()].sort((a, b) => Math.min(...a.map(r => r.ts)) - Math.min(...b.map(r => r.ts)));
  const a = Math.floor(ordered.length * 0.7), b = Math.floor(ordered.length * 0.85);
  const trainGroups = ordered.slice(0, a), validationGroups = ordered.slice(a, b), testGroups = ordered.slice(b);
  const firstTs = rows => rows.length ? Math.min(...rows.flat().map(r => r.ts)) : -Infinity;
  const validationStarts = firstTs(validationGroups), testStarts = firstTs(testGroups);
  const training = trainGroups.filter(rows => rows.every(r => r.outcome_ms < validationStarts)).flat();
  const validation = validationGroups.filter(rows => rows.every(r => r.outcome_ms < testStarts)).flat();
  return { training, validation, test: testGroups.flat() };
}
module.exports = chronologicalSplit;
