import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { renderPayload } from './render.js';
import { loadConfig } from './config.js';
import { loadEnv } from './env.js';
import { BuzzClient } from './buzz.js';
import { Store } from './store.js';
import { arr, obj, str } from './types.js';

process.umask(0o077);
loadEnv();
const [, , command, arg, extra] = process.argv;
try {
  if (command === 'init') {
    const paths = ['.env', 'routes.json', 'secrets/bot.key', 'secrets/webhook.token', 'secrets/admin.token'];
    if (paths.some(existsSync)) throw new Error('Initialization would overwrite existing configuration; use the examples or a new directory.');
    mkdirSync('secrets', { recursive: true, mode: 0o700 });
    mkdirSync('data', { recursive: true, mode: 0o700 });
    const key = generateSecretKey(); const pubkey = getPublicKey(key);
    writeFileSync(paths[2]!, Buffer.from(key).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    for (const path of paths.slice(3)) writeFileSync(path, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    writeFileSync('routes.json', JSON.stringify({ routes: [{ name: 'alerts', channelId: '00000000-0000-0000-0000-000000000000', tokenEnv: 'ALERTS_WEBHOOK_TOKEN', allowBroadcast: false }] }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    writeFileSync('.env', `BUZZ_RELAY_URL=https://YOUR-COMMUNITY.buzz.xyz\nBUZZ_PRIVATE_KEY_FILE=secrets/bot.key\nALERTS_WEBHOOK_TOKEN_FILE=secrets/webhook.token\nADMIN_TOKEN_FILE=secrets/admin.token\nROUTES_FILE=routes.json\nDATABASE_PATH=data/outbox.sqlite\nPROXY_UID=${process.getuid?.() ?? 1000}\nPROXY_GID=${process.getgid?.() ?? 1000}\n`, { flag: 'wx', mode: 0o600 });
    console.log(`Created configuration and secrets. Bot public key: ${pubkey}\n${nip19.npubEncode(pubkey)}\nSet your relay in .env and channel UUID in routes.json. Admit this identity to your Buzz community and channel before starting.`);
  } else if (command === 'preview') {
    if (!arg) throw new Error('Usage: npm run preview -- examples/block-kit.json');
    const rendered = renderPayload(JSON.parse(readFileSync(arg, 'utf8')));
    console.log(rendered.content);
    if (rendered.warnings.length) console.error('Compatibility notes: ' + rendered.warnings.join(', '));
  } else if (command === 'doctor') {
    const config = loadConfig(); const client = new BuzzClient(config);
    const events = await client.request('/query', JSON.stringify([{ kinds: [39000], limit: 500 }]));
    console.log(JSON.stringify({ publicKey: client.publicKey, relay: config.relayUrl, authenticated: true,
      channels: arr(events).map(e => { const o = obj(e); const tags = arr(o.tags).map(arr); return { id: tags.find(t => t[0] === 'd')?.[1], name: tags.find(t => t[0] === 'name')?.[1] }; }),
      note: 'Read access verified. Posting permission requires a test notification after joining the destination channel.' }, null, 2));
  } else if (command === 'queue') {
    const store = new Store(process.env.DATABASE_PATH || 'data/outbox.sqlite');
    try {
      if (arg === 'retry') {
        if (!extra || !/^[a-f0-9]{64}$/.test(extra)) throw new Error('Usage: npm run queue -- retry EVENT_ID');
        console.log(JSON.stringify({ requeued: store.requeue(extra) }));
      } else console.log(JSON.stringify({ ...store.stats(), jobs: store.list() }, null, 2));
    } finally { store.close(); }
  } else throw new Error('Commands: init, preview FILE, doctor, queue [retry EVENT_ID]');
} catch (error) {
  // Config errors do not contain key material; transport errors expose only stable codes.
  console.error(error instanceof Error ? error.message : str(error)); process.exitCode = 1;
}
