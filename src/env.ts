export function loadEnv() {
  try { process.loadEnvFile('.env'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
