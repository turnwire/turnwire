English · [中文](DEVELOPING.zh.md)

# Developing from source

For readers who want to change code, run tests or connect a real model. If you just want to install and use it, see the [README](../README.md).

## Environment and build

You need Node.js 22.13+ and npm. Clone the two repositories into the same parent directory, which makes it convenient to run the native client and do cross-repository verification:

```bash
git clone https://github.com/turnwire/turnwire.git
git clone https://github.com/turnwire/turnwire-desktop.git
cd turnwire
npm ci
npm run build
```

Verify the full multi-client workflow offline (no model credentials required):

```bash
TURNWIRE_RUNTIME=demo npm run dev
npm run turnwire -- connect
npm run turnwire -- new 'Check approval sync on this session' --runtime demo --title 'First handoff'
npm run turnwire -- ls
```

`npm run dev` runs the daemon, and `npm run dev:web` runs the Vite dev server separately. The production-built PWA is served same-origin by the daemon. The default state directory is `~/.turnwire`; use `TURNWIRE_HOME` to specify a separate directory. **Do not operate the same state directory with multiple daemons at once.**

## Connecting a real DSH

The adapter is implemented against official source version **0.1.5-rc.2**, using the official API Gateway and Remote mux without parsing terminal output. The pinned source revision is written in the [DSH runtime adapter](DSH.md) — read that contract before changing versions, since the interfaces of alpha and stable tags can differ.

```bash
# Terminal 1: make sure TURNWIRE_HARNESS_DEEPSEEK_API_KEY is exported (presence check only, no secret printed)
test -n "$TURNWIRE_HARNESS_DEEPSEEK_API_KEY" && npm run dev:dsh

# Terminal 2: copy the launch URL DSH prints, including ?token=...
TURNWIRE_DSH_URL='http://127.0.0.1:3080/?token=YOUR_DSH_LAUNCH_TOKEN' npm run dev

# Terminal 3
npm run turnwire -- status
npm run turnwire -- new 'Explain the structure of this project' --title 'Get to know the project'
```

`npm run dev:dsh` loads the [DeepSeek configuration](../config/dsh-deepseek.patch.yml), making the model and web search use the environment variable `TURNWIRE_HARNESS_DEEPSEEK_API_KEY`. The configuration only stores the variable name, and DSH reads the credential at request time; the secret must exist in the terminal environment that starts DSH, and setting it only in the daemon or desktop process will not pass it to an already-running DSH.

DSH runs independently and keeps its own data directory, model configuration and credentials. Turnwire does not read or modify DSH's internal persistence files. If an existing DSH `settings.yaml` explicitly sets `llm-deepseek.apiKeyEnv`, that user setting takes precedence, and the referenced name must be kept in sync as `TURNWIRE_HARNESS_DEEPSEEK_API_KEY`. `TURNWIRE_DSH_TOKEN` is a separate local connection token; a missing token, an incompatible version or an offline service produces a clear error rather than silently falling back to Demo.

For host and daemon deployment, persistent services and automatic updates, see [Developing Turnwire with Turnwire](SELF-HOSTING.md); for server-side deployment, see [Self-hosted Relay + PWA](DEPLOYMENT.md).

## Verification

```bash
npm run check   # strict TypeScript + integration tests + production build
```

A push runs exactly that. The browser scenarios below each boot a real Relay, daemon or DSH host and drive Chrome through one story, so they belong to the change that touches them rather than to every commit; run the one you need, or dispatch the `Scenarios` workflow from the Actions tab.

```bash
# Model picker against an isolated DSH host (needs Chrome and `npm ci --prefix config/dsh-runtime`):
bash scripts/ui-model-check.sh

# A real DSH turn, approval, queued prompt and dispatch record (needs the model credential):
node --import tsx scripts/dsh-live-check.mjs

# History paging and tab switching, each with its own isolated Relay, daemon and Chrome:
node --import tsx scripts/history-ui-check.mjs
node --import tsx scripts/remote-resilience-check.mjs

# A full UI pass needs an isolated Demo to talk to:
TURNWIRE_HOME=/tmp/turnwire-preview-state TURNWIRE_RUNTIME=demo npm run dev   # another terminal
TURNWIRE_HOME=/tmp/turnwire-preview-state node scripts/ui-check.mjs
```

Test coverage includes request deduplication, approval races, database recovery, event replay, local authentication, DNS rebinding protection, Relay revocation, ciphertext integrity, cross-device isolation, replay rejection, model catalog and selection validation (unregistered models are rejected), the DSH contract and the main UI flows. The script names, repository paths, CLI commands, DSH version and credential variable names in the docs are checked mechanically by `tests/docs.test.ts`, so stale statements fail CI directly.

The DSH contract fixtures verify the concrete protocol and cannot replace end-to-end verification with real models and engineering; "what has only been verified under specific conditions" is governed by the [Verification record](VALIDATION.md).

## Engineering structure

```text
apps/cli             terminal client
apps/daemon          turnwire-host, local authentication, event stream, Remote bridge
apps/relay           authentication, live connections, ciphertext forwarding
apps/deployer        generic server installer, SSH transport, release verification and rollback
apps/remote-web      React + Vite PWA
packages/protocol    versioned messages, types and runtime validation
packages/runtime     AgentRuntime interface and a clearly labelled Demo
packages/runtime-dsh official DSH HTTP / WebSocket adapter
packages/core        sessions, permissions, SQLite, events and request deduplication
packages/sdk         local / Remote clients, encryption, conversation model
```

Code ownership, how each capability is covered across clients, and "which layer a new behaviour belongs in" are covered by [Capability parity and code ownership](CLIENTS.md) and [Turnwire RPC v1 and remote transport v2](PROTOCOL.md).
