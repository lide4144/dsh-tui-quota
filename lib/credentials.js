import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function createCredentialReader({ env = process.env, readFileImpl = readFile, now = Date.now } = {}) {
  return async source => {
    const missing = () => Object.assign(new Error('Quota authentication required'), { code: 'NEEDS_AUTH' });
    if (source.kind === 'antigravity') {
      // Explicit companion integration only; no scanning Pi, CLI or proxy stores.
      const path = join(env.DSH_HOME || join(homedir(), '.dsh'), 'plugins', 'antigravity', 'auth.json');
      let record;
      try {
        const text = await readFileImpl(path, 'utf8');
        if (Buffer.byteLength(text) > 65536) throw missing();
        record = JSON.parse(text);
      } catch { throw missing(); }
      const credentials = record?.credentials;
      if (record.version !== 1 || typeof credentials?.access !== 'string'
        || !Number.isFinite(credentials.expires) || credentials.expires <= now()) throw missing();
      return { access: credentials.access, projectId: credentials.projectId };
    }
    const value = env[source.keyEnv];
    if (typeof value !== 'string' || !value.trim()) throw missing();
    return value;
  };
}
