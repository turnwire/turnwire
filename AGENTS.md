# Turnwire engineering constraints

- CLI, interactive terminal/TUI and native desktop must expose the same product capabilities under the same connection permissions. A feature is not complete when it exists in only one client. Platform presentation (file pickers, clipboard, terminal rendering) may differ.
- Define public commands, administration requests and state shapes in `packages/protocol`. Keep session/domain rules in `packages/core`; keep host services, transport lifecycle and configuration persistence in the daemon. Clients must not create independent business state or spawn tunnel services.
- Put provider-specific integration under `apps/daemon/src/providers`, behind a host-side interface. Wire the provider in `main.ts`. Cloudflare is an optional temporary-access provider, never a requirement for Relay or local operation.
- TypeScript clients use `packages/sdk`. CLI and TUI reuse `apps/cli/src/program.ts`; do not add a second command dispatcher or bypass the SDK. Native Swift uses the same wire contract, verified against a live isolated daemon.
- Keep administration local-only across every client. Capability parity does not grant paired remote devices additional host-management permissions.
- For behavior changes, verify cross-client effects on the same isolated session/state. Update `docs/CLIENTS.md` when capabilities change. Report actual test coverage and unverified network conditions precisely.
- DSH reads `NOVE_HARNESS_DEEPSEEK_API_KEY` (NOVE). Do not copy model credentials into clients, Relay, tunnel processes, logs or source files.
