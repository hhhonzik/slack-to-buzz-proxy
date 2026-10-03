import type { Event } from 'nostr-tools';
import { BuzzClient, DeliveryError } from './buzz.js';
import { Store } from './store.js';
export type Log = (data: Record<string, unknown>) => void;
export class Worker {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private lastCleanup = 0;
  constructor(private store: Store, private client: BuzzClient, private timeoutMs: number, private retentionDays: number, private log: Log) {}
  async tick() {
    if (this.active) return this.active;
    this.active = this.once().finally(() => { this.active = undefined; });
    return this.active;
  }
  private async once() {
    if (Date.now() - this.lastCleanup > 60000) { this.store.cleanup(this.retentionDays); this.lastCleanup = Date.now(); }
    const job = this.store.claim(this.timeoutMs + 30000);
    if (!job) return;
    try {
      await this.client.publish(JSON.parse(job.event) as Event, job.relay);
      this.store.complete(job);
      this.log({ event: 'delivered', id: job.id, route: job.route });
    } catch (e) {
      const error = e instanceof DeliveryError ? e : new DeliveryError('internal_delivery_error', true);
      const expired = Date.now() - job.created_at > 7 * 86400000;
      const failed = !error.retryable || expired;
      const delay = Math.max(error.retryAfterMs, Math.min(300000, 1000 * 2 ** Math.min(job.attempts, 9)) * (1 + Math.random() * 0.2));
      this.store.retry(job, expired ? 'delivery_expired' : error.code, Math.ceil(Date.now() + delay), failed);
      this.log({ event: failed ? 'delivery_failed' : 'delivery_retry', id: job.id, route: job.route, code: error.code });
    }
  }
  start() {
    const run = () => { void this.tick().catch(() => this.log({ event: 'worker_storage_error' })); };
    this.timer = setInterval(run, 250); run();
  }
  async stop() { clearInterval(this.timer); await this.active; }
}
