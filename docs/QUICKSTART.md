English · [中文](QUICKSTART.zh.md)

# Turnwire quickstart

## Recommended: published npm preview (Linux / macOS)

The public [`turnwire@0.1.0-next.0`](https://www.npmjs.com/package/turnwire) preview requires Node.js 22.13+ and npm. No repository access, source build or systemd setup is needed:

```sh
npx turnwire@next
```

For a persistent installation:

```sh
npm install -g turnwire@next
turnwire --open
```

Keep the terminal open: this starts a foreground host, not a background service. Ctrl-C stops processes it owns, not an external DSH. The package contains the host, CLI/TUI and Web; it is not a signed native Mac app. Local Web needs no Relay. Model credentials remain on the host and are requested privately; never send them to a phone or Relay.

An existing DSH is reused when explicitly configured with `TURNWIRE_DSH_URL` and `TURNWIRE_DSH_TOKEN`, or a private mode-0600 `dsh-connection.json` in the Turnwire config directory. The launcher does not scan other tools for secrets. Without an external connection it reuses an existing Turnwire-managed installation; if none exists, it offers installation of registry `latest`, resolved to an exact version, in an isolated version directory and validates it before selection. Failed authentication does not silently install a replacement.

Use `turnwire doctor --json` for an offline environment check. After stopping your own foreground instance, run `turnwire start --update-dsh` to explicitly stage and validate a managed runtime update. Failed validation preserves the old selection; there is no automatic downgrade, hot update, or update of external/custom DSH. Normal startup does not silently upgrade an existing runtime. See [npm installation](NPM.md), [DSH compatibility and limits](DSH-COMPATIBILITY.md), and [directory rules](XDG.md).

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

`--check` reports preflight conditions without installing or starting anything. Service activation is not proof that DSH and the provider are healthy: confirm the printed status and connection steps. For unattended machines, user lingering may need administrator approval: `sudo loginctl enable-linger "$USER"`.

## Phone access is a separate explicit choice

After npm startup, keep the foreground terminal running and use a second terminal (for a global installation):

```bash
turnwire remote
turnwire devices pair --name phone --qr
```

For npx-only use, prefix the same commands with `npx turnwire@next`. For the source-based service, use `bin/turnwire` from its checkout instead of the global executable.

Use the remote form to connect an existing fixed Relay or choose a temporary access provider. A permanent public endpoint still needs a reachable server/domain and credentials; bootstrap does not provision a VPS, configure DNS, open firewall ports or deploy public services without operator action. See [Relay deployment](RELAY-INSTALL.md).

Daemon and DSH remain loopback-only. No delegated approvals are enabled by bootstrap. Keep the host awake, protect private credentials, and back up Turnwire config and state plus DSH state/attachments, including an explicitly configured `TURNWIRE_DSH_HOME`. Pairing is v2-only and requires a matching current Relay, host and client; old hosts and device credentials are not supported.

## Verification boundary

The published npm tarball was verified by a fresh registry installation, offline doctor, demo host/authenticated RPC/Web checks, and Linux/macOS package CI. Real DSH baseline/latest/next integration CI covers authenticated startup, catalog, empty sessions, restart/resume and ownership-safe shutdown; it does not certify inference or every future DSH version. See [compatibility limits](DSH-COMPATIBILITY.md).

Source-service bootstrap tests replace system commands and the installer in an isolated filesystem. They verify control flow, repeated startup, conflicts and credential handling without restarting the development host. This is not an end-to-end fresh-VM/network/systemd deployment certification.
