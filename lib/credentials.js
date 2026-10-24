import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// dsh-tui's built-in `/auth` OAuth store ids (pi-ai provider ids).
const DSH_AUTH_IDS = { 'codex-subscription': 'openai-codex', 'claude-subscription': 'anthropic' };
const MAX_FILE = 262144;

/**
 * Explicit, read-only credential lookups. Never refreshes or writes tokens:
 * an expired access token reports NEEDS_AUTH and the owning plugin renews it
 * on its next model request.
 */
export function createCredentialReader({ env = process.env, readFileImpl = readFile, now = Date.now, credentials } = {}) {
  const missing = () => Object.assign(new Error('Quota authentication required'), { code: 'NEEDS_AUTH' });
  const home = () => env.DSH_HOME || join(homedir(), '.dsh');
  async function readJson(path) {
    let text;
    try { text = await readFileImpl(path, 'utf8'); } catch { throw missing(); }
    if (Buffer.byteLength(text) > MAX_FILE) throw missing();
    try { return JSON.parse(text); } catch { throw missing(); }
  }
  const fresh = record => typeof record?.access === 'string' && record.access.length > 0
    && Number.isFinite(record.expires) && record.expires > now();
  return async source => {
    if (source.kind === 'antigravity') {
      // Companion plugin only; no scanning Pi, CLI or proxy stores.
      const record = await readJson(join(home(), 'plugins', 'antigravity', 'auth.json'));
      const value = record?.credentials;
      if (record?.version !== 1 || !fresh(value)) throw missing();
      return { access: value.access, projectId: value.projectId };
    }
    if (DSH_AUTH_IDS[source.kind]) {
      const path = env.DSH_AUTH_CREDENTIALS || join(home(), 'dsh-auth', 'credentials.json');
      const value = (await readJson(path))?.providers?.[DSH_AUTH_IDS[source.kind]];
      if (value?.type !== 'oauth' || !fresh(value)) throw missing();
      // Return only what the request needs; refresh tokens never leave this function.
      return { access: value.access, ...(typeof value.accountId === 'string' ? { accountId: value.accountId } : {}) };
    }
    // API-key sources: DSH credential service (.credentials.yaml > env > .env), then process env.
    try {
      const resolved = await credentials?.resolve?.(source.keyEnv);
      if (typeof resolved?.value === 'string' && resolved.value.trim()) return resolved.value;
    } catch { /* fall back to process env */ }
    const value = env[source.keyEnv];
    if (typeof value !== 'string' || !value.trim()) throw missing();
    return value;
  };
}
