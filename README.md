# agentbox-provider-islo

An [AgentBox](https://agent-box.sh) **provider plugin** for [islo.dev](https://islo.dev) —
run your agents on islo microVMs with `agentbox create --provider islo`. Built only on
[`@madarco/agentbox-provider-sdk`](https://www.npmjs.com/package/@madarco/agentbox-provider-sdk)
and the official [`@islo-labs/sdk`](https://www.npmjs.com/package/@islo-labs/sdk).

It's a thin [`CloudBackend`](https://agent-box.sh/docs/build-a-provider) over the islo SDK,
composed into a full provider by the SDK's `createCloudProvider` — so the whole lifecycle
(workspace seeding, ctl launch, relay wiring, preview URLs, `cp`) comes for free on top of
~13 methods. islo is a **name-addressed** cloud with a two-step async exec API and multipart
file transfer.

## Install

```bash
# from npm
npm i -g agentbox-provider-islo
agentbox plugin add agentbox-provider-islo

# …or straight from source (npm builds it via the `prepare` script)
npm i -g github:zozo123/agentbox-provider-islo
agentbox plugin add agentbox-provider-islo
```

`agentbox plugin list` should then show `islo … (SDK v2)`.

## Credentials

Create an islo API key and expose it as `ISLO_API_KEY` (the plugin also reads it from
`~/.agentbox/secrets.env`):

```bash
islo api-key create agentbox --show     # print the key
export ISLO_API_KEY=isl_...              # or add ISLO_API_KEY=… to ~/.agentbox/secrets.env
agentbox doctor                          # shows the `islo:` group
```

The key (a Descope access key) is auto-exchanged by `@islo-labs/sdk` for a short-lived session
JWT, refreshed transparently. Optional overrides: `ISLO_BASE_URL` (control plane, default
`https://api.islo.dev`), `ISLO_COMPUTE_URL` (compute plane, default `https://ca.compute.islo.dev`),
`ISLO_IMAGE` (base image ref).

## Capabilities

| Capability | islo mapping |
| --- | --- |
| provision / get / list | `sandboxes.createSandbox` / `getSandbox` / `listSandboxes` (keyed by name) |
| start / stop / pause / resume | `resumeSandbox` / `stopSandbox` / `pauseSandbox` / `resumeSandbox` (waits for `running`) |
| destroy | `deleteSandbox` (idempotent on 404) |
| exec | `execInSandbox` + streamed completion sentinel (handles detached daemons without re-running commands) |
| upload / download / list files | compute `…/files` endpoint (multipart upload) + `ls -Ap` for listing |
| preview URL | `shares.createShare` (public HTTPS, reused per port and browser-safe) |

Verified end-to-end against the live islo API: provision, exec (stdout + exit codes), file
upload/download round-trip, `listFiles`, `previewUrl`, `pause`→`resume`, `list`, and `destroy`.

## AgentBox runtime image

islo currently rejects large container images with `503 RESOURCE_UNAVAILABLE`; the stock
AgentBox image is about 1.3 GB compressed and does not boot. This repository therefore publishes
a slim runtime image built from [`runtime/Dockerfile`](./runtime/Dockerfile). It contains Node,
git, tmux, sudo, rsync, and the version-matched `agentbox-ctl`, without the VNC/browser stack.

```bash
export ISLO_IMAGE=ghcr.io/zozo123/agentbox-islo-runtime:0.24.6
agentbox create --provider islo --no-vnc
```

Use AgentBox 0.24.6 or newer. It includes the cloud fixes for mount-safe `/workspace` seeding,
numeric-owner-safe tar extraction, and optional daemon spawn failures found during the islo live
test. Those same fixes reach this plugin through `@madarco/agentbox-provider-sdk` — which inlines
the cloud lifecycle — so the SDK dependency must be `^2.1.0` or newer; an older SDK re-introduces
the `/workspace` seeding failure no matter which AgentBox CLI is installed. Until the slim image
grows a VNC stack that remains below islo's image cap, `--no-vnc` is required.

Custom images must include a `vscode` user (uid 1000) with passwordless sudo, Node, git, tmux,
curl, CA certificates, procps, OpenSSH client, rsync, and `agentbox-ctl`. Keep the compressed image
comfortably below 1 GB. Native `agentbox prepare --provider islo` remains a follow-up; `ISLO_IMAGE`
is the explicit base-image selection today.

## Platform behavior

- A recently deleted sandbox name can remain reserved while `get` and `list` already report it
  absent. The plugin turns islo's generic create-time 503 into guidance to choose a fresh name or
  wait; the same error also calls out an unavailable or oversized custom image.
- A workload-heavy paused sandbox can take 5–7 minutes to become resumable while archival state
  settles. The plugin retries this idempotent operation for roughly eight minutes before returning
  an actionable error.
- New public share URLs can return 404 for about 10 seconds while edge state propagates. AgentBox's
  poller absorbs this during service readiness.

## Develop

```bash
npm install        # runs `prepare` → builds dist via tsup
npm run check      # typecheck + unit tests + build

# Build the same slim image published by GitHub Actions
docker build -f runtime/Dockerfile -t agentbox-islo-runtime:local .
```

## Support

Found a bug or have a question? Open an issue at
[github.com/zozo123/agentbox-provider-islo/issues](https://github.com/zozo123/agentbox-provider-islo/issues)
or email **support@incredibuild.com**.

## License

[MIT](./LICENSE)
