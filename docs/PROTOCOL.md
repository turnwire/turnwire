English · [中文](PROTOCOL.zh.md)

# Turnwire RPC v1 and remote transport v2

`packages/protocol/src/index.ts` is the TypeScript source of truth. Swift's `Models.swift` independently decodes the same wire representation; desktop tests verify representative envelopes.

The local-only `/deployment` endpoint supports authenticated `GET` status and `POST` deployment configuration. Shapes are defined in `packages/protocol/src/deployment.ts`. POST immediately returns a job in `running` state; clients poll GET until `succeeded`, `failed` or `interrupted`. Configuration contains runtime SSH/address/installation settings, never raw private keys, login passwords or Relay credentials. The daemon persists the latest job and rejects concurrent starts. Remote RPC methods do not expose deployment administration. A completed server installation may still report a local connection error; its public URL and release remain available for recovery.

## Commands

Local clients POST `/rpc` with `Authorization: Bearer <local-token>`. Request:

```json
{"v":1,"id":"client-generated-uuid","method":"session.message","params":{"sessionId":"turnwire-session-id","text":"Continue the task"}}
```

Success: `{ "v": 1, "id": "...", "ok": true, "result": ... }`. Failure: `{ "v": 1, "id": "...", "ok": false, "error": { "code": "...", "message": "..." } }`.

Methods: `system.snapshot`, `session.create`, `session.resume`, `session.message`, `session.cancel`, `session.rename`, `session.archive`, `approval.decide`, `events.list`, `history.page`, `inbox.page`, `request.result`, `notifications.status`, `notifications.subscribe`, `notifications.unsubscribe`. Inputs are validated at the daemon boundary. Request IDs persist across restarts for mutations. An identical ID/payload returns the previous receipt. A changed payload conflicts. If the process died after reservation but before receipt persistence, Turnwire returns `OUTCOME_UNKNOWN` rather than replaying a potentially completed operation. This is an at-most-once submission boundary, not a claim of distributed exactly-once execution.

Session commands serialize per session; cancel remains independent so Stop cannot wait behind a slow prompt. Approval commands serialize per approval. Each successful decision applies once. Runtime disconnect and daemon restart cancel outstanding approvals.

`session.rename` accepts `{ sessionId, title }` (trimmed, 1–200 characters). `session.archive` accepts `{ sessionId, archived }`. Both emit `session.updated`; archive preserves history and rejects running sessions or pending approvals. An archived session must be restored before send/resume. The optional session `archived` field defaults to false for older records.

Tool events correlate by `callId`: `tool.started.detail` is input and `tool.finished.detail` is output. The optional `tool.finished.isError` preserves an explicit runtime failure flag; absent flags are unknown, not guaranteed success. Clients retain both input and output on replay.

## Events

Connect to local `/events` over WebSocket and send `{ "type": "auth", "token": "...", "after": 0 }` as the first frame. Tokens do not appear in the URL. Turnwire replays journal events strictly after the cursor, then sends `{ "type": "ready", "cursor": ... }` and continues live.

Each event is `{ "type": "event", "event": { "seq": 1, "time": "ISO-8601", "data": { "type": "session.created", ... } } }`. The journal sequence is global and monotonic per Turnwire state database. State updates and their events commit in one SQLite transaction. Client history retrieval is paginated through `events.list`; the client merges by sequence and projects assistant deltas/final replacements by message ID.

Snapshots contain `device`, `sessions`, `approvals`, `runtimes`, and `cursor`. Obtain the snapshot before subscribing from its cursor. Events replay through the same typed model for CLI, PWA and SwiftUI.

## Remote

The Relay authenticates a host using its deployment secret and a remote using its individual routing token. The host registers its allowed remote IDs and tokens after connecting. Pairing and revocation are available only through the authenticated **local** `/devices` API, not through remotely callable methods.

New pairings use v2; the existing RPC/event envelopes remain v1. Routing tokens are distinct from device authentication credentials and traffic keys. `/devices` POST creates a 15-minute, one-use invitation. Authenticated local PUT with `{id}` explicitly replaces an existing device's credentials and returns a new invitation. GET includes `protocol` and `enrollment` (`legacy`, `pending`, `enrolled`). Existing v1 devices remain supported without being silently upgraded or downgraded.

### Session handshake

`packages/sdk/src/session-crypto.ts` specifies the byte encoding: UTF-8 JSON arrays prefixed with `turnwire.session.v2`, fixed field ordering, hex credentials/MACs, base64 uncompressed P-256 public keys. Both peers generate fresh non-exportable ephemeral ECDH private keys per connection. The client hello contains a random 256-bit nonce, public key, and HMAC-SHA-256 proof over the context and client hello. The server verifies the paired device credential before allocating a session, creates its own fresh nonce/key pair, and authenticates the complete transcript including both roles' contributions and the selected credential index.

ECDH shared bytes feed HKDF-SHA-256. Its salt is a credential HMAC of the transcript; its info binds the transcript hash and traffic direction. Host and client derive independent non-exportable AES-256-GCM keys. Ephemeral handshake objects are released after derivation; JavaScript does not provide explicit CryptoKey destruction. Later disclosure of the persisted authentication credential does not by itself derive earlier ECDH traffic keys. There is no claim of post-compromise recovery or a per-message double ratchet.

