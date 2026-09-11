English · [中文](QUICKSTART.zh.md)

# One-command Linux host startup

## First run

Use a dedicated ordinary Linux account with a working systemd user manager. Obtain the repository using Git and enter its directory, then run:

```bash
git clone https://github.com/turnwire/turnwire.git
cd turnwire
bash scripts/start-host.sh
```

If Node/npm is already installed, `npm start` runs the same entry point. The Bash entry can prepare the pinned Node runtime itself. Download/build time depends on the network and CPU; this is one startup command, not a promise of instant installation or no prerequisites.

The script checks the environment, prepares Node and dependencies, builds the PWA/host, asks for the model credential without echoing it, and delegates persistent service installation to the existing Linux installer. The default managed host needs `TURNWIRE_HARNESS_DEEPSEEK_API_KEY`; this does not invent or register any models. The private `config/dsh.env.json` is preserved if already present. Do not put keys in command-line arguments, public deployment files or screenshots.

Required system tools include Bash, a systemd user manager and the tools needed to download/extract the Node release. Root is not the intended execution account. Use a simple checkout path without spaces, matching the service installer's path requirements. macOS is not supported by this Linux bootstrap; use the native/source setup instructions instead.

## Subsequent runs

Run only one bootstrap invocation at a time; concurrent first-time builds are not serialized. Run the same command again after it finishes. A matching running service is left running; a matching stopped installation is started without rebuilding. The entry refuses a conflicting service belonging to another installation rather than overwriting or restarting it. This is not an upgrade command. Finish active tasks and follow controlled update instructions to replace an installation.

```bash
bash scripts/start-host.sh --check
systemctl --user status turnwire-host
journalctl --user -u turnwire-host -n 100
```

`--check` reports preflight conditions without installing or starting anything. Service activation is not proof that DSH and the provider are healthy: confirm the printed status and connection steps. For unattended machines, user lingering may need administrator approval: `sudo loginctl enable-linger "$USER"`.

## Phone access is a separate explicit choice

After startup:

```bash
bin/turnwire remote
bin/turnwire devices pair --name phone --qr
```

Use the remote form to connect an existing fixed Relay or choose a temporary access provider. A permanent public endpoint still needs a reachable server/domain and credentials; bootstrap does not provision a VPS, configure DNS, open firewall ports or deploy public services without operator action. See [Relay deployment](RELAY-INSTALL.md).

Daemon and DSH remain loopback-only. No delegated approvals are enabled by bootstrap. Keep the host awake, protect private credentials, and back up both Turnwire state and DSH state/attachments.

## Verification boundary

Bootstrap tests replace system commands and the installer in an isolated filesystem. They verify control flow, repeated startup, conflicts and credential handling without restarting the development host. This is not an end-to-end fresh-VM/network/systemd deployment certification.
