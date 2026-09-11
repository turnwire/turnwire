#!/usr/bin/env bash
# Production Linux host bootstrap. Never use this to replace a development unit.
set +x
set +a
set -euo pipefail
umask 077
# Keep the credential shell-local, before running ANY subprocess (including preflight).
credential=${TURNWIRE_HARNESS_DEEPSEEK_API_KEY-}
export -n credential
unset confirmation
unset TURNWIRE_HARNESS_DEEPSEEK_API_KEY TURNWIRE_RELAY_TOKEN TURNWIRE_DSH_TOKEN TURNWIRE_DSH_URL
fail() { printf 'start-host: %s\n' "$*" >&2; exit 1; }
mode=start
case ${1-} in
  --help|-h) printf '%s\n' 'Usage: bash scripts/start-host.sh [--check|--help]' 'Start an installed production Linux user service, or build and install this checkout.' 'First run needs Linux, a non-root systemd user session, curl/tar/xz/sha256sum,' 'and outbound HTTPS to nodejs.org and the configured npm registry (including DSH access).' 'Node 22.23.2 is bootstrapped locally; no global Node/npm is required.' 'Provide TURNWIRE_HARNESS_DEEPSEEK_API_KEY or answer the hidden terminal prompt.' 'Existing private config/dsh.env.json is preserved. No remote provisioning occurs.' '--check checks local prerequisites and service ownership without writes, downloads or prompts.'; exit 0 ;;
  --check) mode=check ;;
  '') ;;
  *) fail 'Unknown argument; use --help.' ;;
esac
[[ $# -le 1 ]] || fail 'Expected at most one argument; use --help.'
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ $root =~ ^[A-Za-z0-9_./-]+$ ]] || fail 'Installation path may contain only letters, digits, underscores, dots, dashes and slashes.'
[[ $(uname -s) == Linux ]] || fail 'Production startup requires Linux with systemd; use a Linux host (not macOS).'
[[ $(id -u) != 0 ]] || fail 'Run as the non-root account that will own the systemd user service, not sudo/root.'
command -v systemctl >/dev/null || fail 'systemctl is required.'
systemctl --user show-environment >/dev/null 2>&1 || fail 'No reachable systemd user manager; log in as the host account first.'
unit=turnwire-host.service
unit_info=$(systemctl --user show "$unit" -p LoadState -p WorkingDirectory -p ExecStart) || {
  [[ $unit_info == *'LoadState=not-found'* ]] || fail 'Cannot inspect existing service; refusing to overwrite it.'
}
load= work= exec_start=
while IFS= read -r line; do
  case $line in LoadState=*) load=${line#*=} ;; WorkingDirectory=*) work=${line#*=} ;; ExecStart=*) exec_start=${line#*=} ;; esac
done <<< "$unit_info"
show_connection() {
  printf 'Service: %s\nCheck status: systemctl --user status %s\nConnect locally: %s/bin/turnwire tui\n' "$1" "$unit" "$root"
  printf '%s\n' 'Service activation is not a readiness check; if still initializing, inspect status before connecting.'
}
if [[ $load != not-found ]]; then
  [[ $load == loaded && $work == "$root" && $exec_start == *"$root/runtime/node/bin/node"* && $exec_start == *"$root/apps/daemon/dist/host-service.mjs"* ]] || fail 'Existing turnwire-host.service does not match this checkout production host (WorkingDirectory/ExecStart). Refusing to modify, stop or replace it; choose its owning checkout or resolve the conflict manually.'
  if [[ $mode == check ]]; then show_connection 'matching installation (check only)'; exit 0; fi
  if systemctl --user is-active --quiet "$unit"; then
    show_connection 'already active; nothing changed'
  else
    systemctl --user start "$unit" || fail 'Service start failed; inspect systemctl --user status turnwire-host.service.'
    show_connection 'start requested; no rebuild or reinstall'
  fi
  exit 0
fi
[[ ! -e "$HOME/.config/systemd/user/$unit" && ! -L "$HOME/.config/systemd/user/$unit" ]] || fail 'An unloaded user unit already exists; inspect it and reload systemd manually before retrying.'
[[ -f "$root/package-lock.json" && -f "$root/scripts/install-linux-host.sh" ]] || fail 'Run from a complete source checkout with package-lock.json and the Linux installer.'
[[ ! -L "$root/config" && ! -L "$root/config/dsh.env.json" ]] || fail 'Refusing a symlinked credential file or config directory.'
[[ ! -e "$root/config/dsh.env.json" || -f "$root/config/dsh.env.json" ]] || fail 'Credential path must be a regular private JSON file.'
for tool in curl tar xz sha256sum awk mktemp; do command -v "$tool" >/dev/null || fail "Required command missing: $tool"; done
case $(uname -m) in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) fail 'Supported Linux architectures are x86_64 and arm64.' ;; esac
if [[ $mode == check ]]; then
  printf '%s\n' 'Local preflight passed; no changes made. Network, npm access and credential JSON are validated on first start.'
  exit 0
