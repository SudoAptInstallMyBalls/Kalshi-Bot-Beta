// Rows retain scoring timestamps, rather than acquiring flush timestamps.
class MLWriteBuffer {
  constructor(db, { intervalMs = 500, threshold = 50 } = {}) {
    this.db = db;
    this.features = [];
    this.predictions = [];
    this.threshold = threshold;
    this.immediate = null;
    this.timer = setInterval(() => this.tryFlush(), intervalMs);
    this.timer.unref();
  }

  enqueue(feature, prediction) {
    this.features.push(feature);
    if (prediction) this.predictions.push(prediction);
    if (this.features.length + this.predictions.length >= this.threshold && !this.immediate) {
      this.immediate = setImmediate(() => {
        this.immediate = null;
        this.tryFlush();
      });
    }
  }

  tryFlush() {
    try { this.flush(); }
    catch (err) { console.error('[ML] Buffered write failed; retained for retry:', err.message); }
  }

  flush() {
    if (!this.features.length && !this.predictions.length) return;
    this.db.writeMLBatch(this.features, this.predictions);
    this.features.length = 0;
    this.predictions.length = 0;
  }

  stop() {
    clearInterval(this.timer);
    clearImmediate(this.immediate);
    this.immediate = null;
    this.flush();
  }
}

module.exports = MLWriteBuffer;
