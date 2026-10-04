import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools';
import type { Rendered } from './types.js';
import type { Config } from './config.js';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export function messageEvent(key: Uint8Array, channel: string, message: Rendered): Event {
  const tags = [['h', channel], ['client', 'buzz-slack-proxy'], ['nonce', randomUUID()], ...message.mentions.map(p => ['p', p])];
  if (message.broadcast) tags.push(['broadcast', '1']);
  return finalizeEvent({ kind: 9, created_at: Math.floor(Date.now() / 1000), tags, content: message.content }, key);
}
export function authHeader(key: Uint8Array, url: string, body: string): string {
  const auth = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [
    ['u', url], ['method', 'POST'], ['payload', sha256(body)], ['nonce', randomUUID()],
  ] }, key);
  return 'Nostr ' + Buffer.from(JSON.stringify(auth)).toString('base64');
}
export class DeliveryError extends Error {
  constructor(public code: string, public retryable: boolean, public retryAfterMs = 0) { super(code); }
}
function post(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = new URL(url).protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(url, { method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs) }, async response => {
      const status = response.statusCode || 502;
      if (status < 200 || status >= 300) {
        resolve({ status, headers: response.headers, body: '' }); response.destroy(); return;
      }
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of response) {
          size += chunk.length;
          if (size > 1048576) throw new DeliveryError('buzz_response_too_large', false);
          chunks.push(Buffer.from(chunk));
        }
        resolve({ status, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') });
      } catch (error) { response.destroy(); reject(error); }
    });
    req.on('error', reject); req.end(body);
  });
}
function retryDelay(value: string | null) {
  if (!value) return 0;
  const ms = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(86400000, Math.max(0, ms)) : 0;
}
export class BuzzClient {
  publicKey: string;
  constructor(private config: Pick<Config, 'key' | 'relayUrl' | 'transportUrl' | 'authTag' | 'timeoutMs'>) { this.publicKey = getPublicKey(config.key); }
  async request(path: '/events' | '/query', body: string): Promise<unknown> {
    const url = this.config.relayUrl + path;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', authorization: authHeader(this.config.key, url, body) };
      if (this.config.authTag) headers['x-auth-tag'] = this.config.authTag;
      // Internal service routing must preserve the community authority and the
      // externally configured URL that Buzz expects in the NIP-98 proof.
      if (this.config.transportUrl) headers.host = new URL(this.config.relayUrl).host;
      const transportUrl = (this.config.transportUrl || this.config.relayUrl) + path;
      // Node's fetch rewrites Host, so use the native HTTP client. It never
      // follows redirects and permits the explicit community authority.
      const response = await post(transportUrl, headers, body, this.config.timeoutMs);
      if (response.status < 200 || response.status >= 300) {
        throw new DeliveryError(`buzz_http_${response.status}`, [401, 403, 408, 425, 429].includes(response.status) || response.status >= 500,
          Math.max(retryDelay(response.headers['retry-after'] || null), [401, 403].includes(response.status) ? 60000 : 0));
      }
      try { return JSON.parse(response.body); } catch { throw new DeliveryError('buzz_invalid_response', true); }
    } catch (e) {
      if (e instanceof DeliveryError) throw e;
      throw new DeliveryError('buzz_network_or_timeout', true);
    }
  }
  async publish(event: Event, relayUrl: string): Promise<void> {
    if (relayUrl !== this.config.relayUrl || event.pubkey !== this.publicKey) throw new DeliveryError('destination_or_identity_changed', false);
    const data = await this.request('/events', JSON.stringify(event)) as Record<string, unknown>;
    if (!data || data.event_id !== event.id) throw new DeliveryError('buzz_invalid_ack', true);
    if (data.accepted === true) return;
    if (data.accepted === false && typeof data.message === 'string' && data.message.startsWith('duplicate:')) return;
    throw new DeliveryError('buzz_rejected_event', false);
  }
}
