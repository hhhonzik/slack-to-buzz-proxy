import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Event } from 'nostr-tools';
import { InputError } from './types.js';

export interface Job { id: string; route: string; relay: string; event: string; attempts: number; created_at: number; lease: string }
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, route TEXT NOT NULL, relay TEXT NOT NULL, event TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, next_at INTEGER NOT NULL, finished_at INTEGER,
        dedupe_key TEXT NOT NULL, payload_hash TEXT NOT NULL, dedupe_until INTEGER NOT NULL,
        lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, error TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, next_at, lease_until);
      CREATE INDEX IF NOT EXISTS jobs_dedupe ON jobs(dedupe_key, dedupe_until);
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `);
  }
  increment(name: string) { this.db.prepare('INSERT INTO counters VALUES (?,1) ON CONFLICT(name) DO UPDATE SET value=value+1').run(name); }
  enqueue(route: string, relay: string, event: Event, dedupeKey: string, payloadHash: string, ttlMs: number, maxQueued: number, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT id,payload_hash,status FROM jobs WHERE dedupe_key=? AND dedupe_until>? ORDER BY created_at DESC LIMIT 1').get(dedupeKey, now);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new InputError(409, 'idempotency_key_conflict');
        if (prior.status === 'failed') throw new InputError(503, 'previous_delivery_failed');
        this.increment('deduplicated'); this.db.exec('COMMIT'); return { id: String(prior.id), duplicate: true };
      }
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status!='delivered'").get()!;
      if (Number(count.n) >= maxQueued) throw new InputError(503, 'queue_full');
      this.db.prepare('INSERT INTO jobs(id,route,relay,event,created_at,next_at,dedupe_key,payload_hash,dedupe_until) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(event.id, route, relay, JSON.stringify(event), now, now, dedupeKey, payloadHash, now + ttlMs);
      this.increment('accepted'); this.db.exec('COMMIT'); return { id: event.id, duplicate: false };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  claim(leaseMs: number, now = Date.now()): Job | undefined {
    return this.db.prepare(`UPDATE jobs SET lease=?,lease_until=? WHERE id=(
      SELECT id FROM jobs WHERE status='pending' AND next_at<=? AND lease_until<=? ORDER BY next_at,created_at LIMIT 1
    ) RETURNING id,route,relay,event,attempts,created_at,lease`).get(randomUUID(), now + leaseMs, now, now) as unknown as Job | undefined;
  }
  complete(job: Job, now = Date.now()) {
    const changed = this.db.prepare("UPDATE jobs SET status='delivered',event='',finished_at=?,lease=NULL,lease_until=0,error=NULL WHERE id=? AND lease=?").run(now, job.id, job.lease);
    if (changed.changes) this.increment('delivered');
  }
  retry(job: Job, error: string, nextAt: number, failed: boolean, now = Date.now()) {
    const changed = this.db.prepare('UPDATE jobs SET status=?,attempts=attempts+1,next_at=?,finished_at=?,error=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?')
      .run(failed ? 'failed' : 'pending', nextAt, failed ? now : null, error, job.id, job.lease);
    if (changed.changes) this.increment(failed ? 'failed' : 'retried');
  }
  stats(now = Date.now()) {
    const counts = { pending: 0, failed: 0, delivered: 0 };
    for (const r of this.db.prepare('SELECT status,COUNT(*) AS n FROM jobs GROUP BY status').all()) {
      const status = String(r.status);
      if (status === 'pending' || status === 'failed' || status === 'delivered') counts[status] = Number(r.n);
    }
    const oldest = this.db.prepare("SELECT MIN(created_at) AS t FROM jobs WHERE status='pending'").get();
    const counters = Object.fromEntries(this.db.prepare('SELECT name,value FROM counters').all().map(r => [String(r.name), Number(r.value)]));
    return { ...counts, oldestPendingSeconds: oldest?.t == null ? 0 : Math.max(0, (now - Number(oldest.t)) / 1000), counters };
  }
  cleanup(retentionDays: number, now = Date.now()) {
    this.db.prepare("DELETE FROM jobs WHERE status='delivered' AND finished_at<? AND dedupe_until<?").run(now - retentionDays * 86400000, now);
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }
  list() { return this.db.prepare("SELECT id,route,status,attempts,error,created_at,next_at FROM jobs WHERE status!='delivered' ORDER BY created_at LIMIT 100").all(); }
  requeue(id: string) { return this.db.prepare("UPDATE jobs SET status='pending',attempts=0,next_at=?,finished_at=NULL,error=NULL WHERE id=? AND status='failed'").run(Date.now(), id).changes; }
  close() { this.db.close(); }
}