Encrypted frames are `{v:2, session, sequence, ciphertext}`. `session` is the transcript SHA-256 hash. Each direction starts a separate uint64 counter at zero under its new key. Nonces are four zero bytes followed by the big-endian counter; AAD binds the session, sending role and decimal sequence. Receive requires the exact next sequence, verifies AEAD and the message schema, then advances. Reflection, replay, skipped sequence, altered ciphertext and old-session frames are rejected. Send/receive operations are serialized. Counter exhaustion closes the session for rekeying. `sentAt` remains metadata and is not a v2 security decision; devices may have different wall clocks.

For initial enrollment, the client durably saves a newly generated device credential alongside the invitation before consuming it. The encrypted `enroll` message installs that credential on the host; `enrolled` confirms it. The client then removes invitation material from its saved pairing. If the final acknowledgement is lost, the pre-persisted candidate can authenticate a new v2 handshake; the consumed QR alone cannot. Two hello MACs are allowed only to recover this enrollment boundary. A host checks its current credential when committing enrollment. CLI writes pairing files atomically with mode 0600; PWA stores in session storage unless the user chooses a trusted device / enables notifications.

V1 compatibility uses the previous independent device PSK, random 96-bit nonce and 60-second timestamp window. Only v2 pairings are eligible for direct routing. A v2 failure never falls back to v1; re-pair explicitly from the host. Upgrade the Relay before hosts: v2-aware host registration advertises `protocol:2`, and Relay binds forwarded payloads and close requests to a connection UUID so late replies cannot reach a replacement socket. Legacy hosts remain accepted by the updated Relay.

### Liveness and routing

Each candidate has independent transport, Relay-authentication, handshake and verification deadlines (default 5 seconds per stage). The SDK races authenticated enrolled-device LAN WSS candidates and Relay; only the verified winner dispatches commands or subscribes to history. Initial enrollment uses Relay to avoid competing enrollment attempts. Current direct candidates are refreshed inside E2EE `routes` messages, never inferred from a browser SSID.

A client sends encrypted `ping {nonce}`; the host returns `pong {nonce,challenge,hostId}`. The client verifies nonce/host/deadline, sends `ack {challenge}`, and in v2 waits for encrypted `confirmed {challenge}`. V1 retains its previous client-side completion point. Foreground heartbeat defaults to 15 seconds, probe deadline to 5 seconds. RTT uses a monotonic clock. Host presence expires after 25 seconds. Connected means a recently verified bidirectional path, not guaranteed future delivery.

Background PWA visibility/offline events suspend sockets and heartbeat. Foreground/pageshow/online/network-change hints trigger immediate reconnect without waiting for background backoff. Repeated connection failures use full-jitter exponential backoff, capped at 30 seconds; authentication failures require user action. One SDK owner schedules remote retries. UI health exposes route, protocol, stage, attempt, elapsed time, recent RTT and retry delay without secrets. History replay follows verification and can finish later.

RPC mutation receipts already persist independently of transport. `request.result {requestId}` returns `not_found`, `pending`, `unknown` or `completed` with the saved response. Losing a connection does not automatically resubmit commands. Event cursors recover missed events; they do not establish exactly-once execution.

The Relay cannot decrypt existing E2EE frames, but sees identifiers, routing tokens, connection metadata, sizes and timing. Serving PWA JavaScript is also a trust boundary: a compromised static origin can change endpoint code. Web Push adds subscription endpoint/key metadata and generic notification timing at the Relay; task text and approval details remain on the host and paired clients.

## Local trust

Remote mode management is also local-only: authenticated `GET /remote` returns `mode`, `state`, `message`, the active public URLs, the saved Relay server URL, `hasRelayToken` and provider `notices`; it never returns a host secret. Older daemons may omit notices. `PUT /remote` accepts `{ "mode": "off" }`, `{ "mode": "temporary" }`, or `{ "mode": "relay", "serverUrl": "https://turnwire.example.com", "token": "..." }`. Supplied tokens contain 32–500 characters, matching Relay authentication. The token may be omitted only when the exact normalized server URL already has a saved key. Mutation validation completes before the old transport is stopped. PUT returns the accepted starting state; callers poll GET until online or error.

These schemas live in `packages/protocol`. `LocalClient` exposes typed `remoteStatus`, `configureRemote`, `devices`, `pairDevice` and `revokeDevice` methods; `RemoteClient` exposes no administration methods. Native Swift uses matching wire models and live daemon contract tests. CLI and TUI use the same command registry and SDK calls.

Temporary configuration additionally accepts `provider: "localhost-run" | "cpolar" | "cloudflare"` and an optional `cpolarToken`. cpolar first use requires a Token (1–500 letters, digits, underscores, dots or hyphens); later requests can reuse the saved value. Supplying a cpolar Token for another provider is rejected before disconnecting. GET returns `provider`, `providers: [{ id, name, description, requiresToken }]` and `hasCpolarToken`, never the Token itself. Old saved temporary configurations retain Cloudflare as their provider. The cpolar subprocess reads a private 0600 per-run configuration file which is deleted when it exits; credentials are excluded from argv and provider environment.

