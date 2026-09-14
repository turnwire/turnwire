English · [中文](IMPLEMENTATION.zh.md)

# Turnwire implementation

> Historical scaffold and design background. The checklist and observations below describe the initial delivery, not current deployment status or test totals. Current boundaries are in [CLIENTS](CLIENTS.md), [PROTOCOL](PROTOCOL.md) and [maintenance guidance](FIRST-UPGRADE.md): XDG-only directory resolution, no old database migration, SDK `call` only, shared crypto/session code in `packages/wire`, and v2-only pairing. Historical continuity observations do not promise restoration of old data or uninterrupted upgrades.

## Goal

Build the Turnwire scaffold described in the original design conversation, using TypeScript as requested on 2026-09-09.

- `turnwire`: TypeScript monorepo with core, protocol, runtime interface, DSH adapter, SDK, daemon, CLI, Relay and phone PWA.
- `turnwire-desktop`: separate native Swift/SwiftUI macOS client, per the user's explicit clarification. TypeScript applies to the main monorepo only.
- One daemon owns sessions, runtime mappings, permissions and persistence. Clients share the same API and event stream.
- DSH is the first runtime, behind a capability-driven interface. Do not alter DSH's storage.
- Remote devices use an outbound connection through Relay; Relay does not run agents. Authenticate devices and encrypt remote application payloads.

## Delivery checklist

- [x] Strict TypeScript workspace, scripts and reproducible dependencies
- [x] Versioned validated protocol and runtime contract
- [x] Durable session/event/approval state with replay
- [x] DSH adapter grounded in official upstream source
- [x] Daemon, authenticated local API and streaming
- [x] CLI for session lifecycle, prompts, attach and approvals
- [x] Relay, pairing and reconnecting encrypted remote transport
- [x] Responsive React PWA with sessions, prompts and approval controls
- [x] Native Swift/SwiftUI client in sibling `turnwire-desktop`
- [x] Integration tests, builds, user documentation and visual verification
- [x] Native and CLI choice of managed temporary tunnel or self-hosted Relay, with live configuration, pairing QR and cleanup
- [x] Shared administration contract/SDK, provider injection, CLI/TUI command reuse and cross-client parity verification

- [x] Shared rename/archive/restore and transcript export, richer tool records, native workspace navigation, execution/result views and Markdown presentation

## Research

DSH source reference: `deepseek-ai/deepseek-harness` at `fb2c4b9e698e30edb738bca4cf0618587db7d203` (2026-09-09), version `0.1.5-rc.2`. Its API Gateway uses `POST /api/<namespace>/<method>` with a Connection `client-request` envelope containing `payload: { args }`. See `docs/DSH.md` for exact signatures and live verification.

## Progress

Both initially empty workspaces now contain runnable implementations. Node 22.22.1, npm workspaces, strict TypeScript, React/Vite and Swift 6 are used. Validation includes 31 TypeScript integration/contract tests, 11 Swift tests including live daemon and Relay configuration, a real interactive terminal workflow, desktop/mobile browser interaction checks and a live official DSH Host smoke test (auth, create, list, resume, follow). The native development `.app` was bundled, ad-hoc signed and reopened with the remote-control settings. The line-oriented TUI reuses the CLI command registry; shared services own behavior and persistent state. See `CLIENTS.md` for the capability matrix and code ownership.

DSH is running with the user's requested environment-variable configuration. Automated verification did not send a real model prompt. A temporary public tunnel has been provisioned and used to verify encrypted remote access to the existing DSH-backed session. Both managed temporary access and a fixed self-hosted endpoint are now configurable without restarting sessions. See `VALIDATION.md` for the public-network checks and their limits. No fixed server deployment, notarization or repository publication has been performed; additional runtime adapters and the other release extensions remain outside this delivery.
