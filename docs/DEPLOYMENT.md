English · [中文](DEPLOYMENT.zh.md)

# Self-hosted Relay + PWA

## Mainland China networks

Cloudflare cannot be treated as a dependency that is always reachable on mainland China networks. The [official China Network documentation](https://developers.cloudflare.com/china-network/) notes that overseas nodes can bring noticeable latency and reliability problems; China Network is a separate Enterprise subscription. The [Quick Tunnels documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) explicitly provides no SLA or uptime guarantee. Turnwire therefore treats it as an optional temporary trial method; real-world availability in mainland China depends on the user's network and cannot be inferred from a single test on a development machine.

For long-term use, put the self-hosted Relay on a server that has been tested as reachable from both the Mac and the phone, with a trusted HTTPS domain or IP certificate. Verify component downloads, the Mac-to-service connection, and the phone network's DNS, HTTPS and WSS separately; the Mac showing the channel as connected does not prove that the phone-side path is clear. A fixed Relay can run directly, with no dependency on Cloudflare at all. Turnwire does not modify system DNS automatically or switch services behind your back.

## Temporary cross-network trial

Open "Remote Control" → "Temporary Tunnel", choose a tunnel service first, then click "Start Temporary Access". The CLI/TUI offers the same choices, and the daemon manages the loopback-only Relay, the phone page and the tunnel child process centrally.

| Service | First-time setup and limits |
| --- | --- |
| localhost.run | Uses the SSH bundled with macOS; anonymous connections need no account and do not use the user's SSH keys. The free service is rate-limited and its address may change; see the [official free tunnel documentation](https://localhost.run/docs/) and the [CLI documentation](https://localhost.run/docs/cli/) |
| cpolar | After registering an account, enter the Auth Token in the native SecureField or hidden terminal input; afterwards you can leave it blank to reuse it. Connects to the mainland China `cn` region; the free tier uses random domains and is rate-limited, and cannot guarantee actual speed under any carrier. See the [official documentation](https://www.cpolar.com/docs) |
| Cloudflare | Account-free Quick Tunnel; downloads the official component on first use and verifies its SHA-256; reachability from mainland China depends on the network |

On macOS, cpolar is downloaded automatically the first time — the official 3.3.18 component, verified against the SHA-256 of the official Homebrew formula, and saved to `TURNWIRE_HOME/tools`. You can also use an already-installed cpolar via PATH or `TURNWIRE_CPOLAR_PATH`; other systems must install the component themselves. The Token is kept in daemon-private state; the child process reads it through a temporary 0600 config file, which is deleted after it stops; it is never passed as a command-line argument. The CLI reads the first credential from `TURNWIRE_CPOLAR_AUTH_TOKEN`, and `turnwire remote` / `turnwire tui` can take hidden input directly, so the Token never has to be written into shell history.

Cloudflare can reuse the `cloudflared` on PATH, or you can point at one with `TURNWIRE_CLOUDFLARED_PATH`. localhost.run uses a separate `known_hosts` file, recording the host key on first use and checking for changes afterwards, without modifying the user's SSH configuration. Startup can be canceled, and turning off remote access cleans up the daemon-managed tunnel and Relay.

Once the channel is ready, a QR code is generated; scan it with the phone's browser. The CLI equivalents are:

```bash
turnwire remote temporary --provider localhost-run
turnwire remote temporary --provider cpolar
turnwire remote temporary --provider cloudflare
turnwire remote status --watch
turnwire devices list --watch
turnwire remote off
```

"Channel ready" does not mean the phone has connected. "Paired" only means that device has been authorized. After the phone's header receives the Mac's encrypted round-trip response it shows "Connected to Mac", the last confirmation time and the latency, and checks every 10 seconds; if there is no response for 8 seconds it leaves the connected state and reconnects, and it re-checks when returning to the foreground. The Mac's paired-device list refreshes every 2 seconds and only shows a device as online after receiving the phone's confirmation of a new challenge; after more than 25 seconds without confirmation it becomes offline. Connection status reflects the most recent check and cannot guarantee availability after sleep, lock screen or future network changes.

The following manual Cloudflare approach is still available for independent operations and debugging:

The local Relay can also serve the built phone page through `TURNWIRE_REMOTE_WEB_ROOT`. Run `npm run build` first, then in a terminal configured with a random `TURNWIRE_RELAY_TOKEN` run:

```bash
TURNWIRE_REMOTE_WEB_ROOT="$PWD/apps/remote-web/dist" npm run dev:relay
# In another terminal; install the official cloudflared first:
cloudflared tunnel --url http://127.0.0.1:9899
```

Take the HTTPS address printed by the tunnel and, in the environment that starts the Mac daemon, set `TURNWIRE_REMOTE_URL=https://actual-tunnel-host`, `TURNWIRE_RELAY_URL=wss://actual-tunnel-host/relay` and the same `TURNWIRE_RELAY_TOKEN`, keeping the DSH connection parameters. Once you have confirmed that sessions are idle, restart the daemon and generate the phone pairing link in the native client's "Remote Control". Opening the link on the phone over cellular lets it continue the same session, send messages and approve requests.

The tunnel points at the Relay's static entry point on 9899; the local daemon on 9898 and DSH on 3080 stay reachable only from this machine. The static entry point provides no daemon RPC, device-management interface, configuration files or source maps. Once the temporary tunnel is closed the entry point stops working; recreating it may change the domain, so update the daemon configuration and pair again. This approach suits a development trial, and the [Cloudflare Quick Tunnels documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) states that it does not guarantee availability.

## One-command deployment of a fixed Relay

The CLI, TUI and native macOS client now offer the same deployment capability. The server address, SSH account and key path all come from private runtime configuration, and an HTTPS entry point by IP or domain is supported. See [One-command deployment and operations](RELAY-INSTALL.md) for details.

## Fixed-domain deployment

You need a public server, Docker Compose and a domain pointing at the server. The server runs only the Relay and the static PWA; `turnwire-host` and DSH on the Mac keep running locally. The configuration below is auditable, and the repository never deploys any external service automatically.

On the server, copy the repository and set the domain and a random Relay host authentication secret:

```bash
export TURNWIRE_DOMAIN=turnwire.example.com
export TURNWIRE_RELAY_TOKEN="$(openssl rand -hex 32)"
docker compose -f deploy/compose.yaml up -d --build
```

In production, keep that value in a controlled environment file or secret manager on the server. Caddy obtains HTTPS certificates automatically, and the server must expose 80/443. `/relay` proxies to the private Relay, and other paths serve the PWA. The host authentication secret is configured only on the server and the Mac; it must not go into Vite environment variables or web page source, or be sent to the phone.

Mac:

In the native client, go to "Remote Control" → "Self-hosted Relay", enter the HTTPS domain and server secret above, and click "Save and Connect". No restart of the daemon or DSH is needed. If a secret is already saved for the same server you can leave it blank; changing servers means you must enter that server's secret again. On the CLI, run `turnwire remote relay https://turnwire.example.com` in a terminal with `TURNWIRE_RELAY_TOKEN` set.

The old environment-variable startup method is still supported:

```bash
export TURNWIRE_RELAY_URL=wss://turnwire.example.com/relay
export TURNWIRE_REMOTE_URL=https://turnwire.example.com
export TURNWIRE_RELAY_TOKEN='COPY_THE_SERVER_SECRET_HERE'
export TURNWIRE_DSH_URL='http://127.0.0.1:3080/?token=YOUR_DSH_LAUNCH_TOKEN'
npm run dev
```

Open "Remote Control" in the native Turnwire app to generate a pairing code, or run:

```bash
npm run turnwire -- devices pair --name my-phone
```

Open `https://turnwire.example.com` on the phone and paste the pairing code. If you want a home-screen icon, use the browser's "Add to Home Screen". The fragment in the pairing link contains a secret; do not forward it, commit it to a code repository or paste it into a public channel.

Revocation: `turnwire devices revoke DEVICE_ID`. Changing the device list reconnects the host's Relay channel, and other devices reconnect briefly. When the Mac is offline the Relay does not buffer commands; once the Mac is back online clients reconnect automatically and catch up on events.

The selected mode and the self-hosted connection secret are stored in the daemon's private SQLite state (file mode 0600), and the secret is never returned to the status interface or the phone. Settings saved by the app/CLI take precedence over startup environment variables; after an explicit shutdown, the daemon stays off across restarts. Self-hosted mode restores its fixed address after a restart, while temporary mode creates a new address after a restart. Switching modes does not restart Core or DSH; phones on the old address need a newly generated pairing link.

Back up the whole `TURNWIRE_HOME`, including the SQLite WAL companion files; prefer backing up with the daemon stopped, or use a SQLite online backup tool. That directory contains connection credentials. Do not copy a `state.db` that is being written on its own. This version has no automatic event archiving or disk-quota management for unlimited history, so deployers should monitor disk usage.

A persistent Mac service can be managed by launchd running `node /absolute/path/turnwire/apps/daemon/dist/main.js`, with `TURNWIRE_HOME` and runtime/Relay parameters configured through `EnvironmentVariables`. The native App does not host the daemon itself, so closing its window does not kill tasks. The Mac must stay awake and online; software cannot keep a sleeping or powered-off Mac executing.

A `Dockerfile` and Compose configuration are provided, but the Docker path is still not actually verified; the verified servers run directly under systemd, with their production IP certificate and public encrypted link verified, while external iPhone access and real DSH model tasks still need acceptance testing in the target environment.

## Linux headless host and TUI

The headless host runs the same DSH adapter, daemon, CLI/TUI and encrypted remote-control protocol as the desktop installation. Fresh installs keep `apps`, `packages` and source configuration in the install directory, while external configuration/state/runtime/cache use [XDG directories](XDG.md). Existing checkout-local `state`, `dsh-state`, `runtime` and private configuration remain supported without migration. Build the release before copying it. `scripts/install-linux-host.sh` installs a checksum-verified Node runtime, locked production dependencies and the DSH runtime pinned by `config/dsh-runtime`, then registers the user service. Do not copy platform-specific `node_modules` from macOS to Linux.

Use `bash scripts/start-host.sh` for first-run credential setup. For manual fresh installation, put the DSH environment mapping in the XDG Turnwire config directory as `dsh.env.json` with mode 0600 (legacy installs retain `config/dsh.env.json`); it contains the `TURNWIRE_HARNESS_DEEPSEEK_API_KEY` environment variable. This private file is supplied on the destination, never included in release archives. The managed launcher passes its value only to DSH. Turnwire receives the short-lived loopback DSH connection URL; model values and URL tokens are redacted from service logs.

From the installation directory run:

```sh
bash scripts/install-linux-host.sh "$PWD"
bin/turnwire tui
```

The installer generates the executable wrapper and `turnwire-host.service` for the current user, deriving all paths from the supplied directory. The service starts DSH on loopback, waits for its authenticated launch URL, then starts Turnwire. A failed child causes a supervised restart; shutdown drains Turnwire before DSH. Use `systemctl --user status turnwire-host`, `restart turnwire-host`, or `journalctl --user -u turnwire-host` to manage it. Enable lingering for startup at boot without an SSH login. Exiting TUI or SSH leaves the host service running.

Use `bin/turnwire remote` to select the existing Relay, then `bin/turnwire devices pair --name phone --qr` to pair the phone. Each host has its own identity, sessions and pairing; a pairing for another host does not switch automatically. Local daemon/DSH ports stay on loopback, and remote access goes through the encrypted Relay. The generic managed launcher also accepts `TURNWIRE_INSTALL_DIR`, `TURNWIRE_HOME`, `TURNWIRE_DSH_HOME`, `TURNWIRE_DSH_ENTRY`, `TURNWIRE_DSH_ENV_FILE` and `TURNWIRE_DSH_PORT` when a different layout is required.

## Remote v2, notifications and LAN direct connection

The update order is Relay → host daemon → client. A new Relay is compatible with an old host; the new host registration adds connection-identifier isolation, so the Relay must be updated first. Keep the existing private deployment configuration and run the same one-command deployment to update. Existing pairings keep using the old encryption; credentials are only replaced when you choose `turnwire devices upgrade <id> --qr` or macOS "Paired Devices → Pair Again". A new QR code is valid for 15 minutes and can only be enrolled once.

One-command deployment automatically creates `${installDir}/state/push.db`, owned exclusively by the service account in the configuration and persistently storing the VAPID keys and the notification queue; updating the release does not delete that file. When running the Relay manually, set `TURNWIRE_PUSH_DB` (a private SQLite path) and `TURNWIRE_VAPID_SUBJECT` (the operator's HTTPS address or mailto contact address). Leaving those two variables unset only disables push capability; Relay forwarding still works. Push egress uses standard HTTPS; no Apple Developer membership or Firebase project is required.

The host manages notifications with `turnwire notifications on/off/status`; the TUI and native client have the same form. On the phone, tap "Enable Notifications and Remember This Device" in the inbox. On iPhone, add to the Home Screen first, then authorize. Only a fixed entry point is suitable for long-term notifications; after a temporary tunnel changes domain it cannot inherit the original site's browser subscription. Notifications only contain a pending-item hint; tapping re-verifies the host and reads the current inbox. A sleeping host is not woken by Web Push.

The LAN entry point is off by default. `turnwire remote direct` opens the form, or `turnwire remote direct configure --config "$TURNWIRE_DIRECT_CONFIG"` reads a private configuration. The native macOS entry point is "Remote Control → LAN Direct Connection". Example configuration (replace the domain and certificate paths with your own):

```json
{"enabled":true,"url":"wss://host.example.com:9443/remote","listenHost":"0.0.0.0","port":9443,"certificatePath":"/absolute/path/fullchain.pem","privateKeyPath":"/absolute/path/privkey.pem"}
```

That domain must resolve to the host's LAN address on the phone's network, the certificate must be trusted by the phone browser, and the browser must be allowed to access the LAN. Candidate interface IPs are shown in the host form; management ports are not automatically exposed to the LAN. No self-signed-certificate bypass or insecure WS downgrade of an HTTPS page is provided. After changing the certificate, save the direct configuration again to load the new files. When the configuration is valid, enrolled phones store the encrypted direct candidates and race them against the Relay on the next connection. Guest Wi-Fi isolation, VPNs and actual iPhone permissions need to be verified per deployment environment.
