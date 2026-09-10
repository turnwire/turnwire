# Capability parity and code ownership

CLI, the interactive terminal (`turnwire tui`) and the native desktop are clients of the same Turnwire host. With the same connection permissions, they must support the same product operations and observe the same state. UI mechanics may differ: a workspace path vs NSOpenPanel, a terminal QR vs NSImage, or a printed link vs a clipboard button.

## Where code belongs

| Layer | Responsibility | Location |
| --- | --- | --- |
| Shared protocol | Requests, results, validation, events and remote status | `packages/protocol` |
| Domain | Sessions, runtime routing, approvals, receipts and event persistence | `packages/core` |
| Host services | Remote mode state, saved settings, pairing and transport lifecycle | `apps/daemon` |
| Relay | Authenticated host/device routing, shared traffic bounds and public PWA serving | `apps/relay` |
| Server deployment | Portable installer, SSH transfer and file/configuration rollback | `apps/deployer`; daemon owns jobs and private state |
| Provider adapter | Component installation, provider networking, child process lifecycle | `apps/daemon/src/providers` |
| TypeScript client transport | Local RPC, typed administration and encrypted remote connection | `packages/sdk` |
| Terminal presentation | One command registry used by CLI and TUI, prompts and QR rendering | `apps/cli/src/program.ts`, `terminal.ts` |
| Native presentation | Swift wire models, API client, SwiftUI state and controls | sibling `turnwire-desktop` |

`RemoteController` receives the provider registry from the daemon entry point. localhost.run, cpolar and Cloudflare adapters own component installation and foreground process lifecycle. Self-hosted Relay has no tunnel dependency. Provider choices and guidance are returned with remote status and displayed by terminal and native clients. cpolar credentials remain in private daemon state; only `hasCpolarToken` is returned to clients.

The TUI currently provides a line-oriented interactive command interface, including interactive Relay settings. It reuses the entire CLI command registry; it is not a separate full-screen renderer. `attach` enters the shared session conversation; Ctrl+C returns to the command interface without stopping the Agent. Input is parsed into arguments without shell evaluation.

## Current capability coverage

| Capability | CLI | Interactive terminal | Native desktop |
| --- | --- | --- | --- |
| Host/runtime state and shared sessions | `status`, `ls` | Same commands | Sidebar and status |
| Create a session in a workspace | `new --cwd --runtime` | Same command | New session / folder picker |
| Send messages and follow history/events/tools | `send`, `attach` (recent 40 records) | Same commands | Conversation (recent 40 records) |
| Search / view archived sessions | `ls --search`, `--archived`, `--all` | Same commands | Workspace groups, search and archive filter |
| Rename / archive / restore | `rename`, `archive`, `unarchive` | Same commands | Session menu and context menu |
| Inspect tool input/output, failures and history | `history <id> --before <cursor> --limit <count>`, `attach`, `--json` | Same commands | Conversation / execution tabs; Load earlier records; expandable tool details |
| Export a transcript | `export --output` | Same command | Session menu → Export |
| Resume and cancel | `resume`, `stop` | Same commands | Resume / Stop |
| Choose the session model and reasoning effort | `models`, `model <session> <provider>/<model> [--effort]`, `new --model` | Same commands or model menu | Session model picker |
| Persistent approval inbox and resolved/expired history | `inbox`, `inbox --all --before` | Same commands | 收件箱 with pending/all filter and pagination |
| Query uncertain command outcome | `result <request-id>` | Same command | 收件箱 → 查询操作结果 |
| Configure LAN TLS bridge | `remote direct configure --config`, `status`, `off` | Same commands or form/menu | 远程控制 → 局域网直连 form |
| Configure host push delivery | `notifications on/off/status` | Same commands or form/menu | 远程控制 → 手机通知 |
| Upgrade pairing credentials | `devices upgrade <id> --qr` | Same command or menu | 已配对设备 → 重新配对 |
| Read and decide approvals | `approvals`, `approve`, `reject` | Same commands | Approval controls |
| Choose temporary or self-hosted remote access | `remote temporary`, `remote relay` | Same commands or `remote` menu | Remote control settings |
| Deploy / update a Relay server | `deploy --config`, `deploy --status` or interactive `deploy` | Same commands, form, or remote menu entry | Self-hosted Relay → Deploy/update server form and private JSON import |
| Choose localhost.run / cpolar / Cloudflare | `remote temporary --provider localhost-run` (or `cpolar`, `cloudflare`) | Same command or provider picker; masked cpolar Token | Tunnel service picker; secure cpolar Token field |
| Read progress / connection state | `remote status --watch` | Same command or menu refresh | Status polling |
| Disable remote access or cancel startup | `remote off` | Same command or menu | Disable remote access |
| Pair by link/code/QR | `devices pair --qr`, `--qr-file phone.png` | Same commands or menu | Pairing link / QR |
| List and revoke devices | `devices list`, `devices revoke` | Same commands or menu | Device list / Revoke |
| Verify paired device connection | `devices list --watch`; remote client `connection` | Same commands; devices menu shows last confirmation | Device state, last confirmation and latency, refreshed every 2 seconds |

