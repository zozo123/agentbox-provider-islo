/**
 * SDK plumbing for the islo backend: the authenticated `@islo-labs/sdk` client,
 * a bearer-token provider for the raw compute-plane file transfers (the SDK's
 * typed `uploadFile`/`downloadFile` send/return no body — see `backend.ts`), a
 * small transient-error retry, and the islo→AgentBox state/name mappings.
 */
import { Islo, IsloApiError, TokenProvider } from '@islo-labs/sdk';
import type { CloudState } from '@madarco/agentbox-provider-sdk';
import { resolveApiKey, resolveEndpoints } from './credentials.js';

let cachedClient: Islo | undefined;
let cachedTokenProvider: TokenProvider | undefined;

/** The authenticated SDK client (lifecycle + exec). Constructed once per process. */
export function getClient(): Islo {
  if (cachedClient) return cachedClient;
  const apiKey = resolveApiKey();
  const { baseUrl, computeUrl } = resolveEndpoints();
  // Passing the raw access key as `apiKey` makes the SDK auto-exchange it for a
  // short-lived session JWT and keep it refreshed.
  cachedClient = new Islo({ apiKey, baseUrl, computeUrl });
  return cachedClient;
}

/** A cached, auto-refreshing session-JWT provider for direct compute-plane fetches. */
export function getTokenProvider(): TokenProvider {
  if (cachedTokenProvider) return cachedTokenProvider;
  const apiKey = resolveApiKey();
  const { baseUrl } = resolveEndpoints();
  cachedTokenProvider = new TokenProvider({ baseUrl, apiKey });
  return cachedTokenProvider;
}

export function computeBaseUrl(): string {
  return resolveEndpoints().computeUrl.replace(/\/+$/, '');
}

/** True for a definitively-absent sandbox (404 / not-found), so ops can be idempotent. */
export function isNotFound(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; message?: string } | undefined;
  if (!e) return false;
  const code = statusCodeOf(e);
  // Trust the status code when the SDK gives us one — don't let a 500 whose body
  // happens to contain "not found" masquerade as a clean 404.
  if (code !== undefined) return code === 404;
  // No status (e.g. a transport-level error) → narrow message fallback.
  return typeof e.message === 'string' && /\b404\b|not\s+found/i.test(e.message);
}

function statusCodeOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number; status?: number } | undefined;
  return e?.statusCode ?? e?.status;
}

/** Retriable = transient network blip or a 429/5xx; never a 4xx client error. */
export function isRetriable(err: unknown): boolean {
  const code = statusCodeOf(err);
  if (code === 429) return true;
  if (code !== undefined && code >= 500) return true;
  if (code !== undefined && code >= 400) return false; // definite client error
  // Undici / DNS transport errors surface as codes on err or err.cause.
  const codes = [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ECONNABORTED',
  ];
  const raw = err as { code?: string; cause?: { code?: string } } | undefined;
  return Boolean(
    (raw?.code && codes.includes(raw.code)) || (raw?.cause?.code && codes.includes(raw.cause.code)),
  );
}

const BACKOFF_MS = [500, 1500, 3000];

/** Retry a transient-failing op with bounded exponential-ish backoff. */
export async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === BACKOFF_MS.length || !isRetriable(err)) break;
      const delay = BACKOFF_MS[attempt];
      process.stderr.write(
        `[islo-retry] ${label} attempt ${String(attempt + 1)} failed, retrying in ${String(delay)}ms\n`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * islo sandbox names must be DNS-ish (lowercase alnum + dashes). AgentBox box
 * names (e.g. `myproj-1`) already fit; this just hardens against odd input so
 * `create` never 400s on a name we chose.
 */
export function isloSandboxName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 60)
    // Strip leading/trailing dashes AFTER truncating, so a cut at the 60-char
    // boundary can't reintroduce a trailing dash (which islo would 400 on).
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'agentbox-box';
}

/** Map islo's free-form status string onto AgentBox's four coarse states. */
export function mapState(status: string | undefined | null): CloudState {
  switch ((status ?? '').toLowerCase()) {
    case 'running':
    case 'starting':
      return 'running';
    case 'paused':
      return 'paused';
    case 'stopping':
    case 'stopped':
      return 'stopped';
    case 'failed':
    case 'deleted':
    case 'deleting':
      return 'missing';
    default:
      return 'stopped';
  }
}

export { IsloApiError };
