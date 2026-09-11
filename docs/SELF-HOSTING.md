English · [中文](SELF-HOSTING.zh.md)

# Developing Turnwire with Turnwire

The host can run this checkout instead of an installed release, so the agent that edits Turnwire
is the agent Turnwire is running. This document covers the loop, the guards that keep it
developer-only, and the rollback that keeps a remote operator connected.

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
cp <release>/config/dsh.env.json config/dsh.env.json   # 0600, gitignored
npm run build
scripts/install-dev-host.sh --state <state> --dsh-home <dsh-state>
```

`--state` and `--dsh-home` must be the directories the current host already uses, or the host
comes up with no paired devices, no Relay token and no session log. Nothing is started: the unit
exists but stays inactive until you switch to it.

Add `--enable-watch` to enable both `turnwire-dev-reload.path` and
`turnwire-dev-reload.timer` (nested edits are caught by the timer). These only publish frontend
assets after an explicit initial frontend publication; backend and DSH changes remain manual.
Without the flag the installer disables and stops both triggers and stops the reload service.
The host is never started by this installer; enabling watch does start the reload triggers.

## The DSH environment file

`config/dsh.env.json` (0600, gitignored) is the environment DSH is started with, not a slot for a
single key: every string it holds is forwarded to the DSH process, and Turnwire's own secrets
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
// config/dsh.env.json
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
```

- **Content fingerprints.** Separate frontend, backend/shared and DSH hashes cover actual bytes,
  paths and executable bits of relevant tracked and untracked files. Docs, tests, generated output,
  dependencies and credential files are excluded. Dirty-to-dirty edits are detected; docs-only
  edits never build or deploy. The first automatic observation records no deployment success and
  performs no build. `--force` is no longer supported.
- **No automatic backend update.** Backend/shared changes are reported as requiring an operator.
  There is no race-free drain gate, so an idle snapshot is not permission to restart. Neither
  daemon nor DSH is restarted by this script. DSH changes always need explicit operator action;
  daemon maintenance must use a supervisor daemon-only operation that preserves DSH. A full host
  restart can terminate live work. No model catalog synchronization runs during reload.
- **Frontend publication.** A checkout-local `flock` serializes reload builds and publication.
  Only the remote-web workspace builds, into staging. Content-addressed old assets are retained,
  new assets land before the index is atomically replaced, and changed non-hashed asset collisions
  fail closed for manual handling. Failed builds leave the existing index intact. Use the same
  lock for other manual asset builds; unrelated `npm run build` commands do not honor this lock.
- **Health and stamps.** Local `/health` must return HTTP success and `{status:"ok",protocol:1}`
  before building, before publication and after publication. Unknown/unreachable health blocks;
  failure after publication restores the old index. Only verified frontend publication writes
  `.turnwire/reload.frontend.json`. The separate observation file is not a running-version stamp.
  Set `TURNWIRE_RELOAD_HEALTH_URL` for a nondefault local daemon endpoint. This is frontend HTTP
  readiness, not evidence that all model providers are available or that sessions are drained.
  Shared/backend drift blocks automatic frontend publication too; use `--frontend` only after
  checking compatibility during manual maintenance.

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
is the right check because it proves the host started and authenticated with its stored token,
without depending on the phone being awake. If the switch goes wrong while you are away from the
machine, the machine comes back on its own.

`--no-watchdog` skips the guard.

## The one step this cannot do for you

The phone loads the PWA **from the Relay**, so the phone runs whatever bundle the Relay was
deployed with. A host whose protocol constants changed only serves a phone built from the same
source. After switching, reload the phone; if it reports an authentication failure, redeploy the
Relay so the phone picks up the new bundle:

```bash
npm run turnwire -- deploy --config <private config>
```

Existing pairings survive this: a pairing credential is a token and a key, with no protocol
constant in it, so both ends agreeing on the same source is enough. The Relay keeps serving the
page over plain HTTPS even while the encrypted channel is failing, so a reload is always possible
from the phone.

## Rolling back by hand

```bash
systemctl --user stop turnwire-dev.service
systemctl --user start turnwire-host.service
```

The release tree is never modified by any of this, so the release host is always one command away.
