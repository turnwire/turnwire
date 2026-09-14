English · [中文](RELAY-INSTALL.zh.md)

# One-command Relay deployment

Turnwire's deployment service runs uniformly inside the daemon. The CLI, TUI and native macOS form submit the same local administration request; the task continues after the window or terminal closes. The server installation logic lives in `apps/deployer`, and deployment state and private settings are managed by `apps/daemon/src/deployment.ts`. A paired phone cannot call this administration interface.

## Environment

The server supports Debian / Ubuntu, systemd, and x86_64 or arm64. The SSH account needs administrator privileges, or the ability to use `sudo -n`; use a private key or an unlocked SSH agent — account passwords are not collected. The phone entry point uses the server's public IP or a domain that resolves to that server. Public TCP 80/443 must be reachable, and the server must be able to download official Node, system packages and Certbot.

If Caddy is already present, keep the other sites, only add the Turnwire site, and reload after verifying. When other services occupy 80/443, conflicting IP TLS settings already exist, or different instances occupy the port, a specific error is returned instead of overwriting existing services. Currently the installer manages one Turnwire Relay instance per server.

The first use builds from source, requiring `npm ci`, `npm run build` and starting the new daemon. Node, the phone page and the server installer's standalone artifacts are produced by the build; deployment does not need source, npm or `node_modules` on the server. All deployment parameters come from runtime configuration; no server address, SSH account or private key is built in.

## Three entry points

**macOS**: "Remote Control" → "Self-hosted Relay" → "One-command Deploy / Update Server". Fill in the SSH address, login account, private key file or agent and the phone entry point; you can expand advanced configuration or import a private JSON file. After clicking "One-command Deploy" a shared progress view appears. On success it connects this machine automatically by default, then generates the phone pairing QR code.

**CLI**: run `turnwire deploy` to open the interactive form, or use a configuration file:

```sh
npm run deploy:relay -- --config "$TURNWIRE_DEPLOY_CONFIG"
# With the CLI already installed:
turnwire deploy --config "$TURNWIRE_DEPLOY_CONFIG"
turnwire deploy --status
```

`TURNWIRE_DEPLOY_CONFIG` points at the user's own JSON file. Use `--no-wait` to return immediately; check later with `deploy --status`. By default it waits for completion, and Ctrl+C only exits the progress view. `--json` returns only structured status, not the server connection secret.

**TUI**: type `deploy` in `turnwire tui`, or choose "One-command server deployment" from the `remote` menu. As with the CLI, `deploy --config ...` is also supported.

## Private configuration

Use `deploy/relay.example.json` as a format reference, replace the example addresses and account with your own values, and save it outside the repository. The repository ignores `*.deploy.local.json`, `.turnwire/` and private key `.pem` files. A configuration file mode of 0600 is recommended. `host`, `sshUser` and `publicAddress` are required and have no built-in defaults.

| Field | Meaning / default |
| --- | --- |
| `host` | SSH IP or full domain, without a protocol |
| `sshUser` | SSH login account, required |
| `sshPort` | SSH port, default 22 |
| `identityFile` | Absolute path to the private key on the machine running the daemon; omit to use the SSH agent |
| `publicAddress` | IP or full domain the phone uses, without protocol, port or path |
| `email` | Optional email address for certificate notifications |
| `connectAfterDeploy` | Configure the local connection after success, default true |
| `relayPort` | Server loopback port, default 9899, not exposed publicly |
| `serviceUser` | Relay system account, default `turnwire-relay`, cannot be root |
| `installDir` | Installation directory, default `/opt/turnwire-relay` |
| `configDir` | Private configuration directory, default `/etc/turnwire-relay` |
| `caddyfile` | Shared configuration file, default `/etc/caddy/Caddyfile` |
| `caddyService` / `caddyGroup` | Caddy service name and certificate-reading group, default `caddy` |
| `certbotDir` | Separate Certbot directory, default `/opt/turnwire-certbot` |
| `certName` | Certificate name, default `turnwire-relay`; keep the original name when taking over an older deployment |
| `acmeWebroot` | Public certificate validation directory, default `/var/lib/turnwire-acme` |

