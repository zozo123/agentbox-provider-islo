import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * islo env auto-loader. The provider reads its credential + endpoint overrides
 * from `process.env`, falling back to `~/.agentbox/secrets.env` (written by
 * `agentbox islo login` / `islo api-key create` piped into that file) — the
 * same one-time-login model the built-in daytona/e2b/vercel providers use.
 *
 * Lookup order (first wins; process.env is never overwritten):
 *   1. `process.env` (already set in the shell / by `agentbox create --env`).
 *   2. `~/.agentbox/secrets.env`.
 *
 * Project-level `.env` / `.env.local` are intentionally NOT consulted: those
 * belong to the app code running *inside* the box, not to the host CLI that
 * provisions sandboxes.
 *
 * Only `ISLO_`-prefixed keys are imported; the rest of the file is left alone.
 * Idempotent and side-effect-free after the first call.
 */
export const ISLO_KEYS = [
  'ISLO_API_KEY',
  'ISLO_BASE_URL',
  'ISLO_COMPUTE_URL',
  'ISLO_IMAGE',
] as const;

let loaded = false;

export function ensureIsloEnvLoaded(): void {
  if (loaded) return;
  loaded = true;
  importFromFile(resolve(homedir(), '.agentbox', 'secrets.env'), ISLO_KEYS);
}

/** Force a re-read (used right after an interactive login persists the key). */
export function reloadIsloEnv(): void {
  loaded = false;
  ensureIsloEnvLoaded();
}

function importFromFile(path: string, keys: readonly string[]): void {
  if (!existsSync(path)) return;
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const parsed = parseEnvFile(body);
  for (const key of keys) {
    if (process.env[key] !== undefined) continue;
    const value = parsed[key];
    if (typeof value === 'string') process.env[key] = value;
  }
}

/**
 * Minimal `.env` parser: handles `KEY=value`, `KEY="value"`, `KEY='value'`,
 * `export KEY=value`, blank lines, and `#` comments. No interpolation —
 * predictable over feature-complete (matches the built-in loaders' behavior).
 */
export function parseEnvFile(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
