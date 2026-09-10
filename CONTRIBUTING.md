English · [中文](CONTRIBUTING.zh.md)

# Contributing

For people who want to change this repository. If you only want to install and use it, see [README](README.md); if you want to get it running first, see [Developing from source](docs/DEVELOPING.md#connecting-a-real-dsh).

## Read these two first

- [AGENTS.md](AGENTS.md) — engineering constraints: code ownership, capability parity, and model and credential boundaries. It is also the rulebook automated agents read, so look at it before you start.
- [docs/CLIENTS.md](docs/CLIENTS.md) — each capability's coverage in each client, and "which layer new behavior belongs in".

## Development environment

Clone both repositories into the same parent directory (the native client and cross-repository verification both assume this layout):

```bash
git clone https://github.com/turnwire/turnwire.git
git clone https://github.com/turnwire/turnwire-desktop.git
cd turnwire && npm ci && npm run build
```

Connecting a real model needs DSH and credentials; for the steps see [Developing from source](docs/DEVELOPING.md#connecting-a-real-dsh); for offline development, `TURNWIRE_RUNTIME=demo npm run dev` is enough.

## Must pass before you commit

```bash
npm run check          # strict TypeScript + integration tests + production build
```

The native client lives in the sibling repository: `cd ../turnwire-desktop && swift test`; or run `node --import tsx scripts/native-live-check.mjs` inside `turnwire` to make the native tests hit an isolated service.

CI runs the same things and they **must be green**, in both repositories. Interaction changes such as JSX/CSS have additional browser checks (`scripts/ui-check.mjs`, `scripts/ui-model-check.mjs`, `scripts/history-ui-check.mjs`, `scripts/markdown-ui-check.mjs`), which are already wired into CI.

## Hard constraints

These are not style preferences; changes that violate them will be asked to redo:

1. **Capability parity**: a behavior that exists in only one client is not finished. Put shared rules in `packages/protocol` (contracts and validation), `packages/core` (sessions and permissions), and the daemon (host services and persistence); clients are responsible only for interaction and presentation. Platform differences (file pickers, clipboard, terminal rendering) may differ.
2. **Models are owned by the runtime**: no layer may add, hardcode, alias, or "guess" a model id. Clients display only what the runtime model catalog returns; a model the runtime has not registered must stay unselectable.
3. **Credential boundary**: `TURNWIRE_HARNESS_DEEPSEEK_API_KEY` is read only by DSH on the host. Do not copy it into clients, the Relay, tunnel processes, logs, or source files; `config/dsh.env.json` is an untracked private file, so do not commit it.
4. **Administration is local only**: do not grant host-management permissions to paired remote devices — capability parity does not mean a remote device may change host settings.
5. **Do not bypass the SDK**: TypeScript clients use `packages/sdk` uniformly; the CLI and TUI reuse `apps/cli/src/program.ts`, and do not add a second command dispatcher.
6. **Provider integration** goes in `apps/daemon/src/providers` behind a host-side interface and is wired in `main.ts`; Cloudflare is only an optional temporary-access provider, not a prerequisite for a Relay or for local operation.

## Change process

- One PR, one topic. A behavior change must state its **cross-client impact** and how you verified it.
- For behavior changes, also update [docs/CLIENTS.md](docs/CLIENTS.md). Script names, repository paths, CLI commands, the DSH version, and the credential variable name in the docs are mechanically checked by [tests/docs.test.ts](tests/docs.test.ts); when they go stale, CI fails outright.
- New behavior must come with tests: use integration tests for **effects** such as request deduplication, approval races, recovery, encryption, and the runtime contract; use browser check scripts for pure presentation.
- Report coverage precisely: separate what is genuinely end-to-end from what is only a contract fixture or a simulation, and do not blur the two.

## Commit messages

- Explain **why** you changed something, not just what; put the impact surface (which client, which boundary) in the body.
- Do not write any secrets, tokens, pairing credentials, or private paths into commit messages, code, or test fixtures.

## Security

If you find a security problem, do not open a public issue; use [SECURITY.md](SECURITY.md).
