import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { messageEvent, sha256 } from './buzz.js';
import type { Config } from './config.js';
import { renderPayload } from './render.js';
import { Store } from './store.js';
import { InputError } from './types.js';
import type { Log } from './worker.js';

const sameSecret = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const bearer = (req: IncomingMessage) => req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/i)?.[1] || '';
function body(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0; let chunks: Buffer[] = []; let done = false;
    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer);
      if (error) { chunks = []; reject(error); }
      else { try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { reject(new InputError(400, 'invalid_utf8')); } }
    };
    const timer = setTimeout(() => finish(new InputError(408, 'request_timeout')), 15000);
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > max) finish(new InputError(413, 'payload_too_large'));
      else chunks.push(chunk);
    });
    req.on('end', () => finish());
    req.on('error', () => finish(new InputError(400, 'request_error')));
    req.on('aborted', () => finish(new InputError(400, 'request_aborted')));
  });
}
export function createProxy(config: Config, store: Store, log: Log = () => {}) {
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url || '/', 'http://proxy.invalid');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/healthz') { res.end('ok'); return; }
      if (req.method === 'GET' && path === '/readyz') {
        const stats = store.stats();
        const ready = stats.failed === 0 && stats.oldestPendingSeconds < 300 && (stats.pending ?? 0) < config.maxQueued;
        res.statusCode = ready ? 200 : 503; res.end(ready ? 'ok' : 'delivery_unhealthy'); return;
      }
      if (req.method === 'GET' && ['/metrics', '/status'].includes(path)) {
        if (!config.adminToken) throw new InputError(404, 'not_found');
        if (!sameSecret(bearer(req), config.adminToken)) throw new InputError(401, 'invalid_auth');
        const stats = store.stats();
        if (path === '/status') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...stats, jobs: store.list() })); return; }
        res.setHeader('Content-Type', 'text/plain; version=0.0.4');
        const lines = [
          '# TYPE buzz_proxy_queue_depth gauge', ...(['pending', 'failed', 'delivered'] as const).map(s => `buzz_proxy_queue_depth{state="${s}"} ${stats[s]}`),
          '# TYPE buzz_proxy_oldest_pending_seconds gauge', `buzz_proxy_oldest_pending_seconds ${stats.oldestPendingSeconds}`,
          '# TYPE buzz_proxy_events_total counter', ...['accepted', 'deduplicated', 'delivered', 'retried', 'failed'].map(n => `buzz_proxy_events_total{result="${n}"} ${stats.counters[n] || 0}`),
        ];
        res.end(lines.join('\n') + '\n'); return;
      }
      const match = path.match(/^\/(?:hooks|services)\/([A-Za-z0-9_-]{1,64})(?:\/([A-Za-z0-9_-]{1,256}))?$/);
      if (!match) throw new InputError(404, 'not_found');
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new InputError(405, 'method_not_allowed'); }
      const route = config.routes.find(r => r.name === match[1]);
      const credential = match[2] || bearer(req);
      if (!route || !credential || !sameSecret(credential, route.token)) throw new InputError(401, 'invalid_auth');
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new InputError(415, 'unsupported_encoding');
      const type = (req.headers['content-type'] || '').split(';')[0]?.trim().toLowerCase();
      if (!['application/json', 'application/x-www-form-urlencoded'].includes(type || '')) throw new InputError(415, 'unsupported_content_type');
      if (Number(req.headers['content-length']) > config.maxBodyBytes) throw new InputError(413, 'payload_too_large');
      const raw = await body(req, config.maxBodyBytes);
      let payload: unknown;
      try { payload = JSON.parse(type === 'application/x-www-form-urlencoded' ? new URLSearchParams(raw).get('payload') || '' : raw); }
      catch { throw new InputError(400, 'invalid_payload'); }
      const rendered = renderPayload(payload, route);
      const event = messageEvent(config.key, route.channelId, rendered);
      const explicitKey = req.headers['idempotency-key'];
      if (explicitKey !== undefined && (typeof explicitKey !== 'string' || explicitKey.length < 1 || explicitKey.length > 256)) throw new InputError(400, 'invalid_idempotency_key');
      const hash = sha256(JSON.stringify(payload));
      const scope = `${route.name}:${route.channelId}:${config.relayUrl}:${event.pubkey}:`;
      const dedupeKey = sha256(scope + (explicitKey ? 'explicit:' + explicitKey : 'body:' + hash));
      const queued = store.enqueue(route.name, config.relayUrl, event, dedupeKey, hash, (explicitKey ? 7 * 86400 : config.dedupSeconds) * 1000, config.maxQueued);
      res.setHeader('X-Buzz-Proxy-Event-Id', queued.id);
      res.setHeader('X-Buzz-Proxy-Delivery', queued.duplicate ? 'duplicate' : 'queued');
      if (rendered.warnings.length) res.setHeader('X-Buzz-Proxy-Warnings', rendered.warnings.join(','));
      log({ event: queued.duplicate ? 'deduplicated' : 'queued', id: queued.id, route: route.name, format: rendered.format, warnings: rendered.warnings });
      res.end('ok');
    } catch (e) {
      const error = e instanceof InputError ? e : new InputError(503, 'storage_or_internal_error');
      if (error.status === 503) res.setHeader('Retry-After', '30');
      if (error.message === 'storage_or_internal_error') log({ event: 'storage_or_internal_error' });
      res.statusCode = error.status; res.end(error.message);
      req.resume();
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 256;
  server.maxRequestsPerSocket = 1000;
  return server;
}
