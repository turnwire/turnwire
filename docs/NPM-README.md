English · [中文](NPM-README.zh.md)

# Turnwire

[![npm next](https://img.shields.io/npm/v/turnwire/next?label=npm%20next)](https://www.npmjs.com/package/turnwire/v/next)
[![npm latest](https://img.shields.io/npm/v/turnwire/latest?label=npm%20latest)](https://www.npmjs.com/package/turnwire/v/latest)

Self-hosted agent sessions across your terminal, browser and phone. The host runs tasks through DeepSeek Harness (DSH); model credentials stay on the host.

## Minimum setup and deployment choices

You need one execution host meeting the package/runtime requirements, Node.js and npm (minimum below), user-writable configuration/data/cache and project directories, registry access for installation, and model credentials plus model-service network access for real tasks. The browser device does not run DSH. No universal CPU, RAM or disk minimum has been measured; resource needs depend on your projects and concurrency. Local use needs no Relay, container or public endpoint.

Choose from these four deployment methods after preparing the execution host; local access remains available when remote access is enabled:

- **Local:** start the host with `npx turnwire@next --open` and open the printed address on the same computer. No domain, public IP, Relay or tunnel is required; keep the terminal running.
- **Temporary tunnel:** prepare the selected provider's tunnel tool and outbound connectivity. With the host running, use `npx turnwire@next remote` to select temporary access. The default Cloudflare quick tunnel needs no owned domain, but its address can change after restart; do not treat it as a persistent PWA entry point.
- **Named tunnel:** prepare an existing Cloudflare tunnel, a fixed hostname with DNS routed to it, `cloudflared`, and the tunnel credentials JSON on the execution host. In `npx turnwire@next remote`, select the named Cloudflare provider and supply that tunnel's name, hostname and credentials-file path. Turnwire does not create these resources. The hostname is stable; the execution host and tunnel process must remain online.
- **Self-deployed Relay:** prepare your own server meeting the [Relay deployment requirements](https://github.com/turnwire/turnwire/blob/main/docs/RELAY-INSTALL.md), a public domain or supported public IP, reachable TCP 80/443, outbound download access, SSH key/agent and administrator or passwordless sudo access. Run `npx turnwire@next deploy` on the running execution host and fill in the form. It deploys a persistent Relay and PWA at your own HTTPS endpoint. Preserve server configuration and push state, maintain certificate renewal, and keep the separate execution host online. A Relay forwards encrypted connections; it does not run agent tasks.

For any remote method, check `npx turnwire@next remote status`, then run `npx turnwire@next devices pair --name phone --qr`. Open the remote HTTPS Web endpoint and use the one-use invitation, never the host's local connection token. Protect invitation codes, QR images and tunnel/Relay credentials. Confirm an actual remote device connects; a successful deployment alone does not prove that device's network works.

### Host installation, runtime and development choices (not deployment modes)

Use npx for a foreground launch, or `npm install -g turnwire@next` followed by `turnwire --open` for a reusable command; global installation still does not install a background service. Configure an **external DSH runtime** as below if needed; Turnwire never stops or updates it. **Source background service** installation and **source Demo development/testing** procedures are in the repository [quickstart](https://github.com/turnwire/turnwire/blob/main/docs/QUICKSTART.md) (repository access required); the npm launcher does not install them.

## Install the preview

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

This is a preview, not a stable or signed native desktop release. No source checkout is required. npm installation does not start a service or install DSH. Running the launcher starts a foreground host: keep the terminal open, and use Ctrl-C to stop owned processes.

## Verify the first startup

Follow the launcher's DSH installation and hidden credential prompts. `--open` attempts to open authenticated local Web. On a host without browser launch, use `npx turnwire@next --no-open`, keep the process running and note the printed address. In another terminal run `npx turnwire@next status` for live status and `npx turnwire@next connect` for local connection details; the latter contains credentials and must not be shared. A remote browser's localhost is not the execution host: configure remote access rather than exposing the daemon port.

`npx turnwire@next doctor --json` is an offline environment check, not proof of a running host or valid model key. Create a session and send a task to verify real model access. If the Web port is occupied, restart with `npx turnwire@next start --port 9900 --open`. Ctrl-C stops only owned processes.

## Connect DSH

Explicitly configured external DSH is reused: supply `TURNWIRE_DSH_URL` and `TURNWIRE_DSH_TOKEN`, or an owned mode-0600 `dsh-connection.json` containing `url` and `token` in the Turnwire config directory. Turnwire never stops an external DSH.

Otherwise the launcher offers installation of registry `latest`, resolved to an exact version. It stages the runtime separately and probes it with an isolated HOME before selection. Model credentials come from a hidden prompt or `TURNWIRE_HARNESS_DEEPSEEK_API_KEY`; do not paste credentials into issues or chat.

## Useful commands

```sh
turnwire --help
turnwire doctor --json
turnwire start --no-open --port 9898
# Stop your own running instance first:
turnwire start --update-dsh
```

DSH updates are explicit: no automatic downgrade, hot replacement, or external/custom-entry updates. Failed staging preserves the old installation. The private `managed-dsh.json` selection is consumed by the npm launcher, not the source system-service installer. Ordinary startup does not silently upgrade existing DSH.

Local use requires no Relay. Phone access is a separate pairing and remote-connection setup; localhost on a phone refers to that phone. Prefer a self-hosted Relay for persistent remote access. Never expose the daemon port directly to the public internet.

## Compatibility and limits

Core authenticated DSH response shapes are validated; optional unsupported or unavailable observations remain unknown. The configured platform matrix against baseline/latest/next exercises real no-inference startup, catalog, empty sessions, restart and process ownership. It does not guarantee every future DSH change or validate all real model streaming, approvals, image inference and steering scenarios.

The source repository is currently private; installation from npm does not require repository access. Repository documentation links require access. This package includes this standalone guide and its Chinese translation.

- Package: https://www.npmjs.com/package/turnwire
- Source and issue tracker (access required): https://github.com/turnwire/turnwire

Apache-2.0. Bundled dependency notices are included under `licenses/`.
