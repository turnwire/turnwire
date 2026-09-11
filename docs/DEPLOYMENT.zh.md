[English](DEPLOYMENT.md) · 中文

# 自托管 Relay + PWA

## 国内网络

Cloudflare 不能作为国内网络必然可用的依赖。[官方中国网络文档](https://developers.cloudflare.com/china-network/)说明境外节点可能带来明显的延迟和可靠性问题；China Network 是 Enterprise 的单独订阅服务。[Quick Tunnels 文档](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)明确不提供 SLA 或 uptime 保证。因此，Turnwire 将其作为可选临时体验方式，国内实际可用性取决于用户网络，不能由一次开发机测试推断。

长期使用建议将自托管 Relay 放在 Mac 和手机均实测可达的服务器上，使用受信任的 HTTPS 域名或 IP 证书。分别验证组件下载、Mac 到服务的连接，以及手机网络的 DNS、HTTPS 和 WSS；Mac 显示通道已连接，并不能证明手机端链路畅通。固定 Relay 可以直接运行，完全不依赖 Cloudflare。Turnwire 不会自动修改系统 DNS 或悄悄切换服务。

## 临时跨网络体验

打开「远程控制」→「临时隧道」，先选隧道服务，再点击「开启临时访问」。CLI/TUI 提供相同选择，daemon 统一管理仅监听本机的 Relay、手机页面和隧道子进程。

| 服务 | 首次配置与限制 |
| --- | --- |
| localhost.run | 使用 macOS 自带 SSH，匿名连接无需账号，也不使用用户 SSH 密钥。免费服务有限速，地址可能变化；见[官方免费隧道说明](https://localhost.run/docs/)和 [CLI 文档](https://localhost.run/docs/cli/) |
| cpolar | 注册账号后在原生 SecureField 或终端隐藏输入中填写 Auth Token，之后可留空复用。连接国内 `cn` 区域；免费版随机域名、有限速，不能保证任何运营商下的实际速度。见[官方文档](https://www.cpolar.com/docs) |
| Cloudflare | 免账号 Quick Tunnel，首次下载官方组件并校验 SHA-256；国内可达性取决于网络 |

cpolar 首次在 macOS 自动下载官方 3.3.18 组件，按官方 Homebrew formula 的 SHA-256 校验，保存至 `TURNWIRE_HOME/tools`。也可通过 PATH 或 `TURNWIRE_CPOLAR_PATH` 使用已安装的 cpolar；其他系统需自行安装组件。Token 保存在 daemon 私有状态，子进程通过临时 0600 配置文件读取，停止后删除；不通过命令行参数传递。CLI 从 `TURNWIRE_CPOLAR_AUTH_TOKEN` 读取首次凭据，`turnwire remote` / `turnwire tui` 可以直接隐藏输入，无需把 Token 写入 shell 历史。

Cloudflare 可复用 PATH 中的 cloudflared，或用 `TURNWIRE_CLOUDFLARED_PATH` 指定。localhost.run 使用独立的 `known_hosts` 文件，首次记录主机密钥、后续检查变更，不修改用户 SSH 配置。启动可取消，关闭远程访问会清理 daemon 管理的隧道和 Relay。

通道就绪后生成二维码，用手机浏览器扫码。CLI 对应：

```bash
turnwire remote temporary --provider localhost-run
turnwire remote temporary --provider cpolar
turnwire remote temporary --provider cloudflare
turnwire remote status --watch
turnwire devices list --watch
turnwire remote off
```

“通道已就绪”不代表手机已经连上。“已配对”仅表示已授权该设备。手机顶部收到 Mac 的加密往返回应后显示「已连接到 Mac」、最近确认时间和延迟，并每 10 秒检测；8 秒没有回应会退出已连接状态并重连，回到前台也会重新检测。Mac 的已配对设备列表每 2 秒刷新，收到手机对新挑战的确认后才显示在线；超过 25 秒没有确认就变为离线。连接状态反映最近一次检测，不能保证休眠、锁屏或未来网络始终可用。

以下 Cloudflare 手动方式仍可用于独立运维和调试：

本地 Relay 可以通过 `TURNWIRE_REMOTE_WEB_ROOT` 同时提供构建后的手机页面。先 `npm run build`，在配置好随机 `TURNWIRE_RELAY_TOKEN` 的终端运行：

```bash
TURNWIRE_REMOTE_WEB_ROOT="$PWD/apps/remote-web/dist" npm run dev:relay
# 另开终端，需要先安装官方 cloudflared：
cloudflared tunnel --url http://127.0.0.1:9899
```

取隧道输出的 HTTPS 地址，在启动 Mac daemon 的环境中设置 `TURNWIRE_REMOTE_URL=https://实际隧道域名`、`TURNWIRE_RELAY_URL=wss://实际隧道域名/relay` 和相同的 `TURNWIRE_RELAY_TOKEN`，并保留 DSH 连接参数。确认会话空闲后重启 daemon，在原生客户端「远程控制」生成手机配对链接。手机使用蜂窝网络打开链接，即可接续同一会话、发送消息和审批。

隧道指向 9899 的 Relay 静态入口；本机 daemon 9898 和 DSH 3080 保持仅本机可达。静态入口不提供 daemon RPC、设备管理接口、配置文件或源码映射。临时隧道关闭后入口失效，重新创建可能更换域名；更新 daemon 配置并重新配对。此方式适合开发体验，[Cloudflare Quick Tunnels 文档](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)说明其不保证可用性。

## 一键部署固定 Relay

CLI、TUI 和原生 macOS 客户端现在提供同一套部署能力。服务器地址、SSH 账号和密钥路径全部来自私有运行时配置，支持 IP 或域名的 HTTPS 入口。详见 [一键部署与运维](RELAY-INSTALL.zh.md)。

## 固定域名部署

需要一台公网服务器、Docker Compose 和指向服务器的域名。服务器只运行 Relay 与静态 PWA；Mac 上的 `turnwire-host` 和 DSH 保持本地运行。下面是可审阅的配置，仓库不会自动部署任何外部服务。

在服务器复制仓库，设置域名和随机的 Relay 主机认证密钥：

```bash
export TURNWIRE_DOMAIN=turnwire.example.com
export TURNWIRE_RELAY_TOKEN="$(openssl rand -hex 32)"
docker compose -f deploy/compose.yaml up -d --build
```

生产中请通过服务器的受控环境文件或 secret 管理保留该值。Caddy 自动申请 HTTPS 证书，服务器需开放 80/443。`/relay` 代理到私有 Relay，其他路径提供 PWA。主机认证密钥只配置在服务器和 Mac，不能放进 Vite 环境变量、网页源码或发给手机。

Mac：

推荐在原生客户端「远程控制」→「自托管 Relay」填写上面的 HTTPS 域名和服务器密钥，点击「保存并连接」。无需重启 daemon 或 DSH。相同服务器已保存密钥时可以留空；更换服务器必须重新输入其密钥。CLI 可在设置 `TURNWIRE_RELAY_TOKEN` 的终端执行 `turnwire remote relay https://turnwire.example.com`。

旧的环境变量启动方式仍兼容：

```bash
export TURNWIRE_RELAY_URL=wss://turnwire.example.com/relay
export TURNWIRE_REMOTE_URL=https://turnwire.example.com
export TURNWIRE_RELAY_TOKEN='COPY_THE_SERVER_SECRET_HERE'
export TURNWIRE_DSH_URL='http://127.0.0.1:3080/?token=YOUR_DSH_LAUNCH_TOKEN'
npm run dev
```

打开原生 Turnwire 的「远程控制」生成配对码，或运行：

```bash
npm run turnwire -- devices pair --name 我的手机
```

在手机打开 `https://turnwire.example.com`，粘贴配对码。需要主屏幕图标时通过浏览器「添加到主屏幕」。配对链接中的 fragment 含密钥，不要转发、提交到代码仓库或粘贴到公开渠道。

撤销：`turnwire devices revoke DEVICE_ID`。修改设备列表会重连主机 Relay 通道，其他设备短暂重连。Mac 离线时 Relay 不缓存命令；Mac 恢复在线后客户端自动重连并补回事件。

选择的模式和自托管连接密钥保存于 daemon 的私有 SQLite 状态中（文件权限 0600），密钥不会回传到状态接口或手机。应用/CLI 保存的设置优先于启动环境变量；明确关闭后，daemon 重启也保持关闭。自托管模式重启后恢复固定地址，临时模式重启后创建新地址。切换模式不重启 Core 或 DSH；旧地址的手机需要重新生成配对链接。

备份整个 `TURNWIRE_HOME`，包括 SQLite WAL 配套文件；建议停止 daemon 后备份，或使用 SQLite 在线备份工具。该目录包含连接凭据。不要单独拷贝正在写入的 `state.db`。这版没有自动事件归档或无限历史的磁盘配额管理，部署者应监控磁盘使用。

常驻 Mac 服务可由 launchd 管理 `node /absolute/path/turnwire/apps/daemon/dist/main.js`，并通过 `EnvironmentVariables` 配置 `TURNWIRE_HOME` 和 runtime/Relay 参数。原生 App 本身不托管 daemon，因此窗口关闭不会杀死任务。Mac 必须保持唤醒且联网；软件无法让已休眠或断电的 Mac 继续执行。

`Dockerfile` 和 Compose 配置已提供，Docker 方式仍未实际验证；已经验证的服务器使用 systemd 直接运行，其正式 IP 证书和公网加密链路已验证，外网 iPhone 访问和真实 DSH 模型任务仍需在目标环境中验收。

## Linux 无头主机与 TUI

无头主机运行与桌面安装相同的 DSH 适配器、daemon、CLI/TUI 和加密远程控制协议。新安装目录保留 `apps`、`packages` 及源码配置，外部配置/状态/运行时/缓存使用 [XDG 目录](XDG.zh.md)。已有源码目录内的 `state`、`dsh-state`、`runtime` 及私有配置保持兼容，不自动迁移。复制之前先构建发布产物。`scripts/install-linux-host.sh` 安装经校验和验证的 Node 运行时、锁定后的生产依赖，以及由 `config/dsh-runtime` 固定的 DSH 运行时，然后注册用户服务。不要把 macOS 上平台相关的 `node_modules` 复制到 Linux。

首次推荐使用 `bash scripts/start-host.sh` 配置凭据。手动新安装时，把 DSH 环境映射放进 XDG Turnwire 配置目录的 `dsh.env.json`，权限 0600（旧安装仍使用 `config/dsh.env.json`）；其中包含 `TURNWIRE_HARNESS_DEEPSEEK_API_KEY` 环境变量。该私有文件在目标机器上提供，绝不包含在发布归档中。受管启动器只把它的值传给 DSH。Turnwire 收到的是短期有效的本机回环 DSH 连接 URL；模型值和 URL token 会从服务日志中脱敏。

在安装目录中运行：

```sh
bash scripts/install-linux-host.sh "$PWD"
bin/turnwire tui
```

安装器为当前用户生成可执行包装脚本和 `turnwire-host.service`，所有路径都从提供的目录推导。服务在回环地址上启动 DSH，等待其带认证的启动 URL，然后启动 Turnwire。子进程失败会触发受监管的重启；关闭时先排空 Turnwire 再关闭 DSH。使用 `systemctl --user status turnwire-host`、`restart turnwire-host` 或 `journalctl --user -u turnwire-host` 管理它。启用 lingering 可在没有 SSH 登录时开机启动。退出 TUI 或 SSH 后主机服务仍在运行。

使用 `bin/turnwire remote` 选择已有的 Relay，再用 `bin/turnwire devices pair --name phone --qr` 配对手机。每台主机有自己的身份、会话和配对；为另一台主机做的配对不会自动切换。本机 daemon/DSH 端口保持在回环地址上，远程访问通过加密 Relay。需要使用不同布局时，通用受管启动器还接受 `TURNWIRE_INSTALL_DIR`、`TURNWIRE_HOME`、`TURNWIRE_DSH_HOME`、`TURNWIRE_DSH_ENTRY`、`TURNWIRE_DSH_ENV_FILE` 和 `TURNWIRE_DSH_PORT`。

## Remote v2、通知和局域网直连

更新顺序是 Relay → 主机 daemon → 客户端。新版 Relay 兼容旧主机；新版主机注册增加连接标识隔离，需要先更新 Relay。保留既有私有部署配置，执行原来的一键部署命令即可更新。已有配对继续使用旧加密，选择 `turnwire devices upgrade <id> --qr` 或 macOS「已配对设备 → 重新配对」时才替换凭据。新二维码有效期 15 分钟，只能登记一次。

一键部署自动创建 `${installDir}/state/push.db`，由配置中的服务账号独占，持久保存 VAPID 密钥和通知队列；更新 release 不删除该文件。手工运行 Relay 时设置 `TURNWIRE_PUSH_DB`（私有 SQLite 路径）及 `TURNWIRE_VAPID_SUBJECT`（运营者的 HTTPS 地址或 mailto 联系地址）。不开这两个变量时仅关闭推送能力，Relay 转发仍可用。推送出口使用标准 HTTPS；无需 Apple 开发者会员或 Firebase 项目。

主机用 `turnwire notifications on/off/status` 管理通知；TUI 与原生客户端有相同表单。手机在收件箱点击「启用通知并记住设备」。iPhone 先添加到主屏幕再授权。只有固定入口适合长期通知；临时隧道换域名后不能继承原站点的浏览器订阅。通知只含待办提示，点击后重新验证主机并读取当前收件箱。主机休眠不会被 Web Push 唤醒。

局域网入口默认关闭。`turnwire remote direct` 打开表单，或 `turnwire remote direct configure --config "$TURNWIRE_DIRECT_CONFIG"` 读取私有配置。原生 macOS 入口为「远程控制 → 局域网直连」。示例配置（须替换成自己的域名和证书路径）：

```json
{"enabled":true,"url":"wss://host.example.com:9443/remote","listenHost":"0.0.0.0","port":9443,"certificatePath":"/absolute/path/fullchain.pem","privateKeyPath":"/absolute/path/privkey.pem"}
```

该域名须在手机网络解析到主机 LAN 地址，证书须被手机浏览器信任，并允许浏览器访问局域网。接口候选 IP 会显示在主机表单中，不自动把管理端口暴露到 LAN。不提供自签证书绕过或 HTTPS 页面的不安全 WS 降级。证书更换后重新保存直连配置以加载新文件。配置有效时，已登记手机会保存加密下发的直连候选并在下次连接中与 Relay 竞速。来宾 Wi-Fi 隔离、VPN 和实际 iPhone 权限需要按部署环境验证。
