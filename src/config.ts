import { readFileSync } from 'node:fs';
import { getPublicKey, nip19 } from 'nostr-tools';
import { arr, obj, str, type RenderOptions } from './types.js';

export interface Route extends RenderOptions { name: string; channelId: string; token: string }
export interface Config {
  host: string; port: number; relayUrl: string; key: Uint8Array; authTag?: string;
  routes: Route[]; dbPath: string; adminToken?: string; maxBodyBytes: number;
  maxQueued: number; dedupSeconds: number; retentionDays: number; timeoutMs: number;
}
function secret(env: NodeJS.ProcessEnv, name: string): string {
  if (env[name] && env[`${name}_FILE`]) throw new Error(`Set only ${name} or ${name}_FILE`);
  return (env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`]!, 'utf8') : env[name] || '').trim();
}
export function parseKey(raw: string): Uint8Array {
  let key: Uint8Array;
  if (/^[0-9a-f]{64}$/i.test(raw)) key = Uint8Array.from(Buffer.from(raw, 'hex'));
  else if (raw.startsWith('nsec1')) { const value = nip19.decode(raw); if (value.type !== 'nsec') throw new Error('Invalid key'); key = value.data; }
  else throw new Error('BUZZ_PRIVATE_KEY must be 64 hex characters or nsec');
  getPublicKey(key); // Reject zero / invalid curve scalars at startup.
  return key;
}
export function normalizeRelay(raw: string): string {
  const u = new URL(raw);
  if (u.protocol === 'wss:') u.protocol = 'https:';
  if (u.protocol === 'ws:') u.protocol = 'http:';
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('BUZZ_RELAY_URL must be a community relay origin, without path, query or credentials');
  return u.origin;
}
function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const n = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const doc = obj(JSON.parse(readFileSync(env.ROUTES_FILE || 'routes.json', 'utf8')));
  const routes = arr(doc.routes).map(value => {
    const r = obj(value); const name = str(r.name); const channelId = str(r.channelId);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('Invalid route name');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(channelId)) throw new Error(`Route ${name}: channelId must be a Buzz channel UUID`);
    if (r.tokenEnv && r.tokenFile) throw new Error(`Route ${name}: set tokenEnv or tokenFile`);
    const token = r.tokenFile ? readFileSync(str(r.tokenFile), 'utf8').trim() : secret(env, str(r.tokenEnv));
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error(`Route ${name}: token must be 32–256 URL-safe characters`);
    const users: Record<string, string> = Object.create(null);
    for (const [id, key] of Object.entries(obj(r.users))) {
      if (!/^[a-f0-9]{64}$/i.test(str(key))) throw new Error(`Route ${name}: invalid user mapping`);
      users[id] = str(key).toLowerCase();
    }
    if (r.allowBroadcast !== undefined && typeof r.allowBroadcast !== 'boolean') throw new Error(`Route ${name}: allowBroadcast must be boolean`);
    return { name, channelId: channelId.toLowerCase(), token, users, allowBroadcast: r.allowBroadcast === true };
  });
  if (!routes.length || routes.length > 100 || new Set(routes.map(r => r.name)).size !== routes.length) throw new Error('Configure 1–100 uniquely named routes');
  const authTag = secret(env, 'BUZZ_AUTH_TAG');
  if (authTag) { const tag: unknown = JSON.parse(authTag); if (!Array.isArray(tag) || tag.length !== 4 || tag[0] !== 'auth' || !tag.every(v => typeof v === 'string')) throw new Error('BUZZ_AUTH_TAG must be a NIP-OA auth tag JSON array'); }
  const adminToken = secret(env, 'ADMIN_TOKEN');
  if (adminToken && !/^[A-Za-z0-9_-]{32,256}$/.test(adminToken)) throw new Error('ADMIN_TOKEN must be 32–256 URL-safe characters');
  return {
    host: env.HOST || '0.0.0.0', port: integer(env, 'PORT', 8080, 1, 65535),
    relayUrl: normalizeRelay(env.BUZZ_RELAY_URL || ''), key: parseKey(secret(env, 'BUZZ_PRIVATE_KEY')),
    authTag: authTag || undefined, routes, dbPath: env.DATABASE_PATH || 'data/outbox.sqlite', adminToken: adminToken || undefined,
    maxBodyBytes: integer(env, 'MAX_BODY_BYTES', 1048576, 1024, 4194304),
    maxQueued: integer(env, 'MAX_QUEUED', 10000, 1, 100000),
    dedupSeconds: integer(env, 'DEDUP_SECONDS', 60, 0, 3600),
    retentionDays: integer(env, 'RETENTION_DAYS', 7, 1, 90),
    timeoutMs: integer(env, 'BUZZ_TIMEOUT_MS', 10000, 100, 60000),
  };
}
