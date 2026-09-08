// Injectable timer and task body; one invocation at a time, drained on stop.
class ScheduledTask {
  constructor(run, intervalMs, { setInterval: schedule = setInterval, clearInterval: cancel = clearInterval } = {}) {
    this.body = run;
    this.intervalMs = intervalMs;
    this.schedule = schedule;
    this.cancel = cancel;
    this.timer = null;
    this.pending = null;
    this.stopped = false;
  }
  run() {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(() => this.body()).finally(() => { this.pending = null; });
    return this.pending;
  }
  start() {
    if (this.timer !== null) return;
    this.stopped = false;
    this.timer = this.schedule(() => {
      this.run().catch(err => console.error('[Scheduler] Task failed:', err.message));
    }, this.intervalMs);
  }
  async stop() {
    this.stopped = true;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    await this.pending;
  }
}
module.exports = ScheduledTask;
