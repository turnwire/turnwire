English · [中文](DSH.zh.md)

# DSH runtime adapter

Target: `@deepseek-ai/dsh@0.1.5-rc.1`, source revision `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`. That is what npm's `latest` tag resolves to, and the release notes of the alpha this replaced (`0.1.5-alpha.1`) are the delta the adapter was re-checked across. All DSH-specific names live in `packages/runtime-dsh`.

## Verified source contracts

1. Launch URL authentication: `GET /?token=...` returns **303** and an authority-bound cookie. HTTP API requests and the WebSocket handshake reuse that cookie. See [BrowserAuth](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/client/connection/src/browser-auth.ts).
2. Unary RPC: `POST /api/<namespace>/<method>` carries the full Connection envelope `{ "type": "client-request", "rpcId": "...", "method": "namespace/method", "payload": { "args": { ...namedArguments } } }`. The response is `{ "type": "server-response", "rpcId": "...", "result": { "ok": true, "value": ... } }`, or a failed result with `error`. The adapter verifies correlation. See [Connection RPC Host](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/client/connection/src/rpc-host.ts) and [Gateway](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/api/gateway/src/index.ts).
3. `session/list` expects `_request`, while `session/create`, `session/prompt`, `session/cancel`, `session/page` and `session/follow` expect `request`. Reusing `session/create` with an existing ID adopts that session **only while no other client holds its single write handle**: a session already open elsewhere (the DSH Web UI, for example) refuses adoption with `SessionAlreadyOwnedError`. `session/list` reads stored rows without resuming an Agent and `session/prompt` attaches one on demand, so the adapter resumes an existing session by following it instead of claiming it again. Prompts include `requestId`, `sessionId`, `mode: "queue"` and text content parts. See [Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/api/session-controller/src/index.ts) and [wire types](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/api/session-controller/src/types.ts).
4. Streams multiplex on `/api/remote.mux`. Client sends `open` / `cancel`; Host sends `item` / `end` / `error`, correlated by `streamId`. `$events` opens the forwarded Host event stream; its `ready` frame supplies the generation's `clientId`. See [stream protocol](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/api/gateway/src/stream-protocol.ts).
5. Approvals arrive as `waterfall` frames for `approval/request`. Turnwire claims only sessions it owns, delegates unrelated events, and replies through `$events/result` with `allowed-once` or `rejected`. A generation loss expires pending requests. Since 0.1.5-rc.1 a sandbox policy sits in front of that: the `web` profile boots `sandbox-policy` with `mode: $DSH_PERMISSION_MODE ?? 'workspace-write'` and `workspaceRoot: process.cwd()`, and `user-approval` with `policy: 'ask'` unless the mode is `danger-full-access`. Commands that stay inside the session's workspace or the system temp directory run without asking; anything else raises the approval above. `danger-full-access` turns the whole gate off, and `dsh-permission-presets` names the three modes (`read-only`, `workspace-write`, `danger-full-access`). See [client Remote events](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/api/gateway/src/client/remote-events.ts).
6. `api-session/status` carries a **boolean**. Durable events carry `seq`, `time`, `type`, `data`. Assistant transient chunks use `text-delta`; persisted attempts can contain compact `text-chunks` records. Turnwire skips reasoning text. See [session event vocabulary](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/core/session/src/types.ts) and [assistant stream encoding](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/llm/llm/src/assistant-stream.ts).
7. Model selection is two `session` methods plus a durable session event. `session/modelCatalog` takes **no arguments** and returns the whole catalog; `session/selectModel` takes `{ request: { sessionId, provider, model, reasoningEffort? } }` and returns the **Host-resolved** selection. The Host records the choice as a `model/selection` session event and folds it into `{ lastUsed, pending }`, so a switch during a running turn is snapshotted at prompt assembly and takes effect on a later step rather than splitting one step across two models. See [Host declarations](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/api/session-controller/src/index.ts) (methods at `sessionController` lines 249 and 258).

The gateway overview document was less current than the implementation concerning stream support and omitted the Connection HTTP envelope. A live smoke test against the published alpha caught this distinction; the adapter and contract fixture use the actual carrier envelope.

## Ownership and recovery

- Turnwire generates its own session ID and persists the returned DSH ID separately.
- DSH owns its runtime, tools, session log, provider configuration and credentials.
- Turnwire stores projected events for client replay, its metadata and the durable upstream cursor. It does not read or mutate DSH storage files.
- Reconnect opens a fresh follow snapshot, pages older missed records as needed, and skips events at or before its stored upstream cursor.
- Assistant final text replaces the current presentation message. Transient stream baselines repair partially streamed text after reconnection.
- Approval requests are live correlation handles, not durable permission grants. Startup invalidates previously pending approvals; only a fresh active request can be decided.
- The initial capability set exposes basic prompts, stream, resume, tools and approvals. The model catalog and per-session model selection are verified against the pinned Host but not yet exposed by `AgentRuntime`; until they are, a session runs on the Host's `agent-default-model`. Structured diff presentation, file browsing, jobs UI, images, tool question forms and command catalogs are not yet exposed.

