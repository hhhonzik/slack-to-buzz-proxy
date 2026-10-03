import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, verifyEvent, type Event } from 'nostr-tools';
import { authHeader, BuzzClient, messageEvent, sha256, DeliveryError } from '../src/buzz.js';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import { createProxy } from '../src/server.js';
import { renderPayload } from '../src/render.js';
import type { Config } from '../src/config.js';

const channel = '01234567-89ab-cdef-0123-456789abcdef';
const token = 'a'.repeat(64);
async function listen(server: Server) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address'); return `http://127.0.0.1:${address.port}`; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
function config(relayUrl: string): Config {
  return { host: '127.0.0.1', port: 8080, relayUrl, key: generateSecretKey(), routes: [{ name: 'alerts', channelId: channel, token }],
    dbPath: ':memory:', adminToken: 'b'.repeat(64), maxBodyBytes: 1048576, maxQueued: 100, dedupSeconds: 60, retentionDays: 7, timeoutMs: 500 };
}
test('full webhook → durable outbox → signed Buzz HTTP bridge, including restart and duplicate ACK', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'buzz-proxy-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const events: Event[] = []; const authIds: string[] = []; let relayUrl = '';
  const relay = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const auth = JSON.parse(Buffer.from(req.headers.authorization!.slice(6), 'base64').toString());
      assert.equal(verifyEvent(auth), true); assert.equal(auth.kind, 27235); assert.equal(auth.content, '');
      assert.ok(auth.tags.some((x: string[]) => x[0] === 'u' && x[1] === relayUrl + '/events'));
      assert.ok(auth.tags.some((x: string[]) => x[0] === 'method' && x[1] === 'POST'));
      assert.ok(auth.tags.some((x: string[]) => x[0] === 'payload' && x[1] === sha256(body)));
      assert.ok(auth.tags.some((x: string[]) => x[0] === 'nonce')); authIds.push(auth.id);
      const event = JSON.parse(body); assert.equal(verifyEvent(event), true); assert.equal(event.pubkey, auth.pubkey);
      assert.equal(event.kind, 9); assert.deepEqual(event.tags.find((tag: string[]) => tag[0] === 'h'), ['h', channel]);
      events.push(event); res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ event_id: event.id, accepted: events.length === 1, message: events.length === 1 ? '' : 'duplicate:' }));
    } catch { res.statusCode = 400; res.end('test_relay_validation_failed'); }
  });
  relayUrl = await listen(relay); t.after(() => close(relay));
  const c = config(relayUrl); const path = join(dir, 'outbox.sqlite'); let store = new Store(path);
  const proxy = createProxy(c, store); const url = await listen(proxy);
  const payload = { text: 'Alert *firing*', channel: '#ignored' };
  const post = () => fetch(`${url}/services/alerts/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const response = await post(); assert.equal(response.status, 200); assert.equal(await response.text(), 'ok');
  const id = response.headers.get('x-buzz-proxy-event-id'); assert.ok(id); assert.equal(events.length, 0);
  const duplicate = await post(); assert.equal(duplicate.headers.get('x-buzz-proxy-delivery'), 'duplicate');
  assert.equal(duplicate.headers.get('x-buzz-proxy-event-id'), id); assert.equal(store.stats().pending, 1);
  await close(proxy); store.close(); store = new Store(path); t.after(() => store.close());
  const client = new BuzzClient(c); const worker = new Worker(store, client, c.timeoutMs, 7, () => {});
  await worker.tick(); assert.equal(store.stats().delivered, 1); assert.equal(events.length, 1);
  assert.match(events[0]!.content, /\*\*firing\*\*/);
  await client.publish(events[0]!, relayUrl); assert.equal(events[0]!.id, events[1]!.id); assert.notEqual(authIds[0], authIds[1]);
});
test('HTTP rejects invalid auth/payload/oversize/threads and accepts JSON, forms, bearer, native alerts', async t => {
  const c = config('http://127.0.0.1:1'); const store = new Store(':memory:'); t.after(() => store.close());
  const server = createProxy(c, store); const url = await listen(server); t.after(() => close(server));
  async function post(data: string, path = `/hooks/alerts/${token}`, headers: Record<string, string> = {}) {
    return fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: data });
  }
  assert.equal((await post('{"text":"x"}', '/hooks/alerts/bad')).status, 401);
  assert.equal((await post('bad json')).status, 400);
  assert.equal((await post('{"text":"x","thread_ts":"123.4"}')).status, 400);
  assert.equal((await post(JSON.stringify({ text: '🐝'.repeat(16000) }))).status, 413);
  assert.equal((await post('x'.repeat(c.maxBodyBytes + 1))).status, 413);
  assert.equal((await post('{}', undefined, { 'content-type': 'text/plain' })).status, 415);
  const form = new URLSearchParams({ payload: JSON.stringify({ text: 'Form payload' }) }).toString();
  assert.equal((await post(form, undefined, { 'content-type': 'application/x-www-form-urlencoded' })).status, 200);
  assert.equal((await post('{"text":"Bearer"}', '/hooks/alerts', { authorization: `Bearer ${token}` })).status, 200);
  assert.equal((await post(JSON.stringify({ status: 'resolved', alerts: [{ status: 'resolved', labels: { alertname: 'CPU' } }] }))).status, 200);
  assert.equal((await fetch(url + '/metrics')).status, 401);
  const metrics = await fetch(url + '/metrics', { headers: { authorization: 'Bearer ' + c.adminToken } });
  assert.match(await metrics.text(), /buzz_proxy_events_total\{result="accepted"\} 3/);
  assert.equal((await fetch(url + '/readyz')).status, 200);
});
test('explicit idempotency conflicts and queue backpressure never acknowledge unqueued events', async t => {
  const c = config('http://127.0.0.1:1'); c.maxQueued = 1;
  const store = new Store(':memory:'); t.after(() => store.close());
  const server = createProxy(c, store); const url = await listen(server); t.after(() => close(server));
  const post = (text: string, id: string) => fetch(`${url}/hooks/alerts/${token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': id }, body: JSON.stringify({ text }) });
  assert.equal((await post('first', 'key1')).status, 200);
  assert.equal((await post('first', 'key1')).status, 200);
  assert.equal((await post('changed', 'key1')).status, 409);
  const full = await post('second', 'key2'); assert.equal(full.status, 503); assert.equal(full.headers.get('retry-after'), '30');
  assert.equal(store.stats().pending, 1);
});
test('relay failures, redirects, malformed/wrong acknowledgements, and rate limiting are classified', async t => {
  let mode = '500'; let redirects = 0;
  const other = createServer((_req, res) => { redirects++; res.end('leaked'); });
  const otherUrl = await listen(other); t.after(() => close(other));
  const relay = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const event = JSON.parse(raw);
    if (mode === 'redirect') { res.writeHead(302, { location: otherUrl }); res.end(); }
    else if (mode === 'malformed') res.end('<html>bad gateway</html>');
    else if (mode === 'wrong-id') res.end(JSON.stringify({ accepted: true, event_id: 'wrong' }));
    else if (mode === 'rejected') res.end(JSON.stringify({ accepted: false, event_id: event.id, message: 'restricted: denied' }));
    else { res.writeHead(Number(mode), { 'retry-after': '90' }); res.end('test error'); }
  });
  const url = await listen(relay); t.after(() => close(relay));
  const c = config(url); const client = new BuzzClient(c); const event = messageEvent(c.key, channel, renderPayload({ text: 'Hello' }));
  for (const [value, retryable] of [['500', true], ['429', true], ['403', true], ['400', false], ['redirect', false], ['malformed', true], ['wrong-id', true], ['rejected', false]] as const) {
    mode = value; await assert.rejects(() => client.publish(event, url), (e: unknown) => e instanceof DeliveryError && e.retryable === retryable);
  }
  assert.equal(redirects, 0);
  mode = '429'; await assert.rejects(() => client.publish(event, url), (e: unknown) => e instanceof DeliveryError && e.retryAfterMs === 90000);
});
test('leases recover abandoned jobs; stale workers cannot complete a newer lease', () => {
  const c = config('http://localhost:3000'); const store = new Store(':memory:');
  try {
    const event = messageEvent(c.key, channel, renderPayload({ text: 'x' }));
    store.enqueue('alerts', c.relayUrl, event, 'dedup', 'hash', 1000, 10, 1000);
    const first = store.claim(100, 1000)!; assert.ok(first); assert.equal(store.claim(100, 1050), undefined);
    const next = store.claim(100, 1101)!; assert.ok(next); assert.notEqual(next.lease, first.lease);
    store.complete(first); assert.equal(store.stats().pending, 1);
    store.retry(next, 'permanent_failure', 2000, true); assert.equal(store.stats().failed, 1);
    store.cleanup(1, 1e12); assert.equal(store.stats().failed, 1);
    assert.equal(store.requeue(event.id), 1); assert.equal(store.stats().pending, 1);
  } finally { store.close(); }
});
test('worker records retries and permanent failure, keeping the original signed event', async t => {
  let status = 503;
  const relay = createServer((_req, res) => { res.statusCode = status; res.end('error'); });
  const url = await listen(relay); t.after(() => close(relay));
  const c = config(url); const store = new Store(':memory:'); t.after(() => store.close());
  const event = messageEvent(c.key, channel, renderPayload({ text: 'Persist me' }));
  store.enqueue('alerts', url, event, 'key', 'hash', 1000, 10);
  const worker = new Worker(store, new BuzzClient(c), c.timeoutMs, 7, () => {});
  await worker.tick(); assert.equal(store.stats().pending, 1); assert.equal(store.list()[0]!.attempts, 1);
  const retry = store.claim(1000, Date.now() + 10000)!; assert.equal(JSON.parse(retry.event).id, event.id);
  store.retry(retry, 'test_due', 0, false); status = 400;
  await worker.tick(); assert.equal(store.stats().failed, 1); assert.equal(store.list()[0]!.error, 'buzz_http_400');
});
test('same-content notifications receive distinct event IDs when deduplication expires', () => {
  const c = config('http://localhost:3000'); const r = renderPayload({ text: 'repeat' });
  assert.notEqual(messageEvent(c.key, channel, r).id, messageEvent(c.key, channel, r).id);
  assert.notEqual(authHeader(c.key, c.relayUrl + '/events', '{}'), authHeader(c.key, c.relayUrl + '/events', '{}'));
});
