import { isIP } from 'node:net';
import type { DeploymentConfig } from '../../../packages/protocol/src/deployment.js';
import { publicURL, shellQuote, NODE_VERSION } from './config.js';

export function caddySite(c: DeploymentConfig, tls: boolean) {
  return `${publicURL(c, 'http')} {
    handle /.well-known/acme-challenge/* {
        root * ${c.acmeWebroot}
        file_server
    }
    handle {
        ${tls ? `redir ${publicURL(c)}{uri} 308` : 'respond "Turnwire Relay deployment in progress" 503'}
    }
}
${tls ? `\n${publicURL(c)} {
    tls ${c.configDir}/tls/fullchain.pem ${c.configDir}/tls/privkey.pem
    encode zstd gzip
    reverse_proxy 127.0.0.1:${c.relayPort}
}\n` : ''}`;
}

// Preserve all existing sites. Only insert the managed import and (for IP TLS) one global option.
export function mergeCaddy(original: string, c: DeploymentConfig, siteFile: string) {
  let text = original;
  if (isIP(c.publicAddress)) {
    const existing = text.match(/^\s*default_sni\s+([^\s#]+)/m);
    if (existing && existing[1] !== c.publicAddress) throw new Error('Caddy 已有不同的 default_sni；请使用域名入口，或先协调现有 IP 站点配置');
    if (!existing) {
      const first = /^(?:\s|#[^\n]*(?:\n|$))*/.exec(text)![0].length;
      if (text[first] === '{') text = text.slice(0, first + 1) + `\n    default_sni ${c.publicAddress}\n` + text.slice(first + 1);
      else text = `{\n    default_sni ${c.publicAddress}\n}\n\n` + text;
    }
  }
  const directive = `import ${siteFile}`;
  if (!text.split('\n').some(line => line.trim() === directive)) text = text.trimEnd() + '\n\n' + directive + '\n';
  return text;
}
export function relayService(c: DeploymentConfig) {
  return `[Unit]
Description=Turnwire encrypted Relay and phone web app
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=${c.serviceUser}
Group=${c.serviceUser}
WorkingDirectory=${c.installDir}/current
EnvironmentFile=${c.configDir}/relay.env
ExecStart=${c.installDir}/runtime/bin/node ${c.installDir}/current/relay.mjs
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${c.installDir}/state
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
UMask=0077
MemoryMax=256M
TasksMax=64
[Install]
WantedBy=multi-user.target
`;
}
export function renewHook(c: DeploymentConfig) {
  return `#!/bin/sh
set -eu
lineage=${shellQuote(c.configDir + '/acme/live/' + c.certName)}
[ "\${RENEWED_LINEAGE:-$lineage}" = "$lineage" ] || exit 0
openssl x509 -in "$lineage/cert.pem" -noout ${isIP(c.publicAddress) ? '-checkip' : '-checkhost'} ${shellQuote(c.publicAddress)}
install -d -m 0750 -o root -g ${shellQuote(c.caddyGroup)} ${shellQuote(c.configDir + '/tls')}
install -m 0644 -o root -g ${shellQuote(c.caddyGroup)} "$lineage/fullchain.pem" ${shellQuote(c.configDir + '/tls/fullchain.pem.next')}
install -m 0640 -o root -g ${shellQuote(c.caddyGroup)} "$lineage/privkey.pem" ${shellQuote(c.configDir + '/tls/privkey.pem.next')}
mv ${shellQuote(c.configDir + '/tls/fullchain.pem.next')} ${shellQuote(c.configDir + '/tls/fullchain.pem')}
mv ${shellQuote(c.configDir + '/tls/privkey.pem.next')} ${shellQuote(c.configDir + '/tls/privkey.pem')}
caddy validate --config ${shellQuote(c.caddyfile)}
systemctl reload ${shellQuote(c.caddyService)}
`;
}
export function renewService(c: DeploymentConfig) {
  return `[Unit]
Description=Renew Turnwire Relay HTTPS certificate
After=network-online.target ${c.caddyService}.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=${c.certbotDir}/bin/certbot renew --config-dir ${c.configDir}/acme --work-dir ${c.installDir}/certbot-work --logs-dir ${c.installDir}/certbot-logs --quiet --deploy-hook ${c.configDir}/renew-hook
UMask=0077
`;
}
export const renewTimer = `[Unit]
Description=Check Turnwire Relay certificate renewal hourly
[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true
[Install]
WantedBy=timers.target
`;

export function bootstrap(c: DeploymentConfig, stage: string) {
  return `#!/bin/sh
set -eu
umask 077
cd ${shellQuote(stage)}
exec 9>/run/lock/turnwire-relay-deploy.lock
flock -n 9 || { echo 'Another Turnwire deployment is running' >&2; exit 1; }
. /etc/os-release
case "$ID" in debian|ubuntu) ;; *) echo 'One-click deployment supports Debian/Ubuntu with systemd' >&2; exit 1 ;; esac
[ -d /run/systemd/system ] || { echo 'systemd is required' >&2; exit 1; }
echo '{"step":"检查系统和安装依赖"}'
missing=''
for tool in curl xz sha256sum python3; do command -v "$tool" >/dev/null 2>&1 || missing=yes; done
if [ -n "$missing" ]; then
  apt-get update -qq >bootstrap.log 2>&1
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl xz-utils python3 python3-venv >>bootstrap.log 2>&1
fi
node=${shellQuote(c.installDir + '/runtime/bin/node')}
if [ ! -x "$node" ]; then
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo 'Unsupported CPU architecture' >&2; exit 1 ;; esac
  name="node-v${NODE_VERSION}-linux-$arch"
  curl --fail --location --silent --show-error --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o SHASUMS256.txt
  curl --fail --location --silent --show-error --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/$name.tar.xz" -o "$name.tar.xz"
  awk -v file="$name.tar.xz" '$2 == file { print }' SHASUMS256.txt > checksum.txt
  [ -s checksum.txt ] && sha256sum -c checksum.txt >>bootstrap.log 2>&1
  tar -xJf "$name.tar.xz" "$name/bin/node"
  install -d -m 0755 ${shellQuote(c.installDir + '/runtime/bin')}
  install -m 0755 "$name/bin/node" "$node"
fi
"$node" --input-type=module -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<13))process.exit(1)'
exec "$node" installer.mjs config.json
`;
}