The directories, ports and service account above are overridable product defaults and contain no user machine information. Redeploying an already-managed instance keeps its entry point, directories, ports, service account and certificate name; migrating those resources is not an in-place update.

## What it does automatically

1. Validates the configuration, SSH identity, privileges, system type, CPU and ports; records the SSH host fingerprint on first use and checks for changes afterwards.
2. Packages the Relay and PWA, excluding source maps, and verifies each file by SHA-256 after upload.
3. Installs a standalone Node verified against official checksums, plus Caddy and a separate Certbot. Existing usable components are reused.
4. Generates a random Relay secret on the server the first time; updates reuse the original value. Writes a root-owned 0600 environment file.
5. Validates the entry point over HTTP webroot, issues a test certificate, then requests the production HTTPS certificate. IPs use short-lived certificates; an existing still-valid certificate is reused.
6. Installs the service in a new release directory, verifies the Caddy configuration and then switches the current version, enabling startup at boot, restart on failure and an hourly certificate-renewal check.
7. Verifies public HTTPS from the server and from this machine; by default it saves the local Relay settings automatically and confirms host registration.

Key files are copied only temporarily into the daemon's private task directory and deleted afterwards; the SSH private key is never uploaded. The Relay secret is passed only between the server and the daemon and is not written to web pages, command-line arguments, deployment state or logs. Model environment variables are not passed to SSH, packaging or server installation processes. Machine configuration and deployment state are stored in the daemon's private SQLite; SSH `known_hosts` lives in `TURNWIRE_STATE_HOME/deployments/` (default `~/.local/state/turnwire/deployments/`; see [XDG directory rules](XDG.md)).

IP certificates need automatic renewal; see [Let's Encrypt's Certbot guide](https://letsencrypt.org/2026/03/11/shorter-certs-certbot). The installer configures an hourly timer and a certificate deployment hook. For Caddy's default SNI configuration for IPs, see the [official documentation](https://caddyserver.com/docs/caddyfile/options#default-sni).

## Update, diagnostics and recovery

Click deploy again with the same configuration, or repeat the same command. The installer keeps credentials and valid certificates, creates a new release directory and keeps the previous version. Updating the service briefly reconnects the phone; the Mac's Core and DSH are not restarted by this.

An error during installation restores the service/site files modified this time and the original release link. System dependencies, issued certificates and diagnostic records are kept. When the network drops or the daemon exits, local errors alone cannot determine the server's state; the interface marks the interruption, and you can inspect the server first and then retry with the same configuration.

The `install.log` in the server deployment directory is readable only by administrators; a failed state shows the diagnostics directory. Common operations commands:

```sh
systemctl status turnwire-relay --no-pager
systemctl list-timers turnwire-certbot-renew.timer --no-pager
journalctl -u turnwire-relay -n 50 --no-pager
journalctl -u turnwire-certbot-renew -n 50 --no-pager
```

The active version, the previous version and the server configuration are recorded in `configDir/deployment.json`. Rolling back can atomically point `installDir/current` back at the previous version and restart `turnwire-relay`; site configuration backups live in `configDir/backups/`, and restoring keeps other sites added after the deployment. Do not stop the shared Caddy.

A completed deployment and Mac registration do not mean the actual phone is connected. After scanning the code the phone must show "Connected to Mac", and the Mac device list should also show the last confirmation time. Actual iPhones, cellular networks and different carriers still each need their own acceptance testing.

## Web Push persistent state

The new installer creates `${installDir}/state` (0700, owned by the service account) and adds write permission for only this directory to systemd. The environment file automatically sets `TURNWIRE_PUSH_DB=${installDir}/state/push.db` and `TURNWIRE_VAPID_SUBJECT` to the configured public HTTPS address. VAPID keys are generated on first start; an in-place update keeps the database so phone subscriptions are not invalidated. Protect this directory like a credential file when backing it up. Updates within the current v2 contract do not replace valid v2 device credentials. This is not compatibility with old hosts, device credentials or pairing formats: all participants must use the current v2 contract, and devices enroll with a new v2 pairing rather than an upgrade command or PUT replacement. Host Store rejects old databases without migration. Before replacing a host, back up its resolved Turnwire config and state directories and DSH state/attachments separately; the Relay push database is not a host backup. See the [maintenance guide](FIRST-UPGRADE.md).
