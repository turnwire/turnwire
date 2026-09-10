#!/usr/bin/env bash
# Developer-only: rebuild this checkout and restart the development host at a safe point.
#
# This is deliberately NOT part of the product. It is a shell script in the working tree, not an
# RPC: the daemon does not know it exists, no client can reach it, and a paired remote device
# therefore cannot trigger a code deployment. The boundary is "can you run a shell in this git
# checkout", which is what being the developer means.
#
# Guards, in order:
#   1. The tree must be a git working tree. An installed release has no `.git`, so a release can
#      never self-update even if someone finds and runs this script.
#   2. The target unit must be the development unit. The release unit is never touched.
#
# `turnwire-dev-reload.path` calls this automatically; the fingerprint below makes repeat calls
# free, and — because `dist/` is gitignored — a rebuild cannot re-trigger itself.
set -euo pipefail

root=$(cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
unit="${TURNWIRE_DEV_UNIT:-turnwire-dev.service}"
force="${1:-}"

git rev-parse --git-dir >/dev/null 2>&1 || { echo "refusing: $root is not a git working tree" >&2; exit 1; }
[ "$unit" = "turnwire-dev.service" ] || { echo "refusing: this script only restarts turnwire-dev.service, not $unit" >&2; exit 1; }
systemctl --user cat "$unit" >/dev/null 2>&1 || { echo "refusing: $unit is not installed; run scripts/install-dev-host.sh first" >&2; exit 1; }
[ -f apps/daemon/src/host-service.ts ] || { echo "refusing: $root does not look like the Turnwire checkout" >&2; exit 1; }

# The stamp lives under an ignored path so it never changes the fingerprint it records.
stamp="$root/.turnwire/reload.stamp"
mkdir -p "$(dirname "$stamp")"
fingerprint() { { git rev-parse HEAD; git status --porcelain; } | sha256sum | cut -d' ' -f1; }
current=$(fingerprint)
if [ "$force" != "--force" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$current" ]; then
  echo "no source change since the last build; nothing to do"
  exit 0
fi

state="${TURNWIRE_HOME:-$root/.turnwire}"
wait_seconds="${TURNWIRE_RELOAD_WAIT:-900}"
deadline=$(( $(date +%s) + wait_seconds ))
echo "waiting for a safe point (up to ${wait_seconds}s): no running session"
while :; do
  running=$(npm run --silent turnwire -- status --json 2>/dev/null | node -e '
    let text = ""; process.stdin.on("data", part => { text += part; }).on("end", () => {
      try {
        const snapshot = JSON.parse(text);
        const sessions = (snapshot.sessions ?? []).filter(s => s.status === "running" || s.status === "waiting_approval").length;
        // Background subagents outlive an idle parent session, so they count too.
        const children = (snapshot.runtimes ?? []).reduce((total, runtime) => total + (runtime.busy ?? 0), 0);
        process.stdout.write(String(sessions + children));
      }
      catch { process.stdout.write("unknown"); }
    });' || echo unknown)
  # An unreachable daemon is not a running session; the reload is still safe.
  if [ "$running" = "0" ] || [ "$running" = "unknown" ]; then break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "a session or a background agent is still running; leaving the host alone" >&2; exit 1; fi
  sleep 5
done

echo "building $root"
npm run build
echo "$current" > "$stamp"

echo "restarting $unit"
systemctl --user restart "$unit"
for _ in $(seq 1 60); do
  if systemctl --user is-active --quiet "$unit"; then break; fi
  sleep 1
done
systemctl --user is-active --quiet "$unit" || { echo "$unit did not become active after the restart" >&2; exit 1; }
echo "reloaded: $(git rev-parse --short HEAD) is now running"
