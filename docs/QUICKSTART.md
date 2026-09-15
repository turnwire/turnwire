English · [中文](QUICKSTART.zh.md)

# Turnwire quickstart

## Choose the execution host first

The **execution host** runs Turnwire and DSH, accesses your project files and keeps credentials and session data. The **browser client** only connects to that host: it can be on the same computer or another device. A phone or a different browser operating system does not need Node, npm or a model key. Choose a host independently of the device you are reading this on.

**Compatibility note:** the current npm package permits **Linux and macOS** hosts; native Windows hosting is not currently claimed. DSH must also support the chosen host. The source systemd bootstrap below is Linux-only. These host constraints do not restrict the browser client to Linux/macOS. See [npm installation](NPM.md) and [DSH compatibility](DSH-COMPATIBILITY.md).

## Minimum requirements

| Requirement | What you need |
| --- | --- |
| Software | Node.js **22.13+** and npm on the execution host for the published package; no Git, source build or systemd required. Source methods additionally need Git and private repository access. |
| Host | An ordinary account that can run persistent foreground processes, write private directories and access the project folders the agent will use. Keep the host awake while working. No measured CPU, RAM or disk minimum is available; reserve space for packages, runtime, project files, logs, sessions and attachments. Performance has not been benchmarked. |
| Network | Outbound access to the npm registry/package downloads during installation and to the configured model provider during real-model use. External DSH additionally needs reachable authenticated HTTP/WebSocket endpoints (HTTPS off loopback). Local use needs no public IP, domain, inbound firewall opening, Relay or tunnel. |
| Credentials | For managed real DSH, a valid provider key read as `TURNWIRE_HARNESS_DEEPSEEK_API_KEY`; use the launcher's hidden prompt or private host configuration. An external DSH instead needs its connection token and already-configured provider credentials on the DSH host. Demo needs neither. |
| Persistent directories | Writable private config, state and runtime-data directories, plus writable download cache; keep config/state across restarts. Defaults are `~/.config/turnwire`, `~/.local/state/turnwire`, `~/.local/share/turnwire`, `~/.cache/turnwire`. Override independently with `TURNWIRE_CONFIG_HOME`, `TURNWIRE_STATE_HOME`, `TURNWIRE_DATA_HOME`, `TURNWIRE_CACHE_HOME`; see [directory rules](XDG.md). |
| Browser (optional) | A current browser for Web/PWA; no graphical desktop or browser is required on a headless execution host. CLI/TUI can be used without Web. |

Choose one deployment method below. Do not run multiple hosts against the same state or occupied ports. For a separate trial, isolate both config and state so it cannot overwrite the active local connection descriptor.

## Recommended: published npm preview (Linux / macOS)

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

Keep the terminal open: this starts a foreground host, not a background service. Ctrl-C stops processes it owns, not an external DSH. The package contains the host, CLI/TUI and Web; it is not a signed native Mac app. Local Web needs no Relay. Model credentials remain on the host and are requested privately; never send them to a phone or Relay.

An existing DSH is reused when explicitly configured with `TURNWIRE_DSH_URL` and `TURNWIRE_DSH_TOKEN`, or a private mode-0600 `dsh-connection.json` in the Turnwire config directory. The launcher does not scan other tools for secrets. Without an external connection it reuses an existing Turnwire-managed installation; if none exists, it offers installation of registry `latest`, resolved to an exact version, in an isolated version directory and validates it before selection. Failed authentication does not silently install a replacement.

Use `turnwire doctor --json` for an offline environment check. After stopping your own foreground instance, run `turnwire start --update-dsh` to explicitly stage and validate a managed runtime update. Failed validation preserves the old selection; there is no automatic downgrade, hot update, or update of external/custom DSH. Normal startup does not silently upgrade an existing runtime. See [npm installation](NPM.md), [DSH compatibility and limits](DSH-COMPATIBILITY.md), and [directory rules](XDG.md).

### Method 1: npx foreground (no global installation)

1. Check `node --version` (22.13 or newer) and `npm --version` on the host.
2. Run `npx turnwire@next doctor --json` for the offline preflight.
3. Run `npx turnwire@next --open`, approve managed DSH installation if offered, and enter the model key at the hidden prompt. `--yes` can approve installation but does not supply a missing key.
4. Keep that terminal running and follow the success checks below. Subsequent starts use the same command and private directories; npx is not a persistent service.

