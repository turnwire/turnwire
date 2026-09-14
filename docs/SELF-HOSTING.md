English · [中文](SELF-HOSTING.zh.md)

# Developing Turnwire with Turnwire

The host can run this checkout instead of an installed release, so the agent that edits Turnwire
is the agent Turnwire is running. This document covers the loop, the guards that keep it
developer-only, and recovery procedures. Switching or reloading can interrupt remote connections;
rollback does not guarantee recovery of incompatible state.

## Why this is not a product feature

Auto-update is deliberately absent from every product surface:

- There is **no RPC method** for it, so no client can invoke it — not the local CLI, not the
  desktop app, and not a paired phone. A remote device cannot trigger a code deployment.
- The installer (`scripts/install-host-service.mjs`, `scripts/install-linux-host.sh`) never
  creates the development units and never enables reloading. Following the documented install
  path cannot produce a self-updating host.
- Defining new behaviour is out of scope here: this only changes which build the host runs.

The boundary is the filesystem, not the API: **only someone who can run a shell inside this git
checkout can reload it.** `scripts/host-reload.sh` enforces that directly — it refuses unless the
target is a git working tree, so an installed release (which has no `.git`) can never self-update
even if someone finds and runs the script. It also refuses any unit other than
`turnwire-dev.service`, so the release host is never touched.

## Install the development host (does not start anything)

```bash
npm ci --prefix config/dsh-runtime          # the DSH the host will run
export TURNWIRE_DSH_ENV_FILE=/absolute/private/dsh.env.json # existing file, mode 0600
npm run build
scripts/install-dev-host.sh --state <state> --dsh-home <dsh-state>
```

Choose `--state` and `--dsh-home` explicitly. Reuse state only after verifying that it uses the
current final storage schema and v2 pairings, and that the DSH home is compatible. Store rejects
older databases without migration; for an incompatible installation use separate empty state,
configure the host and create new pairings. Do not point the new host at old state as an upgrade
strategy. See [First upgrade](FIRST-UPGRADE.md). Config/data/cache use separate XDG paths or
explicit `TURNWIRE_CONFIG_HOME`, `TURNWIRE_DATA_HOME` and `TURNWIRE_CACHE_HOME` overrides;
`--state` sets `TURNWIRE_STATE_HOME`, not those paths. No legacy layout is detected.
Nothing is started: the unit exists but stays inactive until you switch to it.

Add `--enable-watch` to enable both `turnwire-dev-reload.path` and
`turnwire-dev-reload.timer` (nested edits are caught by the timer). These only publish frontend
assets after an explicit initial frontend publication; backend and DSH changes remain manual.
Without the flag the installer disables and stops both triggers and stops the reload service.
The host is never started by this installer; enabling watch does start the reload triggers.

## The DSH environment file

The private `TURNWIRE_DSH_ENV_FILE` (mode 0600; default `~/.config/turnwire/dsh.env.json`,
resolved through `TURNWIRE_CONFIG_HOME` / `XDG_CONFIG_HOME`) is the environment DSH is
started with, not a slot for a single key: every string it holds is forwarded to the DSH process, and Turnwire's own secrets
(relay token, DSH launch token and URL) are stripped even if the file names them. Nothing in it
reaches the daemon or any client — model credentials stay inside DSH.

That is what makes more than one provider endpoint a configuration change rather than a code
change. DSH mounts `llm-pi-ai`, whose routes are a dict keyed by provider, so a second endpoint is
one entry plus its credential:

```yaml
# config/dsh-deepseek.patch.yml
- id: llm-deepseek
  config:
    apiKeyEnv: TURNWIRE_HARNESS_DEEPSEEK_API_KEY

- id: llm-pi-ai
  config:
    providers:
      gateway:                        # this key is the provider id clients will show
        displayName: Team gateway
        baseURL: https://gateway.example.com/v1
        api: openai-completions       # or anthropic-messages, openai-responses, ...
        apiKeyEnv: TURNWIRE_HARNESS_GATEWAY_KEY
        models:
          - id: some-model
            name: Some model
```
```json
// TURNWIRE_DSH_ENV_FILE
{ "TURNWIRE_HARNESS_DEEPSEEK_API_KEY": "…", "TURNWIRE_HARNESS_GATEWAY_KEY": "…" }
```

