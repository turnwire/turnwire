[English](RELAY-INSTALL.md) · 中文

# 一键部署 Relay

Turnwire 的部署服务统一运行在 daemon 中。CLI、TUI 和原生 macOS 表单提交同一个本地管理请求；窗口或终端关闭后任务继续。服务器安装逻辑在 `apps/deployer`，部署状态与私有设置由 `apps/daemon/src/deployment.ts` 管理。配对手机不能调用该管理接口。

## 环境

服务器支持 Debian / Ubuntu、systemd，以及 x86_64 或 arm64。SSH 账号需具有管理员权限，或可以使用 `sudo -n`；使用私钥或已解锁的 SSH agent，不收集账号密码。手机入口使用服务器公网 IP 或已解析到该服务器的域名。公网 TCP 80/443 必须可达，服务器需要能下载官方 Node、系统软件包和 Certbot。

已有 Caddy 时保留其他站点，只增加 Turnwire 站点并验证后重载。其他服务占用 80/443、已有冲突的 IP TLS 设置、不同实例占用端口时会返回具体错误，避免覆盖现有服务。目前每台服务器由安装器管理一个 Turnwire Relay 实例。

首次使用源码构建，需要 `npm ci`、`npm run build` 并启动新版 daemon。Node、手机页面及服务器安装器的独立产物随构建生成；部署时服务器不需要源码、npm 或 `node_modules`。部署参数全部来自运行时配置，没有内置服务器地址、SSH 账号或私钥。

## 三种入口

**macOS**：「远程控制」→「自托管 Relay」→「一键部署 / 更新服务器」。填写 SSH 地址、登录账号、私钥文件或 agent、手机入口，可展开高级配置，也可导入私有 JSON。点击「一键部署」后显示共享进度。成功后默认自动连接本机，再生成手机配对二维码。

**CLI**：运行 `turnwire deploy` 打开交互表单，或者使用配置文件：

```sh
npm run deploy:relay -- --config "$TURNWIRE_DEPLOY_CONFIG"
# 已安装 CLI 时：
turnwire deploy --config "$TURNWIRE_DEPLOY_CONFIG"
turnwire deploy --status
```

`TURNWIRE_DEPLOY_CONFIG` 指向用户自己的 JSON 文件。使用 `--no-wait` 立即返回；稍后用 `deploy --status` 查看。默认等待完成，Ctrl+C 仅退出进度查看。`--json` 只返回结构化状态，不返回服务器连接密钥。

**TUI**：`turnwire tui` 中输入 `deploy`，或在 `remote` 菜单选择「一键部署服务器」。与 CLI 相同，也支持 `deploy --config ...`。

## 私有配置

以 `deploy/relay.example.json` 为格式参考，把示例地址与账号替换成自己的值，保存到仓库之外。仓库忽略 `*.deploy.local.json`、`.turnwire/` 和私钥 `.pem` 文件。建议配置文件权限为 0600。`host`、`sshUser` 和 `publicAddress` 必填，没有内置默认值。

| 字段 | 含义 / 默认 |
| --- | --- |
| `host` | SSH IP 或完整域名，不含协议 |
| `sshUser` | SSH 登录账号，必须填写 |
| `sshPort` | SSH 端口，默认 22 |
| `identityFile` | daemon 所在机器上的私钥绝对路径；省略则使用 SSH agent |
| `publicAddress` | 手机使用的 IP 或完整域名，不含协议、端口和路径 |
| `email` | 可选的证书通知邮箱 |
| `connectAfterDeploy` | 成功后配置本机连接，默认 true |
| `relayPort` | 服务器 loopback 端口，默认 9899，不暴露公网 |
| `serviceUser` | Relay 系统账号，默认 `turnwire-relay`，不能是 root |
| `installDir` | 安装目录，默认 `/opt/turnwire-relay` |
| `configDir` | 私有配置目录，默认 `/etc/turnwire-relay` |
| `caddyfile` | 共享配置文件，默认 `/etc/caddy/Caddyfile` |
| `caddyService` / `caddyGroup` | Caddy 服务名称及证书读取组，默认 `caddy` |
| `certbotDir` | 独立 Certbot 目录，默认 `/opt/turnwire-certbot` |
| `certName` | 证书名称，默认 `turnwire-relay`；接管旧部署时沿用原名 |
| `acmeWebroot` | 公网证书验证目录，默认 `/var/lib/turnwire-acme` |