### Method 2: global foreground (reusable command)

```sh
npm install -g turnwire@next
turnwire doctor --json
turnwire --open
```

Use a user-writable npm prefix rather than running the host as root. Installation only adds the executable; each `turnwire --open` invocation runs in the foreground. Use `turnwire --no-open` on a headless host. For noninteractive startup, provision the key privately on the host first; disabling browser opening does not disable credential prompts.

### Method 3: reuse an authenticated external DSH

1. Start a compatible DSH independently with its provider credentials already configured. Obtain its authenticated endpoint and connection token privately; the DSH token is not the model API key.
2. In the resolved Turnwire config directory, create an owner-only regular file named `dsh-connection.json` with mode **0600** before inserting secrets. Use a private editor, not a shell command containing the token. The following is only a placeholder template, not a working credential:

```json
{
  "url": "http://127.0.0.1:3080/",
  "token": "REPLACE_PRIVATELY_WITH_DSH_CONNECTION_TOKEN"
}
```

3. Replace the example endpoint with the actual DSH endpoint. For a DSH on another host, HTTPS is required. Alternatively inject `TURNWIRE_DSH_URL` and `TURNWIRE_DSH_TOKEN` through your private environment/secret manager; environment configuration takes precedence over the file. Never paste real tokens into command arguments, shell history or public configuration.
4. Run `npx turnwire@next --open` or `turnwire --open`, then verify as below. Authentication failure stops startup rather than installing a replacement. Turnwire does not take ownership of this DSH, change its credentials, update it or stop it on Ctrl-C.

### Verify npm startup step by step

1. Read the printed Web address, normally **`http://127.0.0.1:9898`**. Use `--port PORT` to select another free Web port; occupied ports are refused, not cleared. `--open` tries to open authenticated local Web; `--no-open` suppresses that attempt.
2. In a second terminal under the same account and directory overrides, run `turnwire status` (or `npx turnwire@next status`). Check that the host responds and its runtime is ready. `doctor --json` is an offline environment check, not proof of a running host or successful model inference.
3. If the browser did not open, open the printed address **in a browser on the execution host**, run `turnwire connect` (or `npx turnwire@next connect`), and use its local connection details in Web. Treat connection output and authenticated URLs as secrets; never share them in screenshots, logs or issues.
4. Confirm Web connects, then use `turnwire models` to inspect the runtime-owned catalog and try a small task through Web or the [CLI](CLI.md). A catalog/status check alone does not prove provider authentication or inference works.

A headless host needs no screen: keep it running with `--no-open`, use CLI/TUI there, and configure the explicit remote route below for a browser elsewhere. `127.0.0.1` in your phone/laptop browser means that phone/laptop, not the remote execution host. A printed loopback URL or local bootstrap secret is not a remote pairing link; do not expose the daemon port or copy the local secret to a phone.

## Source demo: no model credentials

With private repository access and Node/npm installed, use a separate checkout/config/state from an active deployment. The environment assignment below is **POSIX-shell syntax** (for example Bash or zsh):

```sh
git clone https://github.com/turnwire/turnwire.git
cd turnwire
npm ci
npm run build
TURNWIRE_RUNTIME=demo npm run dev
```

Keep the daemon terminal open. In a second terminal with the same config/state overrides:

```sh
npm run turnwire -- status
npm run turnwire -- connect
npm run turnwire -- new 'Try the demo' --runtime demo --title 'First demo'
```

Open the daemon's printed local Web address (default port 9898) and use the private local connection details. Demo uses simulated responses, requires no DSH/model key and does not verify real inference. Downloads/build still need network access. See [source development](DEVELOPING.md) to connect real DSH; this source path is not the npm launcher and does not use its `doctor`/`--open` options.

## Advanced: source-based Linux service

The following alternative requires access to the private source repository. It installs a systemd user service rather than the npm foreground preview; do not run both against the same active state or ports.

## First run

Use a dedicated ordinary Linux account with a working systemd user manager. Obtain the repository using Git and enter its directory, then run:

```bash
git clone https://github.com/turnwire/turnwire.git
cd turnwire
bash scripts/start-host.sh
```

If Node/npm is already installed, `npm start` runs the same entry point. The Bash entry can prepare the pinned Node runtime itself. Download/build time depends on the network and CPU; this is one startup command, not a promise of instant installation or no prerequisites.

