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

`agentbox plugin list` should then show `islo … (SDK v1)`.

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
| exec | `execInSandbox` + poll `getExecResult` (two-step async; only the start is retried) |
| upload / download / list files | compute `…/files` endpoint (multipart upload) + `ls -Ap` for listing |
| preview URL | `shares.createShare` (public HTTPS, reused per port) |

Verified end-to-end against the live islo API: provision, exec (stdout + exit codes), file
upload/download round-trip, `listFiles`, `previewUrl`, `pause`→`resume`, `list`, and `destroy`.

## Base image (`prepare`)

islo boxes boot from islo's default image or `ISLO_IMAGE`. Like every AgentBox **cloud**
provider, a full `agentbox create` needs the AgentBox runtime (`agentbox-ctl`, node, the agents)
present in the box — the built-in providers bake this via a `prepare` step. For v0 point
`ISLO_IMAGE` at an islo-hosted image that carries the runtime; native base-image baking
(`prepare`) and no-SSH `buildAttach` are planned follow-ups. The `CloudBackend` sandbox
lifecycle itself is complete.

## Develop

```bash
npm install        # runs `prepare` → builds dist via tsup
npm run typecheck
npm run build
```

## Support

Found a bug or have a question? Open an issue at
[github.com/zozo123/agentbox-provider-islo/issues](https://github.com/zozo123/agentbox-provider-islo/issues)
or email **support@incredibuild.com**.

## License

[MIT](./LICENSE)
