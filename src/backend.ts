/**
 * `isloBackend` — a thin `CloudBackend` over `@islo-labs/sdk`, composed into a
 * full AgentBox provider by `createCloudProvider` in `index.ts`. islo is a
 * name-addressed microVM cloud: every op keys off the sandbox *name*, which we
 * use as the `CloudHandle.sandboxId`.
 *
 * Two islo-SDK realities shape this file:
 *   1. exec is a two-step async API — `execInSandbox` returns an id, then you
 *      poll `getExecResult` until the command exits.
 *   2. the typed `uploadFile`/`downloadFile` carry no request/response body, so
 *      file transfer goes directly to the compute-plane `…/files?path=` HTTP
 *      endpoint (same URL the SDK builds) with a bearer token we mint ourselves.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { IsloApi } from '@islo-labs/sdk';
import type {
  CloudBackend,
  CloudExecOptions,
  CloudExecResult,
  CloudFileEntry,
  CloudHandle,
  CloudPreviewUrl,
  CloudProvisionRequest,
  CloudSandboxSummary,
  CloudState,
} from '@madarco/agentbox-provider-sdk';
import { UserFacingError } from '@madarco/agentbox-provider-sdk';
import { parseRcSentinel, wrapWithRcSentinel } from './exec-sentinel.js';
import {
  computeBaseUrl,
  getClient,
  getTokenProvider,
  isloSandboxName,
  isNotFound,
  isRetriable,
  mapState,
  sleep,
  statusCodeOf,
  withRetry,
} from './islo.js';

/** Sentinel meaning "use the provider's own default image" (AgentBox's v0 default). */
export const DEFAULT_BOX_IMAGE_REF = 'agentbox/box:dev';
/** Non-privileged in-box web port (islo's default user can't bind <1024). */
export const ISLO_WEB_PROXY_PORT = 8080;

const DEFAULT_EXEC_TIMEOUT_MS = 300_000; // 5 min per exec, matches e2b/daytona
const EXEC_POLL_INTERVAL_MS = 750;
const PROVISION_READY_TIMEOUT_MS = 180_000;
const SHARE_TTL_SECONDS = 24 * 60 * 60;
const RESUME_BACKOFF_MS = [
  5_000,
  10_000,
  20_000,
  30_000,
  45_000,
  60_000,
  60_000,
  60_000,
  60_000,
  60_000,
  60_000,
] as const;

function sandboxes() {
  return getClient().sandboxes;
}

function resolveImage(req: CloudProvisionRequest): string | undefined {
  if (req.snapshot) return undefined; // snapshot takes precedence over image
  if (req.image && req.image !== DEFAULT_BOX_IMAGE_REF) return req.image;
  return process.env.ISLO_IMAGE || undefined; // undefined → islo's default base image
}

