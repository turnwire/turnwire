English · [中文](README.zh.md)

# Turnwire

[![npm next](https://img.shields.io/npm/v/turnwire/next?label=npm%20next)](https://www.npmjs.com/package/turnwire/v/next)
[![npm latest](https://img.shields.io/npm/v/turnwire/latest?label=npm%20latest)](https://www.npmjs.com/package/turnwire/v/latest)

One agent session, continued across your desktop browser, terminal, and phone: **the host does the work, the phone lets you jump in and approve at any time.**

### How it fits together

![Turnwire architecture: local clients and the phone connect to one host, which stores shared state and runs tasks through DSH.](docs/architecture.svg)

- **Clients:** Use a desktop browser, CLI, interactive terminal (TUI), or phone PWA; an optional native desktop client is also available. Clients access the same host and session state. See [client capabilities and platform requirements](docs/CLIENTS.md).
- **Remote connection:** The phone reaches the host through a Relay or a configured tunnel. Paired session traffic is encrypted; the Relay forwards ciphertext.
- **Host and state:** `turnwire-host` runs Turnwire Core. SQLite stores metadata, cached events, approvals, and command receipts.
- **Task execution:** Turnwire Core delegates tasks through the `AgentRuntime` interface to DSH. Model credentials and task execution stay on the host.

## What it gives you

- **No disconnection when you leave the computer**: See the live progress of the same session on your phone and send your next idea back to the host; a message either queues until the current turn ends or steers it directly.
- **Approvals happen on your phone**: An operation that needs a green light pops up on your phone; a single approval or rejection covers it, and the outcome stays in the inbox for later review.
- **One shared state across clients**: Desktop, browser, terminal, and phone access share sessions, history, approvals, and model selection rather than keeping separate records. See [capability coverage](docs/CLIENTS.md) for client-specific gaps.
- **The host decides the models**: You can switch a session's model and reasoning effort from the phone too, and only models actually registered by the host runtime are listed.
- **It runs on your own machine**: Remote connections go through a temporary tunnel or a Relay you deploy yourself; the host dials out, so you never expose the daemon port to the public internet.

## Three things to look at before you start

Honest up front, so you do not discover them halfway through:

1. **The npm preview is published:** [`turnwire@next`](https://www.npmjs.com/package/turnwire) installs without repository access. It is not a stable release or a signed native desktop installer; source repositories remain private.
2. **You need an always-on host.** Choose a machine that meets the [host requirements](docs/QUICKSTART.md) — if it is asleep, the phone cannot connect. Host and optional native client platform support are separate; neither implies support for every operating system.
3. **You need model credentials, and they stay on the host only.** The API key is read by DSH on the host and does not enter a client, the Relay, or a tunnel process.

## Minimum deployment requirements

The smallest working deployment is **one execution host + Turnwire + DSH + model credentials**. Connect a browser or terminal to that host; Relay, containers and a native desktop application are not prerequisites.

| Requirement | What to prepare |
| --- | --- |
| Execution host | A machine that can keep the process running and meets the [current package/runtime requirements](docs/QUICKSTART.md); a browser client's platform is not the host requirement |
| Software | Node.js (minimum in the generated requirements below) and npm; first startup can guide DSH installation, or explicitly connect an existing instance |
| Network | npm registry access for initial acquisition and access to your configured model service for real tasks; local use needs no public ingress |
| Configuration and data | User-writable configuration, state, data and cache locations, plus the project workspace; model credentials remain on the host |
| Client | A working browser or terminal; the execution host must remain online for remote access |

No universal CPU, memory or disk minimum has been measured. Resource use depends on DSH, project size and concurrency; do not treat an invented hardware number as a guarantee. See [quickstart](docs/QUICKSTART.md) for persistence, ports and actual platform constraints.

## Choose a deployment method

All four methods use the same execution host; choose how clients reach it.

| Deployment method | What you need | How to use it |
| --- | --- | --- |
| Local | Execution host and local browser/terminal; no public endpoint | Run `npx turnwire@next --open` and use the authenticated local connection |
| Temporary tunnel | Execution host and an available tunnel provider | In remote-access settings choose localhost.run, cpolar or Cloudflare and enable temporary access; pair the remote client. Addresses can change, requiring re-pairing |
| Named tunnel | An existing Cloudflare tunnel, fixed public hostname and private tunnel credentials | Configure the tunnel name, hostname and credentials, enable it, then pair clients using the fixed address |
| Self-deployed Relay | Your own server, HTTPS address and Relay connection key | [Deploy Relay and PWA](docs/RELAY-INSTALL.md), configure the address/key on the host, then pair clients. Recommended for persistent remote access and required for push |

Relay and tunnels do not replace the execution host. npm/npx are installation choices; foreground/background execution and reusing DSH are runtime choices, not additional deployment methods. See [quickstart](docs/QUICKSTART.md) for host setup and detailed steps.

## Getting started

### Recommended: npm preview

<!-- BEGIN GENERATED INSTALL: scripts/sync-docs.mjs -->
Choose an execution host that meets the current package and runtime requirements, with **Node.js 22.13+** and npm. The published [npm preview](https://www.npmjs.com/package/turnwire) needs no repository access, source build or system-service setup:

```sh
npx turnwire@next
# Or install persistently:
npm install -g turnwire@next
turnwire --open
```

**Release channels:** pushes to `main` publish previews to npm `next`. Only an explicit stable GitHub Release publishes to npm `latest`; a `main` push does not promote a stable release. Use `turnwire@next` for the current preview rather than a pinned preview version. These are Turnwire channels, separate from the DSH runtime's channels.

The source repository remains private; npm installation does not require access. The preview is not a stable release or a signed native desktop installer. This entry point does not imply support for every operating system; package constraints and runtime requirements still apply.
<!-- END GENERATED INSTALL -->

Keep the terminal open: the preview runs in the foreground and installs no system service. Model credentials are prompted for privately and stay on the host. An explicitly configured existing DSH is reused; otherwise the launcher offers installation of npm `latest`, resolved to an exact version and validated in isolation. Local use needs no Relay; phone access is configured separately.

After stopping your own foreground instance, `turnwire start --update-dsh` stages and checks a managed DSH update before switching. It does not downgrade, hot-replace an active runtime, or update external DSH. Ordinary startup does not silently update existing installations.

See [quickstart](docs/QUICKSTART.md), [npm installation and release](docs/NPM.md), and [DSH compatibility and limits](docs/DSH-COMPATIBILITY.md). The runtime compatibility matrix tests configured host environments against baseline/latest/next; it is not a guarantee of compatibility with every future upstream change.

### Alternative: background host

For a host that runs in the background, see [service setup in the quickstart](docs/QUICKSTART.md). Check its platform requirements and safety boundaries before installing; phone access remains a separate explicit configuration step.

### Step 1: Get the host running

1. Run `node --version` and `npm --version` to check prerequisites, then `npx turnwire@next --open`.
2. Follow prompts to install missing DSH and privately enter model credentials. For existing DSH, configure the explicit connection first using [quickstart](docs/QUICKSTART.md).
3. Wait for startup. `--open` attempts to open authenticated local Web. If browser launch is unavailable, use `--no-open`, note the printed address, and run `npx turnwire@next connect` for local connection details. That output contains credentials: do not publish it.
4. In another terminal, run `npx turnwire@next status` to inspect the running host and runtime. `npx turnwire@next doctor --json` checks the environment offline; it is not a live health check.
5. In Web or the terminal, select a project workspace, create a session and send a task. Connecting to the host does not prove model credentials work; a real task validates model-service access.

If the default Web port is occupied, use `npx turnwire@next start --port 9900 --open`. Keep the host running. Ctrl-C stops its owned processes, never an external DSH.

Contributors with access to the private repository can follow [Developing from source](docs/DEVELOPING.md) to build, run an offline Demo, or connect a real model through DSH. The Demo needs no model credentials and does not call a model, run a shell, or modify files.

### Step 2: Install the clients you want

| What you want | How to install | What you need |
| --- | --- | --- |
| Desktop browser | Open the local address printed by the host launcher | A running host; see [quickstart](docs/QUICKSTART.md) |
| Native desktop client (optional) | See [client capabilities](docs/CLIENTS.md) and [source setup](docs/DEVELOPING.md) | Check the documented platform, build, and signing requirements |
| Background host | See [service setup](docs/QUICKSTART.md) | Check the documented platform and service requirements |
| Self-hosted Relay (stable long-term address) | `deploy/` contains a Dockerfile, compose.yaml, and Caddyfile | A server; see [One-click Relay deployment](docs/RELAY-INSTALL.md) |
| Terminal / scripts | `npm run turnwire -- ...`, or after building `node apps/cli/dist/main.js ...` | Node.js (minimum version above); for the commands see the [CLI reference](docs/CLI.md) |

### Step 3: Get your phone connected

The local address `127.0.0.1` refers only to that machine itself, and `127.0.0.1` on your phone is the phone itself — so a remote connection must have a public channel. Three options:

| Approach | How it works |
| --- | --- |
| Temporary tunnel | Choose localhost.run, cpolar, or Cloudflare and click "Enable temporary access"; you do not need a server of your own. cpolar requires an account Auth Token the first time. **The address changes the next time the daemon starts, so you have to pair again** |
| Cloudflare named tunnel | Use a tunnel and fixed domain that **already exist** under your own Cloudflare account, so the address does not change across restarts; you need the tunnel name, the public domain, and the tunnel credentials file |
| Self-hosted Relay | Fill in the server's HTTPS address and the Relay connection key and click "Save and connect"; recommended for long-term use, and also the prerequisite for phone push |

Once the channel is ready, generate a pairing QR code, then open the deployed PWA on your phone and paste the pairing code. The pairing link puts the key in the URL fragment, and the page removes it immediately after receiving it; by default it is kept only for the current browsing session, and only checking "Remember this trusted device" saves it persistently.

> Networks in mainland China may be unable to reach the Cloudflare temporary tunnel, or may see latency and instability — it is kept as a quick-try option. For long-term use, prefer a self-hosted Relay verified on the actual networks of your host and phone; a free Quick Tunnel is not the same as the Cloudflare China Network (that is a separately subscribed enterprise service).

## What you can do on your phone

- Continue the same session: watch live progress, send follow-up instructions, stop a running turn
- Handle approvals and the inbox: approve / reject, and review operations already handled or expired
- Switch a session's model and reasoning effort: the small chip above the input box, listing only models registered by the host runtime
- When sending while a session is running you can choose to **queue** (wait for the current turn to end) or **steer** (guide the current turn directly), and the message is marked with which one you used
- When a session is archived you can still view its history, and unarchive it to continue when you need to

## Known limitations

- **The host must be awake and online**: if the host is offline, the phone sees no progress.
- **Phone push requires a self-hosted Relay**: temporary addresses do not support long-term push (`turnwire notifications status` will tell you plainly).
- **Changing the address means pairing again**: a temporary tunnel changes its address on every restart.
- **The native app is ad-hoc signed**: suitable only for personal use or internal distribution.
- **Without model credentials you can only run the Demo**, and cannot perform real coding tasks.

## Going deeper

| Document | Contents |
| --- | --- |
| [CLI reference](docs/CLI.md) | Every `turnwire` command and option |
| [Developing from source](docs/DEVELOPING.md) | Building, connecting a real DSH, how to verify, project structure |
| [Capability parity across clients](docs/CLIENTS.md) | Each capability's coverage in each client and where the code belongs |
| [Self-hosted Relay + PWA](docs/DEPLOYMENT.md) | Fixed-domain deployment, notes on networks in mainland China |
| [One-click Relay deployment](docs/RELAY-INSTALL.md) | Install a server from the deployment form in one step |
| [Developing Turnwire with Turnwire](docs/SELF-HOSTING.md) | Development host auto-update and safety points |
| [DSH interface notes](docs/DSH.md) / [Protocol and state boundaries](docs/PROTOCOL.md) | Runtime contract and RPC boundaries |
| [Verification record](docs/VALIDATION.md) | Verified and unverified conditions, listed one by one |
| [Contributing](CONTRIBUTING.md) / [Security policy](SECURITY.md) | Development constraints, verification requirements, and vulnerability reporting channels |

## Current status and boundaries

The current delivery includes one-time pairing, per-connection ECDH session encryption authenticated by device credentials, staged connection recovery, a persistent approval inbox, Web Push, and a configurable TLS LAN listener. Start with a dedicated data directory and create client pairings from the host. Keep pairing credentials private. The Relay's connection routing is still in memory, while push keys and the delivery queue are persisted.

It does not yet include Codex / Claude adapters, team accounts, native iOS, auto-update, or release signing. "Which things were verified only under specific conditions" is governed by the [verification record](docs/VALIDATION.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE) for details. You may freely use, modify, and distribute it (including commercially), provided you keep the copyright and license notices; this project provides no warranty.
