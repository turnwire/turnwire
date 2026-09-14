#!/usr/bin/env bash
# Drives the phone PWA's model picker through a real browser against a DSH-backed daemon.
#
# Starts an isolated DSH host and an isolated Turnwire daemon, then runs
# scripts/ui-model-check.mjs. The model catalog needs no model credential, so no secret is
# required: the Host lists its routes before any turn runs.
#
# Skips itself when no Chrome or Chromium is installed, so it is safe in environments without
# a browser. Set TURNWIRE_REQUIRE_BROWSER=1 to fail instead of skipping, so a run cannot
# silently lose this coverage when a runner image changes. Pass --force to attempt the browser
# step anyway (useful when a browser lives somewhere this script does not look).
set -euo pipefail
cd "$(dirname "$0")/.."

force="${1:-}"
found=""
for candidate in /opt/google/chrome/chrome /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser; do
  if [ -x "$candidate" ]; then found="$candidate"; break; fi
done
if [ -z "$found" ]; then
  if [ "${TURNWIRE_REQUIRE_BROWSER:-}" = "1" ]; then
    echo "No Chrome or Chromium found, and TURNWIRE_REQUIRE_BROWSER=1 requires one." >&2
    echo "Install a browser, or unset TURNWIRE_REQUIRE_BROWSER to skip this check." >&2
    exit 1
  fi
  if [ "$force" != "--force" ]; then
    echo "Skipping the model-picker browser check: no Chrome or Chromium found."
    exit 0
  fi
fi

dsh_bin="${DSH_BIN:-config/dsh-runtime/node_modules/.bin/dsh}"
[ -x "$dsh_bin" ] || { echo "Missing $dsh_bin; run: npm ci --prefix config/dsh-runtime" >&2; exit 1; }
[ -f apps/remote-web/dist/index.html ] || { echo "The phone page is not built; run: npm run build" >&2; exit 1; }

home="$(mktemp -d)"; dsh_home="$(mktemp -d)"; logs="$(mktemp -d)"
dsh_port="${DSH_PORT:-3213}"; daemon_port="${DAEMON_PORT:-19901}"
pids=()
cleanup() {
  for pid in ${pids[@]+"${pids[@]}"}; do kill "$pid" 2>/dev/null || true; done
  sleep 1
  for pid in ${pids[@]+"${pids[@]}"}; do kill -9 "$pid" 2>/dev/null || true; done
  rm -rf "$home" "$dsh_home" "$logs"
}
trap cleanup EXIT

echo "Starting an isolated DSH host on 127.0.0.1:$dsh_port"
DSH_HOME="$dsh_home" DO_NOT_TRACK=1 "$dsh_bin" --patch config/dsh-deepseek.patch.yml --profile web --no-open --host 127.0.0.1 --port "$dsh_port" > "$logs/dsh.log" 2>&1 &
pids+=($!)

# The Host prints its authenticated launch URL once it is listening.
url=""
for _ in $(seq 1 90); do
  url="$(grep -o "http://127.0.0.1:$dsh_port/?token=[^[:space:])]*" "$logs/dsh.log" | head -1 || true)"
  if [ -n "$url" ]; then break; fi
  sleep 1
done
if [ -z "$url" ]; then echo "DSH did not print a launch URL:" >&2; tail -20 "$logs/dsh.log" >&2; exit 1; fi

echo "Starting the Turnwire daemon on 127.0.0.1:$daemon_port"
TURNWIRE_STATE_HOME="$home/state" TURNWIRE_CONFIG_HOME="$home" TURNWIRE_DATA_HOME="$home/data" TURNWIRE_CACHE_HOME="$home/cache" TURNWIRE_RUNTIME=dsh TURNWIRE_DSH_URL="$url" TURNWIRE_PORT="$daemon_port" \
  ./node_modules/.bin/tsx apps/daemon/src/main.ts > "$logs/daemon.log" 2>&1 &
pids+=($!)

# The daemon publishes client.json once its server is listening.
for _ in $(seq 1 90); do
  if [ -f "$home/client.json" ]; then break; fi
  sleep 1
done
if [ ! -f "$home/client.json" ]; then echo "The daemon did not publish client.json:" >&2; tail -20 "$logs/daemon.log" >&2; exit 1; fi

echo "Running the browser check (browser: ${found:-forced})"
TURNWIRE_CONFIG_HOME="$home" node scripts/ui-model-check.mjs