Turnwire does not need to know: the runtime's model catalog reports one group per registered route
with its own failures, the daemon refuses a model the runtime does not list, and every client shows
exactly those groups. Adding a route is visible to all of them on the next snapshot — no client
change, and no model id invented on this side.

## Reload

```bash
scripts/host-reload.sh             # publish only changed frontend assets, never restart
scripts/host-reload.sh --frontend  # explicit initial/manual frontend publication
scripts/host-reload.sh --daemon --dry-run # isolated staged build only; no host requests or signals
scripts/host-reload.sh --daemon    # explicit controlled daemon-only deployment, after coordination
```

- **Content fingerprints.** Separate frontend, backend/shared and DSH hashes cover actual bytes,
  paths and executable bits of relevant tracked and untracked files. Docs, tests, generated output,
  dependencies and credential files are excluded. Dirty-to-dirty edits are detected; docs-only
  edits never build or deploy. The first automatic observation records no deployment success and
  performs no build. `--force` is no longer supported.
- **No automatic backend update.** Backend/shared changes require an explicit `--daemon` operator
  invocation. An idle snapshot is never restart permission: a durable local maintenance lease closes
  admission and waits for Turnwire-managed work to drain. This is **not a whole-DSH drain**; unrelated
  DSH sessions may remain active. DSH, supervisor and dependency upgrades remain manual and outside
  this active-host deployment objective. No DSH package, model configuration or catalog is changed.
  A full host restart can terminate live work and must be separately coordinated.
- **Frontend publication.** A checkout-local `flock` serializes reload builds and publication.
  Only the remote-web workspace builds, into staging. Content-addressed old assets are retained,
  new assets land before the index is atomically replaced, and changed non-hashed asset collisions
  fail closed for manual handling. Failed builds leave the existing index intact. Use the same
  lock for other manual asset builds; unrelated `npm run build` commands do not honor this lock.
- **Health and stamps.** Local `/health` must return HTTP success, `status:"ok"`, `protocol:1` and an immutable built `identity` containing `buildId` and `contractDigest`. The daemon build identity covers the actual bundle dependency graph and captured source inputs, build configuration and declared dependency lock; it is not a hand-maintained list of source directories. Installed external dependency bytes are outside this source/build identity and must remain consistent with the lockfile.
  Publication checks this before building, before publication and after publication. The staged frontend's `turnwire-build.json` must require that contract, including for explicit `--frontend`. Source-mode or identity-free backends are not publishable. Unknown/unreachable health blocks;
  failure after publication restores the old index. Only verified frontend publication writes
  `.turnwire/reload.frontend.json`. The separate observation file is not a running-version stamp.
  Set `TURNWIRE_RELOAD_HEALTH_URL` for a nondefault local daemon endpoint. This is frontend HTTP
  readiness, not evidence that all model providers are available or that sessions are drained.
  Shared/backend drift blocks automatic frontend publication too; use `--frontend` only after
  checking compatibility during manual maintenance.

### Authenticated runtime readiness

The supervisor treats pinned DSH's stdout launch URL only as secret bootstrap discovery. It exchanges
that token using `GET /?token=…` (303 plus cookie), then probes authenticated `POST /api/session/list`
with a correlated client-request/server-response envelope and validates `result.ok` and `value.items`.
These interfaces were inspected in the installed 0.1.5-rc.2 runtime, not added to DSH. A startup deadline,
invalid token, unreachable API or malformed response fails closed: stdout alone never starts a daemon.
After startup, periodic failure marks readiness unknown and blocks new daemon starts/reload; it does
not stop an active DSH. The private atomic `<state>/run/host-readiness.json` (0600, run directory 0700)
contains PIDs, daemon generation, probe time, token-free DSH URL and readiness. It contains neither
launch tokens nor model/daemon credentials. A stale record (over ten seconds) cannot authorize deploy.
This proves authenticated runtime API reachability, not model-provider availability or global idleness.
An already-running older supervisor has no such record: `--daemon` deliberately refuses it. Installing
this readiness-capable supervisor requires a separately coordinated host stop/start when active DSH
work is safe to interrupt; rebuilding files does not update a running supervisor. Until then use only
frontend publication/dry-run and leave daemon deployment blocked. Never fabricate a readiness record.

