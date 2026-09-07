class CoinbaseBook {
  reset() { this.bids = new Map(); this.asks = new Map(); this.ready = false; this.time = -Infinity; }
  constructor() { this.reset(); }
  apply(m, received) {
    if (m.product_id !== 'BTC-USD') return null;
    if (m.type === 'snapshot') {
      this.reset();
      for (const [side, rows] of [[this.bids, m.bids], [this.asks, m.asks]]) {
        if (!Array.isArray(rows)) throw Error('Malformed book snapshot');
        for (const [p, s] of rows) this.set(side, p, s);
      }
      this.ready = true; this.time = received;
    } else if (m.type === 'l2update') {
      if (!this.ready) return null;
      const time = Date.parse(m.time);
      if (!Number.isFinite(time) || !Array.isArray(m.changes)) throw Error('Malformed book update');
      // Apply all delivered deltas; do not silently drop stale batches and corrupt the book.
      for (const [side, p, s] of m.changes) {
        if (!['buy', 'sell'].includes(side)) throw Error('Invalid book side');
        this.set(side === 'buy' ? this.bids : this.asks, p, s);
      }
      this.time = time;
    } else return null;
    return true;
  }
  set(book, p, s) {
    const price = Number(p), size = Number(s);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) throw Error('Invalid book level');
    if (size === 0) book.delete(price); else book.set(price, size);
  }
  quote() {
    if (!this.ready || !this.bids.size || !this.asks.size) return null;
    let bid = -Infinity, ask = Infinity;
    for (const p of this.bids.keys()) bid = Math.max(bid, p);
    for (const p of this.asks.keys()) ask = Math.min(ask, p);
    if (bid >= ask) throw Error('Crossed book; resnapshot required');
    return { bid, ask, price: (bid + ask) / 2, event: this.time };
  }
}
module.exports = { CoinbaseBook };