Contract fixtures under `tests/dsh.test.ts` reproduce these exact signatures, including cancellation before the approval RPC completes. A real model task still requires a configured DSH provider. Never put API keys, DSH launch tokens or pairing codes in tracked files.

## Model selection contract

`session/modelCatalog` with empty arguments, measured against the pinned Host on 2026-09-10:

```json
{
  "default": { "provider": "deepseek-official", "model": "deepseek-v4-flash" },
  "routableProviders": ["deepseek-official"],
  "failures": [],
  "groups": [{
    "id": "deepseek-official",
    "name": "DeepSeek",
    "models": [{
      "id": "deepseek-v4-flash",
      "name": "DeepSeek-V4-Flash",
      "description": "Fast, efficient, and economical; …",
      "reasoning": { "efforts": [{ "id": "off" }, { "id": "low" }, { "id": "high" }, { "id": "max" }], "defaultEffort": "high" }
    }]
  }]
}
```

Facts the shapes alone do not show:

- The registered provider route is `deepseek-official`, **not** `deepseek`. Clients must select from the catalog rather than construct provider ids.
- Catalog discovery works **without** a resolved model credential: the three DeepSeek models and their reasoning efforts are listed even with no key in the environment. A missing credential therefore shows up when a prompt runs, not when the catalog is read.
- `reasoning` carries `efforts` and `defaultEffort`. Selecting without `reasoningEffort` returns the resolved effort: `{"selected":{"provider":"deepseek-official","model":"deepseek-v4-flash","reasoningEffort":"high"}}`. Clients should render the returned selection rather than assume the requested one.
- An unknown route fails with code **`session/model-unavailable`**, message `no adapter registered for provider "…"`, and `details: { provider, model }`. This is a per-request error, not a session failure.
- `session/create` returns `{ "sessionId", "agentPreset": "standard" }`; `agentPreset` is additional state Turnwire does not model yet.

`scripts/dsh-model-probe.mjs` reproduces all of the above against an isolated Host (separate `DSH_HOME`, no prompt, no model call) and is the reference for re-verifying after a DSH upgrade. `scripts/dsh-live-check.mjs` goes one step further and needs the credential: it runs a real turn, raises and answers a real approval, queues a second prompt behind it and checks both the runtime's queue projection and the host's record of when that prompt started.

## DeepSeek environment credential

Start the Host with `npm run dev:dsh`. Since 0.1.5-rc.1 the profile launcher owns `--patch`, so the overlay comes before the profile name: `dsh --patch config/dsh-deepseek.patch.yml --profile web --no-open`. It sets the official `llm-deepseek` and `web-search-deepseek` providers' `apiKeyEnv` to **`TURNWIRE_HARNESS_DEEPSEEK_API_KEY`**. This is a credential reference, not an interpolated secret. Export that variable in the Host's environment before starting it. The key is not a Turnwire daemon/client authentication token.

A route that the installed catalog does not describe must list its models: `resolveRouteModels` refuses one with an empty list ("the installed catalog does not describe this route, so its models must be listed in configuration"), and the plugin's discovery API — which does ask `GET {baseURL}/models` — only feeds its Models page for adoption, storing nothing. The list therefore lives in the overlay, but the endpoint stays the authority for which ids exist: `scripts/dsh-model-sync.mjs` reads each OpenAI-shaped route's own `/v1/models` and rewrites exactly that answer, keeping hand-written display names and leaving a route alone when its endpoint cannot be asked. The host reload runs it before restarting the Host, and `--check` reports drift without writing. DSH resolves the credential per request; inherited environment takes precedence over its managed credential sources. Existing `llm-deepseek` user settings can override the composition's `apiKeyEnv`, so deployments with an explicit saved reference must update that reference as well. Turnwire's launcher does not rewrite those settings. See the official [DeepSeek adapter](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/llm/llm-deepseek/README.md).

## Live verification, 2026-09-09

Installed official `@deepseek-ai/dsh@0.1.5-alpha.1` into a temporary prefix, started it with a separate `DSH_HOME`, disabled telemetry, and used the adapter against its loopback Host. Authentication, empty-session creation, session listing, idempotent resume and follow-stream opening were exercised. No prompt or model call was sent. The live check revealed the missing HTTP Connection envelope, which was corrected in both implementation and fixture.

Re-verified 2026-09-10 with `scripts/dsh-model-probe.mjs` against the same pinned revision: authentication, `session/modelCatalog`, `session/create` and both the success and failure paths of `session/selectModel`. The declarations in `typert.host.js` supplied the method names and argument names; the live Host supplied the provider route, the resolved `reasoningEffort`, the `agentPreset` field and the `session/model-unavailable` error shape, none of which are visible in the type declarations. No prompt was sent and no model was called.