export const isloBackend: CloudBackend = {
  name: 'islo',
  webProxyPort: ISLO_WEB_PROXY_PORT,

  async provision(req: CloudProvisionRequest): Promise<CloudHandle> {
    const name = isloSandboxName(req.name);
    const image = resolveImage(req);
    // AgentBox resources: cpu (count), memory (GiB), disk (GiB). islo wants MB for RAM.
    const vcpus = req.resources?.cpu;
    const memoryMb = req.resources?.memory ? Math.round(req.resources.memory * 1024) : undefined;
    const diskGb = req.resources?.disk;

    // create is billable / non-idempotent → do NOT retry it.
    try {
      await sandboxes().createSandbox({
        name,
        ...(image ? { image } : {}),
        ...(req.snapshot ? { snapshot_name: req.snapshot } : {}),
        ...(vcpus ? { vcpus } : {}),
        ...(memoryMb ? { memory_mb: memoryMb } : {}),
        ...(diskGb ? { disk_gb: diskGb } : {}),
        ...(req.env ? { env: req.env } : {}),
        internet_enabled: true,
      });
    } catch (err) {
      if (statusCodeOf(err) === 503) {
        const imageHint = image
          ? ` The selected image (${image}) may also be unavailable or above islo's image-size limit.`
          : '';
        throw new UserFacingError(
          `islo could not create sandbox "${name}". A recently deleted sandbox name remains reserved while deletion settles; retry with a new name or wait before reusing it.${imageHint}`,
        );
      }
      throw err;
    }

    await waitUntilRunning(name, req.onLog);
    return { sandboxId: name };
  },

  async get(sandboxId: string): Promise<CloudHandle | null> {
    return withRetry('get', async () => {
      try {
        await sandboxes().getSandbox({ sandbox_name: sandboxId });
        return { sandboxId };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    });
  },

  async list(): Promise<CloudSandboxSummary[]> {
    return withRetry('list', async () => {
      const out: CloudSandboxSummary[] = [];
      let cursor: string | undefined;
      do {
        const page = await sandboxes().listSandboxes(cursor ? { cursor } : {});
        for (const item of page.items) {
          out.push({
            sandboxId: item.name,
            name: item.name,
            createdAt: item.created_at,
            state: mapState(item.status),
          });
        }
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      return out;
    });
  },

  async start(h: CloudHandle): Promise<void> {
    // islo has no distinct "start"; a paused/stopped box is brought back with resume.
    await this.resume(h);
  },

  async stop(h: CloudHandle): Promise<void> {
    await withRetry('stop', async () => {
      try {
        await sandboxes().stopSandbox({ sandbox_name: h.sandboxId });
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
    });
  },

  async pause(h: CloudHandle): Promise<void> {
    await withRetry('pause', () => sandboxes().pauseSandbox({ sandbox_name: h.sandboxId }));
  },

  async resume(h: CloudHandle): Promise<void> {
    // resume is async — the API returns while the VM is still transitioning, so
    // wait until it is actually running before handing the box back to callers
    // (which will immediately exec into it).
    if ((await fetchState(h.sandboxId)) === 'running') return;
    try {
      await withRetry(
        'resume',
        () => sandboxes().resumeSandbox({ sandbox_name: h.sandboxId }),
        { backoffMs: RESUME_BACKOFF_MS },
      );
    } catch (err) {
      if (isRetriable(err)) {
        throw new UserFacingError(
          `islo sandbox "${h.sandboxId}" is still settling after pause and could not be resumed yet. Retry shortly; its state is preserved.`,
        );
      }
      throw err;
    }
    await waitUntilRunning(h.sandboxId);
  },

  async destroy(h: CloudHandle): Promise<void> {
    await withRetry('destroy', async () => {
      try {
        await sandboxes().deleteSandbox({ sandbox_name: h.sandboxId });
      } catch (err) {
        if (isNotFound(err)) return; // idempotent: already gone
        throw err;
      }
    });
  },

  async state(h: CloudHandle): Promise<CloudState> {
    return fetchState(h.sandboxId);
  },

  async exec(h: CloudHandle, cmd: string, opts?: CloudExecOptions): Promise<CloudExecResult> {
    const timeoutMs = opts?.attemptTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const wrapped = wrapWithRcSentinel(cmd);
    const startExec = () =>
      sandboxes().execInSandbox({
        sandbox_name: h.sandboxId,
        // non-login shell: avoids /etc/profile motd/clear sequences polluting stdout
        command: ['bash', '-c', wrapped.command],
        ...(opts?.env ? { env: opts.env } : {}),
        ...(opts?.user ? { user: opts.user } : {}),
        ...(opts?.cwd ? { workdir: opts.cwd } : {}),
        timeout_secs: Math.ceil(timeoutMs / 1000),
      });
    // Retry ONLY the start on transient errors — never the whole run. A transient
    // blip during polling must not re-issue `execInSandbox` and re-run a possibly
    // already-completed (possibly non-idempotent) command; `pollExec` absorbs
    // poll-phase transients internally instead. `noRetry` disables even the start
    // retry for a command that isn't safe to re-issue at all.
    const started = opts?.noRetry ? await startExec() : await withRetry('exec', startExec);
    return pollExec(h.sandboxId, started.exec_id, timeoutMs, wrapped.sentinel);
  },

  async uploadFile(h: CloudHandle, localPath: string, remotePath: string): Promise<void> {
    const data = await readFile(localPath);
    await withRetry('uploadFile', async () => {
      // The compute file endpoint expects multipart/form-data with a `file`
      // field; `path` (query) is the full destination path. (The SDK's typed
      // uploadFile omits the body, so we build the request ourselves.)
      const form = new FormData();
      form.append('file', new Blob([data]), basename(remotePath) || 'file');
      const res = await fileFetch(h.sandboxId, remotePath, { method: 'POST', body: form });
      if (!res.ok) throw httpError('uploadFile', res.status, await safeText(res));
    });
  },

  async downloadFile(h: CloudHandle, remotePath: string, localPath: string): Promise<void> {
    await withRetry('downloadFile', async () => {
      const res = await fileFetch(h.sandboxId, remotePath, { method: 'GET' });
      if (!res.ok) throw httpError('downloadFile', res.status, await safeText(res));
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(localPath, buf);
    });
  },

  async listFiles(h: CloudHandle, remoteDir: string): Promise<CloudFileEntry[]> {
    // No SDK/CLI directory-list primitive → derive it from `ls -Ap` (a trailing
    // `/` marks directories). `-A` includes dotfiles but not `.`/`..`.
    const quoted = `'${remoteDir.replace(/'/g, `'\\''`)}'`;
    const r = await this.exec(h, `LC_ALL=C ls -Ap -1 -- ${quoted}`);
    if (r.exitCode !== 0) return [];
    return r.stdout
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
      .map((line) => {
        const isDir = line.endsWith('/');
        return { name: isDir ? line.slice(0, -1) : line, isDir };
      });
  },

  async previewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    return previewUrl(h, port);
  },

  async signedPreviewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    // Islo shares are already public HTTPS URLs and require no header token.
    return previewUrl(h, port);
  },

  async refreshPreviewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    // Revoke every share on this port, then mint a fresh one.
    const shares = getClient().shares;
    try {
      const existing = await shares.listShares({ sandbox_name: h.sandboxId });
      for (const s of existing.filter((x) => x.port === port)) {
        await shares
          .revokeShare({ sandbox_name: h.sandboxId, share_id: s.share_id })
          .catch(() => undefined);
      }
    } catch {
      // best-effort teardown
    }
    const created = await withRetry('createShare', () =>
      shares.createShare({ sandbox_name: h.sandboxId, port, ttl_seconds: SHARE_TTL_SECONDS }),
    );
    return { url: created.url };
  },
};

// ---- module-level helpers (object literals can't hold private methods) ----

async function fetchState(sandboxId: string): Promise<CloudState> {
  return withRetry('state', async () => {
    try {
      const sb = await sandboxes().getSandbox({ sandbox_name: sandboxId });
      return mapState(sb.status);
    } catch (err) {
      if (isNotFound(err)) return 'missing';
      throw err;
    }
  });
}

async function waitUntilRunning(sandboxId: string, onLog?: (line: string) => void): Promise<void> {
  const deadline = Date.now() + PROVISION_READY_TIMEOUT_MS;
  for (;;) {
    const state = await fetchState(sandboxId);
    if (state === 'running') return;
    if (state === 'missing') {
      throw new Error(`islo sandbox ${sandboxId} vanished before it became ready`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `islo sandbox ${sandboxId} not running after ${String(PROVISION_READY_TIMEOUT_MS / 1000)}s (last state: ${state})`,
      );
    }
    onLog?.(`waiting for islo sandbox ${sandboxId} to boot (state: ${state})`);
    await sleep(1500);
  }
}

async function pollExec(
  sandboxName: string,
  execId: string,
  timeoutMs: number,
  sentinel: string,
): Promise<CloudExecResult> {
  const deadline = Date.now() + timeoutMs + 15_000; // grace over the in-box cap
  for (;;) {
    // getExecResult is a read: on a transient blip, retry the POLL rather than
    // letting the error bubble up to exec()'s start-retry and re-run the command.
    let r: IsloApi.ExecResultResponse;
    try {
      r = await sandboxes().getExecResult({ sandbox_name: sandboxName, exec_id: execId });
    } catch (err) {
      if (!isRetriable(err) || Date.now() > deadline) throw err;
      await sleep(EXEC_POLL_INTERVAL_MS);
      continue;
    }
    const done = r.exit_code !== null && r.exit_code !== undefined;
    const terminal =
      done || /(complete|exit|finish|done|fail|error|timeout|kill|cancel)/i.test(r.status);
    const sentinelResult = parseRcSentinel(r.stdout, sentinel);
    if (terminal || sentinelResult) {
      if (r.truncated) {
        process.stderr.write(
          `[islo] exec ${execId} output was truncated by the platform cap — downstream parsing may see partial data\n`,
        );
      }
      if (sentinelResult) {
        return {
          exitCode: sentinelResult.exitCode,
          stdout: sentinelResult.stdout,
          stderr: r.stderr,
        };
      }
      return {
        exitCode: r.exit_code ?? (r.status.toLowerCase() === 'completed' ? 0 : 1),
        stdout: r.stdout,
        stderr: r.stderr,
      };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `islo exec ${execId} did not finish within ${String(timeoutMs / 1000)}s (status: ${r.status})`,
      );
    }
    await sleep(EXEC_POLL_INTERVAL_MS);
  }
}

async function previewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
  const shares = getClient().shares;
  // Reuse a live share for this port so the host poller doesn't mint a new one
  // on every probe; only create when none is active.
  try {
    const existing = await shares.listShares({ sandbox_name: h.sandboxId });
    const live = existing.find((s) => s.port === port && !isExpired(s.expires_at));
    if (live) return { url: live.url };
  } catch {
    // listing is best-effort; fall through to create
  }
  const created = await withRetry('createShare', () =>
    shares.createShare({ sandbox_name: h.sandboxId, port, ttl_seconds: SHARE_TTL_SECONDS }),
  );
  return { url: created.url };
}

async function fileFetch(
  sandboxName: string,
  remotePath: string,
  init: RequestInit,
): Promise<Response> {
  const token = await getTokenProvider().getToken();
  const url = `${computeBaseUrl()}/sandboxes/${encodeURIComponent(sandboxName)}/files?path=${encodeURIComponent(remotePath)}`;
  return fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
}

function isExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false; // no expiry → never expired
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= Date.now();
}

function httpError(op: string, status: number, body: string): Error {
  const snippet = body.length > 300 ? `${body.slice(0, 300)}…` : body;
  const err = new Error(
    `islo ${op} failed: HTTP ${String(status)}${snippet ? ` — ${snippet}` : ''}`,
  );
  // Expose the numeric status so `withRetry`/`isRetriable` can absorb a transient
  // 5xx/429 from the compute file endpoint (a bare message string can't be classified).
  (err as Error & { statusCode: number }).statusCode = status;
  return err;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).trim();
  } catch {
    return '';
  }
}