上述目录、端口及服务账号是可覆盖的产品默认值，不包含用户机器信息。已管理实例再次部署时保留其入口、目录、端口、服务账号和证书名称；迁移这些资源不属于原地更新。

## 自动执行的工作

1. 验证配置、SSH 身份、权限、系统类型、CPU 和端口；首次记录 SSH 主机指纹，后续检查变更。
2. 打包 Relay 与 PWA，排除源码映射，上传后逐文件验证 SHA-256。
3. 安装经官方校验文件验证的独立 Node，以及 Caddy、独立 Certbot。已有可用组件复用。
4. 首次在服务器生成随机 Relay 密钥；更新复用原值。写入 root 所有的 0600 环境文件。
5. 通过 HTTP webroot 验证入口、测试签发再申请正式 HTTPS 证书。IP 使用短期证书；已有仍有效的证书复用。
6. 在新发布目录安装服务，验证 Caddy 配置后切换当前版本，启用开机启动、故障重启与每小时证书续期检查。
7. 验证服务器和本机的公网 HTTPS；默认自动保存本机 Relay 设置并确认主机注册。

密钥文件只临时复制到 daemon 的私有任务目录，结束后删除，不上传 SSH 私钥。Relay 密钥只在服务器与 daemon 间传递，不写入网页、命令行参数、部署状态或日志。模型环境变量不会传给 SSH、打包或服务器安装进程。机器配置和部署状态保存在 daemon 的私有 SQLite；SSH `known_hosts` 位于 `TURNWIRE_STATE_HOME/deployments/`（默认 `~/.local/state/turnwire/deployments/`；见 [XDG 目录规则](XDG.zh.md)）。

IP 证书需要自动续期；参见 [Let's Encrypt 的 Certbot 指南](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)。安装器配置小时计时器和证书部署钩子。Caddy 的 IP 默认 SNI 配置参见[官方文档](https://caddyserver.com/docs/caddyfile/options#default-sni)。

## 更新、诊断与恢复

使用同一配置再次点击部署，或重复同一条命令。安装器保留凭据与有效证书，生成新发布目录并保存上一个版本。更新服务会使手机短暂重连，Mac 的 Core 和 DSH 不因此重启。

安装中发生错误会恢复本次修改的服务/站点文件及原发布链接。系统依赖、已签发证书和诊断记录保留。网络中断或 daemon 退出时，不能仅凭本机错误判断服务器状态；界面会标记中断，可先检查服务器，再使用同一配置重试。

服务器部署目录中的 `install.log` 仅管理员可读；失败状态会显示诊断目录。常用运维命令：

```sh
systemctl status turnwire-relay --no-pager
systemctl list-timers turnwire-certbot-renew.timer --no-pager
journalctl -u turnwire-relay -n 50 --no-pager
journalctl -u turnwire-certbot-renew -n 50 --no-pager
```

生效版本、上一版本和服务器配置记录在 `configDir/deployment.json`。回滚可将 `installDir/current` 原子指回上一版本并重启 `turnwire-relay`；站点配置备份位于 `configDir/backups/`，恢复时保留部署后新增的其他站点。不要停止共享 Caddy。

部署完成和 Mac 注册不等于实际手机已连接。手机扫码后必须看到「已连接到 Mac」，Mac 设备列表也应显示最近确认时间。实际 iPhone、蜂窝网络和不同运营商仍需各自验收。

## Web Push 持久状态

新版安装器创建 `${installDir}/state`（0700、服务账号所有），并给 systemd 只增加此目录的写权限。环境文件自动设置 `TURNWIRE_PUSH_DB=${installDir}/state/push.db`、`TURNWIRE_VAPID_SUBJECT` 为配置的公网 HTTPS 地址。首次启动生成 VAPID 密钥；原地更新保留数据库，避免使手机订阅失效。备份此目录时按凭据文件保护。当前 v2 契约内的更新不替换有效的 v2 设备凭据。这不代表兼容旧主机、旧设备凭据或旧配对格式：所有参与方必须使用当前 v2 契约，设备通过新 v2 配对登记，不使用升级命令或 PUT 替换。主机 Store 拒绝旧库，不提供迁移。替换主机之前，分别备份解析后的 Turnwire config、state 目录及 DSH 状态/附件；Relay 推送数据库不是主机备份。见[维护指南](FIRST-UPGRADE.zh.md)。
