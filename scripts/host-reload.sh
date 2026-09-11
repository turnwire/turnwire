#!/usr/bin/env bash
# Developer-only frontend publication. Backend/DSH changes always require an operator.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "refusing: not a git checkout" >&2; exit 1; }
[ "${TURNWIRE_DEV_UNIT:-turnwire-dev.service}" = turnwire-dev.service ] || { echo "refusing: development checkout only" >&2; exit 1; }
[ -f apps/daemon/src/host-service.ts ] || { echo "refusing: not a Turnwire checkout" >&2; exit 1; }
mkdir -p .turnwire
# Hold through build, publication, health verification and stamp. No service-control commands.
exec 9>.turnwire/reload.lock
flock -x 9
exec node "$root/scripts/host-reload.mjs" "$@"