### Controlled daemon deployment and recovery

`--daemon` builds one staged daemon artifact with workspace packages bundled from source, not the
current `dist` files. Installed third-party dependencies, supervisor code and DSH stay unchanged;
changes needing those components require separate manual maintenance. The script acquires a local
authenticated `/maintenance` lease only after the build, waits for `ready`, zero in-flight requests
and known zero managed runtime work, atomically replaces `apps/daemon/dist/main.js`, then sends
SIGUSR2 to the recorded supervisor. It verifies a new daemon generation, unchanged DSH/supervisor
identity, fresh authenticated runtime readiness, daemon HTTP health and the still-owned ready lease
before explicitly releasing admission. A source change during staging/drain aborts publication.
`--frontend` still never enters maintenance or restarts backend processes. Both paths share the lock.

Before acquiring maintenance and again after draining but before installation, the staged daemon
runs `--check-storage`. A failed compatibility check prevents installation and signaling; it does
not migrate the database. Daemon-only publication also checks the currently served frontend contract against the staged daemon, then verifies the exact running replacement build ID. Cross-contract changes require a coordinated offline full release, not a one-sided publication. `--dry-run` only builds and does not read the active database.

The durable `.turnwire/reload.daemon.pending.json` journal (0600) retains the opaque lease and the
staged rollback artifact. Never print it or copy it into public diagnostics. An existing journal
blocks another deploy. Failure before release restores installed bytes where possible and requests
only a daemon reload; it **does not cancel maintenance** or stop DSH. Inspect the journal, confirm
supervisor/DSH identities and restored daemon/runtime health, then explicitly cancel the owned lease
through the local maintenance API before archiving the journal. If the release response is lost,
the script neither rolls back nor signals again: admission may already be open, so inspect state
manually. Successful verification alone writes `.turnwire/reload.daemon.json`; observations are not
a running-version stamp. Do not kill a running deployment casually: its durable lease is intentionally
left closed for recovery. No script promises atomic DSH upgrades or silently stops active DSH work.

To stop all automatic checks (including an in-flight reload):

```bash
systemctl --user disable --now turnwire-dev-reload.timer turnwire-dev-reload.path
systemctl --user stop turnwire-dev-reload.service
```

## Switching the host, safely

```bash
scripts/host-switch.sh
```

It stops the release unit and starts the development one, then a transient systemd unit — outside
the host unit's cgroup, so the restart cannot kill it — restores the release host unless the
development host reaches the Relay within `TURNWIRE_SWITCH_WINDOW` (default 600s). The Relay link
checks only host startup and authentication with its stored token, without depending on the
phone being awake. It does not prove device enrollment, E2EE connectivity or data compatibility.
The watchdog attempts service recovery; it cannot guarantee that an older release can read the
selected state or that a remote operator regains access. Arrange local recovery before switching.

`--no-watchdog` skips the guard.

## The one step this cannot do for you

The phone loads the PWA **from the Relay**, so the phone runs whatever bundle the Relay was
deployed with. A host whose protocol constants changed only serves a phone built from the same
source. After switching, reload the phone; if it reports an authentication failure, redeploy the
Relay so the phone picks up the new bundle:

```bash
npm run turnwire -- deploy --config <private config>
```

Pairings carry a protocol version. Only compatible v2 pairings can be reused; matching source
builds do not convert v1 credentials or old state. V1 pairing is rejected with no upgrade path:
configure a fresh installation and create a new v2 invitation from the local host. A reachable
Relay may still serve the PWA over HTTPS while E2EE fails, but reloading the page neither repairs
incompatible credentials nor guarantees remote access. See [First upgrade](FIRST-UPGRADE.md).

## Rolling back by hand

```bash
systemctl --user stop turnwire-dev.service
systemctl --user start turnwire-host.service
```

These development scripts leave the release tree unchanged, but restarting that release is safe
only with compatible configuration, runtime and state. File rollback is not database migration or
credential recovery, and does not promise uninterrupted sessions. Preserve a separately usable
release environment and arrange a maintenance window and local access before switching.
