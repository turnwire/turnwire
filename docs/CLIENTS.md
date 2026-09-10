English · [中文](CLIENTS.zh.md)

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
| Create a session in a workspace | `dirs`, then `new --cwd --runtime` | Same commands | New session / folder picker |
| Steer the running turn or queue behind it | `send --steer` (queue is the default) | Same command | Composer toggle while a turn runs |
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
| Watch the background agents a session is running | `agents <session>` | Same command | Not yet — see the note below |
| Change a prompt that is still waiting (rewrite, take back, jump the queue) | `queue <session>`, `queue edit/remove/steer` | Same commands | Not yet — see the note below |
| Delegate a session's approvals (`approve for me`) | `approve-for-me <session> [--off]` | Same command | Not yet — see the note below |
| Answer a question the agent is waiting on | `questions`, `answer <question> 'label' [--text …]` | Same commands | Not yet — see the note below |

Host administration uses authenticated local `/remote` and `/devices`. A paired phone or remote CLI can operate sessions and approvals, but cannot change host settings or pair additional devices. This is a connection-permission boundary enforced by the daemon, not a missing UI feature. PWA currently serves this paired-phone role.

The background-agent view (`subagent.list`), the three controls a waiting prompt owns, delegated approvals (`session.autoApprove`) and answering the agent's questions (`question.answer`) are in the PWA and the CLI/TUI. The desktop equivalents are still to come, so those cells are real gaps rather than platform differences. A delegated session is also the one place where no person reads an approval before it is granted — and a question is never delegated, because it has no safe default. A question is rendered where the agent asked it, as part of the conversation rather than as a control somewhere else on the page: a single-choice question is answered by the tap itself, a multi-choice one collects its picks and sends them together, and the card then stays in the transcript as the record of what was asked and what was chosen — which is also what the exported transcript and `turnwire history` print.

The two folder pickers are not the same thing. The phone walks the host's own folders through `workspace.list`, which is the only picker that means anything over a remote connection, and `turnwire dirs` gives the terminal the same list. The desktop's panel chooses a folder on the Mac, so it matches the host only when the desktop is talking to a local daemon; a remote desktop connection still needs a typed path.

Deployment uses the same local permission boundary through `/deployment`. Clients submit runtime configuration and display shared asynchronous status; they never run SSH or install services themselves. The daemon owns the job, persists private configuration, strips model credentials from child processes, and connects to the installed Relay through `RemoteController`. Server addresses, login accounts and key paths are required runtime input. Optional advanced settings are available through the shared JSON configuration in every client and native advanced fields. Closing a client leaves the job running; daemon interruption is explicitly reported for recovery.

## Change acceptance

Rename and archive are protocol commands backed by Core metadata and journal events. Archiving retains history, rejects active sessions/pending approvals, and blocks resume/send until restored. Local and encrypted clients see changes through the same event stream. Native Markdown rendering, per-session drafts, result view, content search and approval center are presentation over shared records. The shared projection drops an assistant message that carries no text, so a turn made only of tool calls shows its tool blocks instead of an empty bubble in every client. A prompt sent while a turn is running is queued behind it by default and can instead steer that turn when the client asks for it (`mode: steer`); the recorded message carries `queued` or `steer` while it waits, and the host records the moment a waiting prompt actually starts, so every client can both label it and place it in the turn that ran it. Only `stop` cancels the turn, and it never injects text. A prompt that is still waiting sits above the composer with its own edit, cancel and jump-the-queue controls on that row and nowhere else; the row is the prompt plus those three buttons, so the buttons keep their size, the text is cut to one ellipsised line, and the full text stays on the row for hover or long press. Those controls belong to a prompt that can still be taken back: once the runtime starts it, the row moves into the turn that ran it and cancelling answers that it has already started, rather than erasing a message the model is answering. A long waiting prompt must never widen its box: a box that can be panned sideways is how that failure reads on a phone, and the same holds for the running-agent strip's labels.

The phone/PWA renders assistant event text as CommonMark + GFM (headings, lists, quotes, inline/fenced code, tables, task lists, links and footnotes). Code and wide tables scroll within their own regions; code can be copied. Incomplete streamed fences render as code and update when completed. This renderer belongs to the web presentation layer: it does not change event text, CLI history/export, native rendering or shared session rules. User input and raw tool results retain their literal representation. Raw HTML remains inert and image references appear as explicit links under the existing image policy. The native app already has its own Markdown presentation; the terminal can retain source formatting. The PWA also chooses the session model and reasoning effort, behind a chip in the composer that opens its options against itself rather than in the session heading or as a block above the composer: a phone opens a conversation pinned to the newest message, so a control inside the scrollable region is off-screen exactly where it is needed, a permanently expanded row would cost the composer the height the keyboard needs, and a panel that pushes the input down moves it out from under the finger that is about to type. The panel closes on a tap outside it or Esc. Tool calls follow the same rule: a closed row carries the call's own action — the command it runs, the file it touches, the task it delegates — cut with an ellipsis and available in full on hover or long press, so nobody opens a call just to find out what it was. A run of consecutive calls is one line while it is in flight, showing the newest call, and becomes the run's summary ("shell ×3 · All returned") once the last one returns. Opening a run does not draw a box inside a box: the calls indent under a hairline, and the only box is the individual call someone actually opened. A finished turn is shown as its result: once the turn is over, the steps that produced it — the intermediate notes and every tool run — fold into one `Process · N steps` line above the answer, one click away. A turn that is still running stays open step by step, and a turn that failed keeps its steps visible instead of hiding the failure inside the fold.

Start a behavioral feature at its owning shared layer, then expose it through all applicable clients. Check that a command from one client is visible from another without a client-specific restart or database. Use meaningful integration coverage for validation, authorization and lifecycle effects. Swift live tests provide cross-language contract checks. UI-only conveniences can stay native to their platform.

Provider availability must not be confused with host registration. A live Relay connection does not establish that every phone network can resolve and reach its public origin. Cloudflare Quick Tunnel is optional development access; use the deployment guide when selecting a fixed Relay for Mainland China.

The phone always shows a connection state, including on narrow screens: a bar while the link is connecting, unverified or broken — the states that need explaining — and a single thin line once it is verified, carrying the host, the round trip and, on a click, a fresh verification. A failure the link has since answered clears itself when the connection verifies again; a failure that is an answer to what the reader did stays until it is dismissed or superseded. `RemoteClient` publishes health only after an encrypted nonce round trip with the expected Mac. It probes every 15 seconds while the page is open, times out after 5 seconds, and on return to the foreground confirms and reuses the socket it still holds rather than rebuilding it — only a socket that is genuinely gone is rebuilt, so tab switching is not a reconnect. V2 additionally waits for host confirmation of the final acknowledgement. The Mac requires an encrypted acknowledgement of its own fresh challenge before marking a device connected; its positive state expires after 25 seconds without another acknowledgement. Relay readiness and saved pairing credentials alone cannot produce a positive connection state. These are recent observations, not a guarantee of future connectivity or background iOS execution.

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
