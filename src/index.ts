/**
 * agentbox-provider-islo — a real, working AgentBox provider plugin for
 * [islo.dev](https://islo.dev), built only on `@madarco/agentbox-provider-sdk`
 * and the official `@islo-labs/sdk`. Install it and run
 * `agentbox create --provider islo`.
 *
 * islo is a name-addressed microVM cloud with first-class pause/resume, a
 * two-step async exec API, and public port sharing. The whole lifecycle
 * (workspace seeding, ctl launch, relay wiring, preview URLs, cp) is supplied
 * by the SDK's `createCloudProvider` on top of the thin `CloudBackend` in
 * `backend.ts` — "a cloud is one file".
 *
 * v0 scope: create / lifecycle (start/stop/pause/resume) / exec / file cp /
 * public preview URLs / prune. Base-image `prepare` and `checkpoint` are not
 * overridden — boxes boot from islo's default (or `ISLO_IMAGE`) image, and the
 * scaffold's default exec-driven attach handles interactive sessions without
 * SSH.
 */
import {
  createCloudProvider,
  errSummary,
  type CheckResult,
  type CredStatusSummary,
  type Provider,
  type ProviderModule,
} from '@madarco/agentbox-provider-sdk';
import { isloBackend, DEFAULT_BOX_IMAGE_REF, ISLO_WEB_PROXY_PORT } from './backend.js';
import {
  ensureIsloCredentials,
  readCredStatusSummary,
  readIsloCredStatus,
  resolveEndpoints,
} from './credentials.js';

const cloudProvider = createCloudProvider(isloBackend, {
  // islo default box shape; overridable per-create with --cpu/--memory/--disk.
  defaultResources: { cpu: 2, memory: 4, disk: 20 },
  // islo microVMs don't run a nested dockerd by default; enabling it would log a
  // spurious failure on every create/start. Docker-in-docker is a future opt-in
  // via islo's `init` docker capability.
  launchDockerd: false,
});

export const isloProvider: Provider = cloudProvider;

async function doctorChecks(): Promise<CheckResult[]> {
  try {
    const cred = readIsloCredStatus();
    const { baseUrl, computeUrl } = resolveEndpoints();
    const credRes: CheckResult =
      cred.auth === 'none'
        ? {
            label: 'credentials',
            status: 'warn',
            detail: 'ISLO_API_KEY not set',
            hint: 'create one with `islo api-key create <name>`, then export ISLO_API_KEY or add it to ~/.agentbox/secrets.env',
          }
        : { label: 'credentials', status: 'ok', detail: `api-key (${cred.source})` };
    const endpointRes: CheckResult = {
      label: 'endpoints',
      status: 'info',
      detail: `${baseUrl} / ${computeUrl}`,
    };
    return [credRes, endpointRes];
  } catch (err) {
    return [{ label: 'credentials', status: 'warn', detail: errSummary(err) }];
  }
}

/** Uniform surface the CLI provider loader resolves this package through. */
export const providerModule: ProviderModule = {
  provider: isloProvider,
  backend: isloBackend,
  ensureCredentials: ensureIsloCredentials,
  readCredStatus: (): CredStatusSummary => readCredStatusSummary(),
  currentBaseFingerprintLive: () => Promise.resolve(undefined),
  doctorChecks,
};

export { isloBackend, DEFAULT_BOX_IMAGE_REF, ISLO_WEB_PROXY_PORT };
