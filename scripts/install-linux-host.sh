#!/usr/bin/env bash
# Run inside a built Turnwire release; credentials are provided separately on this host.
set -euo pipefail
umask 077
unset TURNWIRE_HARNESS_DEEPSEEK_API_KEY TURNWIRE_RELAY_TOKEN TURNWIRE_DSH_TOKEN TURNWIRE_DSH_URL
turnwire_root=$(cd -- "${1:-$(dirname -- "$0")/..}" && pwd)
source "$turnwire_root/scripts/host-paths.sh"
turnwire_resolve_paths "$turnwire_root"
[[ $(uname -s) == Linux ]] || { echo 'Linux is required' >&2; exit 1; }
[[ -f "$TURNWIRE_DSH_ENV_FILE" ]] || { echo 'Create private config/dsh.env.json with the DSH environment first' >&2; exit 1; }
[[ -f "$turnwire_root/apps/daemon/dist/host-service.mjs" ]] || { echo 'Build the Turnwire release before installing' >&2; exit 1; }
if systemctl --user is-active --quiet turnwire-host.service; then
  echo 'Host is already running. Stop turnwire-host.service after active tasks finish before reinstalling.' >&2
  exit 1
fi
for turnwire_unit_dir in "$TURNWIRE_UNITS_DIR" "$HOME/.config/systemd/user"; do
  [[ ! -e "$turnwire_unit_dir/turnwire-host.service" && ! -L "$turnwire_unit_dir/turnwire-host.service" ]] || { echo 'Existing user unit found; refusing to reinstall or overwrite it.' >&2; exit 1; }
done
turnwire_version=22.23.2
case $(uname -m) in x86_64) turnwire_arch=x64 ;; aarch64|arm64) turnwire_arch=arm64 ;; *) echo 'Unsupported CPU architecture' >&2; exit 1 ;; esac
mkdir -p "$TURNWIRE_RUNTIME_DIR/dsh" "$TURNWIRE_STATE_HOME" "$TURNWIRE_CACHE_DIR"
if [[ ! -x "$TURNWIRE_RUNTIME_DIR/node/bin/node" ]]; then
  turnwire_stage=$(mktemp -d "$TURNWIRE_CACHE_DIR/.node-bootstrap.XXXXXX")
  trap 'rm -rf "$turnwire_stage"' EXIT
  turnwire_archive="node-v${turnwire_version}-linux-${turnwire_arch}.tar.xz"
  curl -fsSL --retry 2 "https://nodejs.org/dist/v${turnwire_version}/SHASUMS256.txt" -o "$turnwire_stage/SHASUMS256.txt"
  curl -fsSL --retry 2 "https://nodejs.org/dist/v${turnwire_version}/${turnwire_archive}" -o "$turnwire_stage/$turnwire_archive"
  (cd "$turnwire_stage"; awk -v name="$turnwire_archive" '$2==name' SHASUMS256.txt | sha256sum --check --status)
  tar -xJf "$turnwire_stage/$turnwire_archive" -C "$TURNWIRE_RUNTIME_DIR"
  ln -s "node-v${turnwire_version}-linux-${turnwire_arch}" "$TURNWIRE_RUNTIME_DIR/node"
fi
export PATH="$TURNWIRE_RUNTIME_DIR/node/bin:$PATH"
cd "$turnwire_root"
npm ci --omit=dev --no-audit --no-fund
cp config/dsh-runtime/package.json config/dsh-runtime/package-lock.json "$TURNWIRE_RUNTIME_DIR/dsh/"
(cd "$TURNWIRE_RUNTIME_DIR/dsh"; npm ci --omit=dev --no-audit --no-fund)
node scripts/install-host-service.mjs "$turnwire_root"
if [[ $(loginctl show-user "$(id -un)" -p Linger --value) != yes ]]; then
  if sudo -n loginctl enable-linger "$(id -un)"; then echo 'Host starts at boot without SSH login'; else echo 'Run sudo loginctl enable-linger "$USER" to enable startup without SSH'; fi
fi