fi
if [[ ! -f "$root/config/dsh.env.json" && -z $credential ]]; then
  if ! { exec 3<>/dev/tty; } 2>/dev/null; then fail 'No credential available. Set TURNWIRE_HARNESS_DEEPSEEK_API_KEY or run from a terminal to enter it privately.'; fi
  printf 'DeepSeek API key (hidden): ' >&3
  IFS= read -rs credential <&3 || fail 'Credential input cancelled.'
  printf '\nConfirm API key (hidden): ' >&3
  IFS= read -rs confirmation <&3 || fail 'Credential confirmation cancelled.'
  printf '\n' >&3
  exec 3>&-
  [[ -n $credential && $credential == "$confirmation" ]] || fail 'Credential is empty or confirmation did not match.'
  unset confirmation
fi
version=22.23.2
if [[ ! -x "$root/runtime/node/bin/node" ]]; then
  [[ ! -e "$root/runtime/node" && ! -L "$root/runtime/node" ]] || fail 'Existing runtime/node is unusable; repair it manually.'
  mkdir -p "$root/runtime"
  stage=$(mktemp -d "$root/runtime/.node-bootstrap.XXXXXX")
  trap 'rm -rf -- "$stage"' EXIT
  archive="node-v${version}-linux-${arch}.tar.xz"
  curl -fsSL --retry 2 "https://nodejs.org/dist/v${version}/SHASUMS256.txt" -o "$stage/SHASUMS256.txt"
  curl -fsSL --retry 2 "https://nodejs.org/dist/v${version}/$archive" -o "$stage/$archive"
  (cd "$stage"; awk -v name="$archive" '$2==name' SHASUMS256.txt | sha256sum --check --status) || fail 'Node checksum verification failed; nothing installed.'
  tar -xJf "$stage/$archive" -C "$stage"
  [[ ! -e "$root/runtime/node-v${version}-linux-${arch}" ]] || fail 'Node version directory already exists; inspect it before retrying.'
  mv -- "$stage/node-v${version}-linux-${arch}" "$root/runtime/"
  ln -s "node-v${version}-linux-${arch}" "$root/runtime/node"
fi
export PATH="$root/runtime/node/bin:$PATH"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22 || (a===22 && b<13)) process.exit(1)' || fail 'Managed Node must be version 22.13 or newer.'
[[ -x "$root/runtime/node/bin/npm" ]] || fail 'Managed Node installation is missing npm.'
# stdin, not argv or environment, transports the secret to the JSON encoder.
# O_EXCL and O_NOFOLLOW ensure a raced-in file cannot be overwritten.
printf '%s' "$credential" | node --input-type=module -e '
import fs from "node:fs";
const dir=process.argv[1]+"/config", file=dir+"/dsh.env.json";
try {
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error();
  if (fs.existsSync(file) || (()=>{try{return fs.lstatSync(file).isSymbolicLink()}catch{return false}})()) {
    const s=fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) || s.uid!==process.getuid()) throw new Error();
    const value=JSON.parse(fs.readFileSync(file,"utf8"));
    if (!value || typeof value!=="object" || Array.isArray(value) || Object.values(value).some(v=>typeof v!=="string") || !value.TURNWIRE_HARNESS_DEEPSEEK_API_KEY?.trim()) throw new Error();
  } else {
    const key=fs.readFileSync(0,"utf8");
    if (!key.trim()) throw new Error();
    const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    try { fs.writeFileSync(fd,JSON.stringify({TURNWIRE_HARNESS_DEEPSEEK_API_KEY:key},null,2)+"\n"); } finally {fs.closeSync(fd);}
  }
} catch { console.error("Credential configuration rejected: use an owned regular mode-600 config/dsh.env.json containing a JSON string map with a nonempty TURNWIRE_HARNESS_DEEPSEEK_API_KEY. Existing files are never overwritten."); process.exit(1); }
' "$root"
unset credential
cd -- "$root"
npm ci --no-audit --no-fund
npm run build
bash scripts/install-linux-host.sh "$root"
show_connection 'installation/start requested'