The daemon serializes transport transitions, cancels pending starts, and owns the temporary Relay and provider process. Only public PWA assets and Relay forwarding are exposed through a temporary tunnel. The host connects to this Relay over loopback; paired phones use the public WSS endpoint. Startup waits for the provider's public address/registration, followed by host registration at the Relay. Public DNS propagation can take longer. Address changes update pairing endpoints and invalidate the displayed native QR. Switching modes does not restart Core or DSH. Persistent preferences override environment bootstrap defaults, including an explicit off choice. Pairing is available only after Relay registration completes; refreshing the device allowlist immediately marks the transport unready until re-registration.

Daemon binds to `127.0.0.1`. Host-header and origin checks protect its browser surface. Only configured development origins are permitted cross-origin; the default permits the loopback Vite origin. RPC and device management require a random local bearer token, persisted with owner-only file permissions. PWA assets are public but contain no connection secrets. Service worker caches static shell/assets only, not RPC responses, session history or credentials.

The local token and every paired device have full control over Turnwire's configured workspaces. Pairing does not bypass runtime tool approval. Production access should use WSS and a secured static origin, with the sample deployment keeping relay ports internal to Docker.

## Paged history

`history.page {sessionId, before?, limit?}` reads complete projected history records from Core. `limit` is 1–100, default 40; `before` is an exclusive positive original record sequence. The response `{events, cursor, hasMore, nextBefore}` contains compact message events, complete tool start/result pairs, approvals and errors. `nextBefore` is null at the oldest page. The cursor is the journal watermark at page capture, not the oldest record. `originSeq` is optional on events and preserves a compacted message's original position; `seq` is its latest included version. Raw event subscriptions and `events.list` keep their original meaning.

Encrypted `subscribe` accepts a numeric `after` or `"latest"`. The latter starts at the current journal cursor, avoiding historical replay for a connection health check or snapshot request. An explicit event listener subscribes from the snapshot cursor to cover concurrent changes. Clients must not apply metadata events at or below their snapshot cursor to current state. Page fetches and live events are reconciled using the page watermark, with deltas after the watermark applied once.

## Background agents

`subagent.list {sessionId}` returns `{subagents: SubagentView[]}` — the agents a session has delegated to, direct children first and nested ones after them. A delegation tool returns as soon as it hands work to a child, so the parent's own transcript cannot show what the child is doing; this is that view. Each entry is `{id, parentId, depth, label, mode, activity, elapsedMs?, todos}`: `label` is the short description the delegation carried, `activity` is the runtime's live read of whether the child still works, `elapsedMs` is its running (or final) duration, and `todos` is the child's own plan when it keeps one. It is a read, not a mutation: it reserves no request ID, and clients poll it the way they poll `system.snapshot`. A runtime that cannot enumerate agents reports an empty list rather than an error, so a client renders nothing instead of failing.

## Inbox and Web Push

`inbox.page {status?:"pending"|"all", before?, limit?}` returns `{items:[{position,approval,sessionTitle}],nextBefore,cursor}`. Positions are stable across resolution, pages default to 40 items. The authoritative inbox is persisted alongside approvals in the Core transaction. Resolved and cancelled items remain readable; daemon restart cancels pending live-runtime approvals rather than reviving them.

`notifications.status` exposes availability and this authenticated client's subscription state. Subscribe/unsubscribe use the remote identity supplied by the transport, not a caller-provided device ID. Local `/notifications` GET/PUT controls host-wide delivery. Global settings, private subscriptions and a journal-cursor-driven outbox live on the daemon. Relay persists VAPID keys, subscriptions and a deduplicated delivery queue in a private SQLite file. Only authenticated hosts may issue push-control frames for devices in their current allowlist; provider endpoints are restricted to supported HTTPS services. Expired subscriptions are removed; transient delivery failures retry within the queue TTL.

Push content is always a generic inbox hint, with no command, title, approval ID, code or tool arguments. The service worker displays a notification and opens/focuses the inbox; it never decides approvals. Browser permission is requested from a user gesture. iOS home-screen installation is required. Web Push depends on a stable origin and an awake host for new work; it does not promise background WebSocket execution or wake a sleeping computer.

## Isolated LAN listener

Authenticated local `/direct` GET/PUT configures a separate HTTPS/WSS server, trusted certificate/private-key paths, advertised URL, bind address and port. Configuration is runtime input. Network interface addresses are candidates for the host form only; they are not proof of reachability. The URL must use WSS and match the configured certificate. DNS resolution, browser CA trust and local-network permission must also work on the phone. No insecure `ws://` fallback or certificate verification bypass exists in product code.

The direct listener accepts paired v2 E2EE traffic only, checks browser origins, and returns 404 for HTTP management routes. Loopback admin/DSH ports remain separate. Remote off also disables the direct listener; direct preference remains saved for the next enable. Certificates are loaded when the listener starts; after replacing certificate files, reapply the configuration to reload. Automatic LAN certificate issuance is not included.
