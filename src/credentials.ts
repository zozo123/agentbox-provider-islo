import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { UserFacingError, type CredStatusSummary } from '@madarco/agentbox-provider-sdk';
import { ensureIsloEnvLoaded, reloadIsloEnv } from './env-loader.js';

/** Control-plane + compute-plane defaults (overridable via env). */
export const DEFAULT_BASE_URL = 'https://api.islo.dev';
export const DEFAULT_COMPUTE_URL = 'https://ca.compute.islo.dev';

const SECRETS_PATH = resolve(homedir(), '.agentbox', 'secrets.env');

export interface IsloCredStatus {
  auth: 'api-key' | 'none';
  source: 'env' | 'secrets.env' | 'none';
  key?: string;
}

/** Endpoint config used by both the SDK client and the raw compute transfers. */
export interface IsloEndpoints {
  baseUrl: string;
  computeUrl: string;
}

export function resolveEndpoints(): IsloEndpoints {
  ensureIsloEnvLoaded();
  return {
    baseUrl: process.env.ISLO_BASE_URL || DEFAULT_BASE_URL,
    computeUrl: process.env.ISLO_COMPUTE_URL || DEFAULT_COMPUTE_URL,
  };
}

/** Resolve the islo API key or throw a clear, actionable error. */
export function resolveApiKey(): string {
  ensureIsloEnvLoaded();
  const key = process.env.ISLO_API_KEY;
  if (!key) {
    throw new UserFacingError(
      'islo credentials not configured. Create a key with `islo api-key create <name>` and either ' +
        'export ISLO_API_KEY=… or add `ISLO_API_KEY=…` to ~/.agentbox/secrets.env.',
    );
  }
  return key;
}

export function hasUsableCredentials(): boolean {
  ensureIsloEnvLoaded();
  return Boolean(process.env.ISLO_API_KEY);
}

export function readIsloCredStatus(): IsloCredStatus {
  const shellHad = process.env.ISLO_API_KEY !== undefined;
  ensureIsloEnvLoaded();
  const key = process.env.ISLO_API_KEY;
  if (!key) return { auth: 'none', source: 'none' };
  return { auth: 'api-key', source: shellHad ? 'env' : 'secrets.env', key };
}

export function readCredStatusSummary(): CredStatusSummary {
  const cred = readIsloCredStatus();
  return { configured: cred.auth !== 'none', label: cred.auth };
}

/**
 * Headless credential set: persist ISLO_API_KEY (and any endpoint overrides) to
 * the 0600 `~/.agentbox/secrets.env`, then reload so the running process sees
 * it. Mirrors the built-in providers' `setCredentials`.
 */
export function setIsloCredentials(fields: {
  apiKey?: string;
  baseUrl?: string;
  computeUrl?: string;
}): { ok: true } {
  const apiKey = fields.apiKey?.trim();
  if (!apiKey) throw new UserFacingError('an ISLO_API_KEY value is required');
  const managed: Record<string, string> = { ISLO_API_KEY: apiKey };
  if (fields.baseUrl) managed.ISLO_BASE_URL = fields.baseUrl;
  if (fields.computeUrl) managed.ISLO_COMPUTE_URL = fields.computeUrl;
  writeManagedSecrets(managed);
  reloadIsloEnv();
  return { ok: true };
}

/** Ensure a key is present; used by the CLI on first `create --provider islo`. */
export async function ensureIsloCredentials(): Promise<void> {
  resolveApiKey();
}

/**
 * Merge `values` into `~/.agentbox/secrets.env`, editing only the keys this
 * provider owns. Other providers' lines are preserved verbatim — comments,
 * `export` prefixes, and quoting are left untouched (a normalize-everything
 * rewrite could silently un-quote another provider's value and break it).
 * Enforces mode 0600 even when the file already exists (the `writeFileSync`
 * mode only applies on creation).
 */
function writeManagedSecrets(values: Record<string, string>): void {
  mkdirSync(dirname(SECRETS_PATH), { recursive: true });
  let lines: string[] = [];
  try {
    lines = readFileSync(SECRETS_PATH, 'utf8').split(/\r?\n/);
  } catch {
    // no existing file — start fresh
  }
  const remaining = new Set(Object.keys(values));
  const out = lines.map((line) => {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line.trim());
    if (m && remaining.has(m[1])) {
      remaining.delete(m[1]);
      return `${m[1]}=${values[m[1]]}`;
    }
    return line;
  });
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  for (const key of remaining) out.push(`${key}=${values[key]}`);
  writeFileSync(SECRETS_PATH, out.join('\n') + '\n', { mode: 0o600 });
  chmodSync(SECRETS_PATH, 0o600);
}