The script checks the environment, prepares Node and dependencies, builds the PWA/host, asks for the model credential without echoing it, and delegates persistent service installation to the existing Linux installer. The default managed host needs `TURNWIRE_HARNESS_DEEPSEEK_API_KEY`; this does not invent or register any models. Private configuration, state, runtimes and downloads use independent `TURNWIRE_CONFIG_HOME`, `TURNWIRE_STATE_HOME`, `TURNWIRE_DATA_HOME` and `TURNWIRE_CACHE_HOME` overrides. Without overrides, the corresponding absolute XDG base plus `/turnwire` is used; defaults are `~/.config/turnwire`, `~/.local/state/turnwire`, `~/.local/share/turnwire` and `~/.cache/turnwire`. `TURNWIRE_HOME` is removed and rejected. Old layouts are not auto-detected; the DSH environment file defaults only to `dsh.env.json` in the resolved config directory, unless explicitly set with `TURNWIRE_DSH_ENV_FILE`. Store rejects old databases with `UNSUPPORTED_STORAGE` and provides no migration; use separate empty state for the current format. See [XDG directory rules](XDG.md). Do not put keys in command-line arguments, public deployment files or screenshots.

Required system tools include Bash, a systemd user manager and the tools needed to download/extract the Node release. Root is not the intended execution account. Use a simple checkout path without spaces, matching the service installer's path requirements. macOS is not supported by this Linux bootstrap; use the native/source setup instructions instead.

## Subsequent runs

Run only one bootstrap invocation at a time; concurrent first-time builds are not serialized. Run the same command again after it finishes. A matching running service is left running; a matching stopped installation is started without rebuilding. The entry refuses a conflicting service belonging to another installation rather than overwriting or restarting it. This is not an upgrade command. Finish active tasks and follow the [maintenance guide](FIRST-UPGRADE.md) to replace an installation.

```bash
bash scripts/start-host.sh --check
systemctl --user status turnwire-host
journalctl --user -u turnwire-host -n 100
```

`--check` reports preflight conditions without installing or starting anything. Service activation is not proof that DSH and the provider are healthy: run `bin/turnwire status`, then `bin/turnwire connect` privately from the checkout and confirm Web connects using the printed local address. Check the runtime catalog and a small real task separately. The source CLI does not provide the npm launcher's offline `doctor` command. For unattended machines, user lingering may need administrator approval: `sudo loginctl enable-linger "$USER"`.

## Phone access is a separate explicit choice

After npm startup, keep the foreground terminal running and use a second terminal (for a global installation):

```bash
turnwire remote
turnwire devices pair --name phone --qr
```

For npx-only use, prefix the same commands with `npx turnwire@next`. For the source-based service, use `bin/turnwire` from its checkout instead of the global executable.

Same-host browser access stays local and needs neither Relay nor tunnel. Phone/other-device access is optional: use the remote form to connect an existing fixed Relay or choose a temporary access provider. A fixed Relay provides an operator-managed stable endpoint; temporary tunnel access depends on the chosen provider, its tools and outbound connectivity, and its endpoint/lifetime can change. Cloudflare is optional, not a requirement for local use or a fixed Relay. Open the remote Web endpoint and pair using the one-use invitation, not the host's local connection token. Treat pairing codes and QR images as secrets. A permanent public endpoint still needs a reachable server/domain and credentials; bootstrap does not provision a VPS, configure DNS, open firewall ports or deploy public services without operator action. See [Relay deployment](RELAY-INSTALL.md).

Daemon and DSH remain loopback-only. No delegated approvals are enabled by bootstrap. Keep the host awake, protect private credentials, and back up Turnwire config and state plus DSH state/attachments, including an explicitly configured `TURNWIRE_DSH_HOME`. Pairing is v2-only and requires a matching current Relay, host and client; old hosts and device credentials are not supported.

## Verification boundary

The published npm tarball was verified by a fresh registry installation, offline doctor, demo host/authenticated RPC/Web checks, and Linux/macOS package CI. Real DSH baseline/latest/next integration CI covers authenticated startup, catalog, empty sessions, restart/resume and ownership-safe shutdown; it does not certify inference or every future DSH version. See [compatibility limits](DSH-COMPATIBILITY.md).

Source-service bootstrap tests replace system commands and the installer in an isolated filesystem. They verify control flow, repeated startup, conflicts and credential handling without restarting the development host. This is not an end-to-end fresh-VM/network/systemd deployment certification.
