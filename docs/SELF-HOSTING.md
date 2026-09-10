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

Add `--enable-watch` to enable `turnwire-dev-reload.path`, which reloads automatically when
`apps/`, `packages/` or `scripts/` change. It is disabled by default.

## Reload

```bash
scripts/host-reload.sh          # rebuild and restart at a safe point
scripts/host-reload.sh --force  # ignore the fingerprint
```

Three properties make repeat runs harmless:

- **Fingerprint.** `git rev-parse HEAD` plus `git status --porcelain`. Because `dist/` is
  gitignored, a rebuild does not change the fingerprint, so a watch-triggered run that follows a
  build exits immediately instead of looping.
- **Safe point.** It waits (default 900s) until no session is `running` or `waiting_approval`
  before restarting, so a reload never interrupts a turn. Background subagents are **not** covered by
  that check: a delegation tool returns as soon as it hands work to a child, so the session can read
  as idle while the child is still working, and the restart kills it. Before fan-out work, stop the
  timer (`systemctl --user stop turnwire-dev-reload.timer`) and start it again when the children are
  done. The runtime reports its live children (`busy` in the snapshot), so the wait covers them too. A child the runtime can no longer see — after a manual restart, for example — is outside the check, and stopping the timer by hand is the fallback.
- **Restart is survivable.** A turn runs inside DSH, which persists its session log, and
  Turnwire reconnects by following the session and replaying from its stored cursor. After a
  reload, re-attach and continue.

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