Host administration uses authenticated local `/remote` and `/devices`. A paired phone or remote CLI can operate sessions and approvals, but cannot change host settings or pair additional devices. This is a connection-permission boundary enforced by the daemon, not a missing UI feature. PWA currently serves this paired-phone role.

Deployment uses the same local permission boundary through `/deployment`. Clients submit runtime configuration and display shared asynchronous status; they never run SSH or install services themselves. The daemon owns the job, persists private configuration, strips model credentials from child processes, and connects to the installed Relay through `RemoteController`. Server addresses, login accounts and key paths are required runtime input. Optional advanced settings are available through the shared JSON configuration in every client and native advanced fields. Closing a client leaves the job running; daemon interruption is explicitly reported for recovery.

## Change acceptance

Rename and archive are protocol commands backed by Core metadata and journal events. Archiving retains history, rejects active sessions/pending approvals, and blocks resume/send until restored. Local and encrypted clients see changes through the same event stream. Native Markdown rendering, per-session drafts, result view, content search and approval center are presentation over shared records. The shared projection drops an assistant message that carries no text, so a turn made only of tool calls shows its tool blocks instead of an empty bubble in every client. A prompt sent while a turn is running is queued behind it (`mode: queue`) instead of interrupting, and the recorded message carries `queued` so every client can label it; only `stop` interrupts, and it cancels the turn rather than injecting text.

The phone/PWA renders assistant event text as CommonMark + GFM (headings, lists, quotes, inline/fenced code, tables, task lists, links and footnotes). Code and wide tables scroll within their own regions; code can be copied. Incomplete streamed fences render as code and update when completed. This renderer belongs to the web presentation layer: it does not change event text, CLI history/export, native rendering or shared session rules. User input and raw tool results retain their literal representation. Raw HTML remains inert and image references appear as explicit links under the existing image policy. The native app already has its own Markdown presentation; the terminal can retain source formatting. The PWA also chooses the session model and reasoning effort, behind a chip in the composer that expands on demand rather than in the session heading: a phone opens a conversation pinned to the newest message, so a control inside the scrollable region is off-screen exactly where it is needed, and a permanently expanded row would cost the composer the height the keyboard needs.

Start a behavioral feature at its owning shared layer, then expose it through all applicable clients. Check that a command from one client is visible from another without a client-specific restart or database. Use meaningful integration coverage for validation, authorization and lifecycle effects. Swift live tests provide cross-language contract checks. UI-only conveniences can stay native to their platform.

Provider availability must not be confused with host registration. A live Relay connection does not establish that every phone network can resolve and reach its public origin. Cloudflare Quick Tunnel is optional development access; use the deployment guide when selecting a fixed Relay for Mainland China.

