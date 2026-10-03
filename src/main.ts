import { loadConfig } from './config.js';
import { loadEnv } from './env.js';
import { BuzzClient } from './buzz.js';
import { Store } from './store.js';
import { Worker, type Log } from './worker.js';
import { createProxy } from './server.js';

process.umask(0o077);
loadEnv();
const config = loadConfig();
const store = new Store(config.dbPath);
const log: Log = data => console.log(JSON.stringify({ time: new Date().toISOString(), ...data }));
const client = new BuzzClient(config);
const worker = new Worker(store, client, config.timeoutMs, config.retentionDays, log);
const server = createProxy(config, store, log);
server.on('error', () => { log({ event: 'http_server_error' }); process.exitCode = 1; void shutdown(); });
server.listen(config.port, config.host, () => {
  log({ event: 'started', port: config.port, publicKey: client.publicKey, routes: config.routes.map(r => r.name) }); worker.start();
});
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  const hardStop = setTimeout(() => process.exit(1), config.timeoutMs + 25000); hardStop.unref();
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  await worker.stop(); await closed; store.close(); clearTimeout(hardStop);
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
