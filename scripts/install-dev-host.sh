#!/usr/bin/env bash
# Installs the developer-only systemd units that run this checkout as a host.
#
# This is separate from `scripts/install-host-service.mjs`, which installs the release host from
# a built release tree. The installer never creates these units, so following the documented
# install path cannot give a user a self-updating host. The units are named `turnwire-dev-*` so
# they can never be confused with, or restart, `turnwire-host.service`.
#
# Usage: scripts/install-dev-host.sh --state DIR --dsh-home DIR [--enable-watch]
#   --state     state directory to reuse (holds devices, relay preferences and history)
#   --dsh-home  DSH home to reuse (holds the session log the sessions refer to)
#   --enable-watch  also enable automatic reload on source change; off by default
set -euo pipefail

root=$(cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
state=""; dsh_home=""; watch="no"
while [ $# -gt 0 ]; do
  case "$1" in
    --state) state="${2:?}"; shift 2 ;;
    --dsh-home) dsh_home="${2:?}"; shift 2 ;;
    --enable-watch) watch="yes"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
[ -n "$state" ] && [ -n "$dsh_home" ] || { echo "both --state and --dsh-home are required" >&2; exit 1; }
git -C "$root" rev-parse --git-dir >/dev/null 2>&1 || { echo "refusing: $root is not a git working tree" >&2; exit 1; }
[ -x config/dsh-runtime/node_modules/.bin/dsh ] || { echo "run first: npm ci --prefix config/dsh-runtime" >&2; exit 1; }
source "$root/scripts/host-paths.sh"
export TURNWIRE_STATE_HOME=$state TURNWIRE_DSH_HOME=$dsh_home
turnwire_resolve_paths
[ -f "$TURNWIRE_DSH_ENV_FILE" ] || { echo "create $TURNWIRE_DSH_ENV_FILE with the DSH environment first (mode 0600)" >&2; exit 1; }
[ -f apps/daemon/dist/host-service.mjs ] || { echo "run first: npm run build" >&2; exit 1; }

node=$(command -v node)
units="$TURNWIRE_UNITS_DIR"; mkdir -p "$units"
mkdir -p "$state" "$dsh_home"; chmod 700 "$state" "$dsh_home"

cat > "$units/turnwire-dev.service" <<UNIT
[Unit]
Description=Turnwire development host (runs the checked-out source)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$root
Environment=TURNWIRE_INSTALL_DIR=$root
Environment=TURNWIRE_STATE_HOME=$state
Environment=TURNWIRE_CONFIG_HOME=$TURNWIRE_CONFIG_HOME
Environment=TURNWIRE_DATA_HOME=$TURNWIRE_DATA_HOME
Environment=TURNWIRE_CACHE_HOME=$TURNWIRE_CACHE_HOME
Environment=TURNWIRE_DSH_HOME=$dsh_home
Environment=TURNWIRE_DSH_ENTRY=$root/config/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js
Environment=TURNWIRE_DAEMON_ENTRY=$root/apps/daemon/dist/main.js
Environment=TURNWIRE_DSH_ENV_FILE=$TURNWIRE_DSH_ENV_FILE
Environment=PATH=$(dirname "$node"):/usr/local/bin:/usr/bin:/bin
ExecStart=$node $root/apps/daemon/dist/host-service.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=mixed
UMask=0077

[Install]
WantedBy=default.target
UNIT
chmod 600 "$units/turnwire-dev.service"

cat > "$units/turnwire-dev-reload.path" <<UNIT
[Unit]
Description=Watch this checkout for source changes
[Path]
PathChanged=$root/apps
PathChanged=$root/packages
PathChanged=$root/scripts
[Install]
WantedBy=default.target
UNIT
chmod 600 "$units/turnwire-dev-reload.path"

cat > "$units/turnwire-dev-reload.service" <<UNIT
[Unit]
Description=Publish changed frontend assets (backend updates require operator)
[Service]
Type=oneshot
Environment=TURNWIRE_STATE_HOME=$state
Environment=TURNWIRE_CONFIG_HOME=$TURNWIRE_CONFIG_HOME
Environment=TURNWIRE_DATA_HOME=$TURNWIRE_DATA_HOME
Environment=TURNWIRE_CACHE_HOME=$TURNWIRE_CACHE_HOME
ExecStart=$root/scripts/host-reload.sh
UNIT
chmod 600 "$units/turnwire-dev-reload.service"

# Path watches are not recursive; the timer also catches nested edits.
cat > "$units/turnwire-dev-reload.timer" <<UNIT
[Unit]
Description=Check frontend content for development asset publication
[Timer]
OnBootSec=2min
OnUnitInactiveSec=30s
Unit=turnwire-dev-reload.service
[Install]
WantedBy=timers.target
UNIT
chmod 600 "$units/turnwire-dev-reload.timer"
systemctl --user daemon-reload
# Always stop both triggers, including a timer left over from an older install.
systemctl --user disable --now turnwire-dev-reload.timer turnwire-dev-reload.path
systemctl --user stop turnwire-dev-reload.service
if [ "$watch" = "yes" ]; then
  systemctl --user enable --now turnwire-dev-reload.timer turnwire-dev-reload.path
  echo "automatic frontend publication: enabled; backend and DSH remain manual"
else
  echo "automatic frontend publication: disabled (timer and path stopped)"
fi
echo "Wrote development host, reload service, timer and path units."
echo "The host was not started or restarted. --enable-watch starts only the reload triggers."