The phone always shows a connection bar, including on narrow screens. `RemoteClient` publishes health only after an encrypted nonce round trip with the expected Mac. It probes every 15 seconds while foregrounded, times out after 5 seconds, and rebuilds connections when the browser returns to the foreground. V2 additionally waits for host confirmation of the final acknowledgement. The Mac requires an encrypted acknowledgement of its own fresh challenge before marking a device connected; its positive state expires after 25 seconds without another acknowledgement. Relay readiness and saved pairing credentials alone cannot produce a positive connection state. These are recent observations, not a guarantee of future connectivity or background iOS execution.

Explicit event subscriptions from cursor zero can contain thousands of encrypted events. The Relay applies its message ingress rate limit to phones, while authenticated hosts may replay that history without triggering the phone limit. Frame-size and slow-consumer buffer bounds remain enforced for both roles. This is shared transport behavior for every remote client; no client-specific workaround or wire change is required. The regression exercises 4,000 real encrypted events, health confirmation and a following snapshot request, alongside an independent phone flood rejection check.

### On-demand conversation history

`history.page` is a shared read-only Core RPC used by SDK, CLI/TUI, Swift and the phone/PWA. It pages backwards by each record's first event sequence (exclusive `before`), defaults to 40 complete records, and returns `events`, `cursor`, `hasMore`, `nextBefore`. The store maintains a durable projection of messages, tool input/result pairs, approval request/resolution and errors alongside the unchanged raw journal. Existing databases backfill it transactionally once. Pages target at most 512 KiB (an individual record stays whole); raw `events.list` remains available for journal consumers.

Opening a conversation loads the recent page immediately, not thousands of token fragments from the beginning. Swift and web offer “加载更早记录”; CLI/TUI display the next `history --before` command. Search and displayed record counts cover loaded records. Full export is explicit and still visits every page (`export`, native “导出完整会话…”); `history --all` also reads all pages. Loading older pages preserves reading position.

Projected message events carry optional `originSeq` for their original display order and `seq` for their newest incorporated event. Clients reduce live events incrementally, batch visible updates every 50 ms, and cache the projected transcript. Page merges absorb events through the page cursor and replay newer in-flight events exactly once. History must not change live session/approval state: snapshots win over older metadata events. Swift reconnects from a fresh snapshot and recent page. Remote request-only connections use `subscribe {after:"latest"}` for prompt encrypted health verification; an explicit listener then replays from its requested cursor, including the snapshot/listener race window. Raw explicit subscriptions retain complete replay semantics.

Validation: `tests/history.test.ts` covers 4,000 deltas, complete tool pairs, backward cursor boundaries, concurrent updates, existing-journal migration, local/encrypted parity and snapshot non-regression. CLI/TUI parity tests exercise the same paging command. `scripts/native-live-check.mjs` seeds the same long-history shape for native paging/export/live-update checks. `scripts/history-ui-check.mjs` exercises encrypted browser paging, scroll anchoring, completion and reload at a 390 px viewport. Browser automation is not a physical iPhone/cellular network test.

A Linux installation can run the optional `turnwire-host.service` supervisor (`apps/daemon/src/host-service.ts`) and `bin/turnwire tui`. It launches the same daemon and DSH runtime; TUI remains a client, and SSH/TUI exit does not own host lifecycle. The generated service paths are derived from the installation directory. Each host retains its own private identity, state and remote pairings. No additional remote administration privileges are granted.

### Remote transport v2 and notifications

All TS clients share the SDK's staged connection state, jittered retry and session encryption. Native remains Swift/SwiftUI and uses the same local administration and Core RPCs. PWA adds browser-specific notification permission, Service Worker display, and visibility/online hints; its inbox and approval decisions use Core like CLI/TUI/native. Host-wide notification administration remains local-only. Remote users can subscribe/unsubscribe only their own device.

The local native connection does not independently implement browser or Relay lifecycle. Its remote settings expose direct listener configuration, notification availability/preferences, pairing upgrade and device protocol/enrollment status. Phone notification delivery is tested with a simulated provider; actual iPhone notification permission, lock-screen delivery and LAN certificate acceptance require device testing.
