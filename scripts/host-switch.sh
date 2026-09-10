#!/usr/bin/env bash
# Switches the host from the installed release to this checkout, and rolls back by itself.
#
# Why a watchdog: you may be operating the machine remotely, so a switch that breaks the
# connection would leave you unable to undo it. `host-switch.sh` therefore starts a detached
# guard (a transient systemd unit, outside the host unit's cgroup, so a restart cannot kill it)
# that restores the release host unless the development host reaches the Relay within the window.
#
# What this does NOT do: redeploy the Relay. The phone loads the PWA from the Relay, so a host
# running renamed protocol constants only serves a phone whose bundle was built from the same
# source. Redeploy the Relay with the new bundle (`turnwire deploy`) so the phone picks up the
# new code; until it does, the phone shows an authentication failure and a reload fixes it.
set -euo pipefail

root=$(cd -- "$(dirname -- "$0")/.." && pwd)
release_unit="${TURNWIRE_RELEASE_UNIT:-turnwire-host.service}"
dev_unit="turnwire-dev.service"
window="${TURNWIRE_SWITCH_WINDOW:-600}"
watch="${1:-}"

git -C "$root" rev-parse --git-dir >/dev/null 2>&1 || { echo "refusing: $root is not a git working tree" >&2; exit 1; }
systemctl --user cat "$dev_unit" >/dev/null 2>&1 || { echo "run first: scripts/install-dev-host.sh --state DIR --dsh-home DIR" >&2; exit 1; }
systemctl --user cat "$release_unit" >/dev/null 2>&1 || { echo "refusing: $release_unit is not installed" >&2; exit 1; }
[ -f apps/daemon/dist/host-service.mjs ] || { echo "run first: npm run build" >&2; exit 1; }

# The development unit's own TURNWIRE_HOME is what keeps the pairings and Relay token.
state=$(systemctl --user show "$dev_unit" -p Environment --value | tr ' ' '\n' | sed -n 's/^TURNWIRE_HOME=//p' | head -1)
[ -n "$state" ] || { echo "refusing: cannot read TURNWIRE_HOME from $dev_unit" >&2; exit 1; }

guard_dir="${XDG_RUNTIME_DIR:-/tmp}/turnwire-switch"
mkdir -p "$guard_dir" && chmod 700 "$guard_dir"
confirm="$guard_dir/confirmed"
rm -f "$confirm"

if [ "$watch" != "--no-watchdog" ]; then
  echo "arming a ${window}s rollback guard: the release host returns unless the Relay link comes up"
  systemd-run --user --collect --unit="turnwire-switch-guard-$$" --property=Type=oneshot \
    /bin/bash -c "
      sleep $window
      if [ -f '$confirm' ]; then exit 0; fi
      systemctl --user stop $dev_unit
      systemctl --user start $release_unit
      logger -t turnwire-switch 'rolled back to $release_unit: the development host never reached the Relay'
    " >/dev/null
fi

echo "stopping $release_unit and starting $dev_unit"
systemctl --user stop "$release_unit"
systemctl --user start "$dev_unit"

# The Relay link is the check that does not depend on the phone being awake: it proves the
# development host started and authenticated with the stored Relay token.
deadline=$(( $(date +%s) + window ))
for _ in $(seq 1 "$window"); do
  if TURNWIRE_HOME="$state" npm run --silent turnwire -- remote status --json 2>/dev/null | grep -q '"state":"online"'; then
    touch "$confirm"
    echo "rollback guard released: the development host is online on the Relay"
    echo "now reload the phone; if it reports an authentication failure, redeploy the Relay (turnwire deploy) so the phone runs the new bundle."
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then break; fi
  sleep 1
done

echo "the development host did not reach the Relay within ${window}s" >&2
echo "leaving the rollback guard armed; it will restore $release_unit" >&2
exit 1
