[English](README.md) · 中文

# Turnwire

[![npm next](https://img.shields.io/npm/v/turnwire/next?label=npm%20next)](https://www.npmjs.com/package/turnwire/v/next)
[![npm latest](https://img.shields.io/npm/v/turnwire/latest?label=npm%20latest)](https://www.npmjs.com/package/turnwire/v/latest)

同一个 Agent 会话，在桌面浏览器、终端和手机上接续：**主机负责干活，手机负责随时接话和审批。**

### 它们如何协作

![Turnwire 架构：本地客户端和手机连接同一台主机，由主机保存共享状态并通过 DSH 执行任务。](docs/architecture.svg)

- **客户端：** 可使用桌面浏览器、CLI、交互终端（TUI）或手机 PWA，也可选用原生桌面客户端。各客户端访问同一台主机、共享同一份会话状态；能力覆盖与平台要求见[客户端文档](docs/CLIENTS.zh.md)。
- **远程连接：** 手机通过 Relay 或已配置的隧道连接主机。配对后的会话通信经过加密，Relay 只转发密文。
- **主机与状态：** `turnwire-host` 运行 Turnwire Core；SQLite 保存元数据、事件缓存、审批和命令回执。
- **任务执行：** Turnwire Core 通过 `AgentRuntime` 接口将任务交给 DSH。模型凭据和任务执行始终留在主机上。

## 它能给你什么

- **离开电脑也不断线**：手机上看到同一条会话的实时进度，把下一步想法发回主机；消息要么排队等当前回合结束，要么直接插话引导它。
- **审批在手机上完成**：需要放行的操作弹到手机，批准或拒绝一次有效，处理结果留在收件箱里可回查。
- **多端共享一份状态**：桌面、浏览器、终端和手机共享会话、历史、审批与模型选择，不是各记各的；各客户端尚存的功能差异见[能力覆盖](docs/CLIENTS.zh.md)。
- **模型由主机决定**：手机上也能切换会话模型与思考强度，只列出主机 runtime 真正注册的模型。
- **跑在你自己的机器上**：异地连接走临时隧道或你自己部署的 Relay；主机主动连出，不需要把 daemon 端口暴露到公网。

## 开始之前，先看这三条

诚实前置，免得你走到一半才发现：

1. **npm 预览版已发布**：[`turnwire@next`](https://www.npmjs.com/package/turnwire)，安装不需要源码仓库权限。它还不是稳定版，也不是已签名的原生桌面安装器；源码仓库仍为私有。
2. **需要一台常开的主机**。请选择符合[主机要求](docs/QUICKSTART.zh.md)的机器 —— 主机睡着，手机就连不上。主机与可选原生客户端的平台支持范围不同，均不代表支持所有操作系统。
3. **需要模型凭据，而且只留在主机上**。API key 由主机上的 DSH 读取，不进客户端、不进 Relay、不进隧道进程。

## 最小部署要求

最小可用部署是 **一台执行主机 + Turnwire + DSH + 模型凭据**。浏览器或终端连接这台主机即可，不必先部署 Relay、容器或原生桌面应用。

| 项目 | 需要准备什么 |
| --- | --- |
| 执行主机 | 能持续运行进程，满足[当前安装包与 runtime 要求](docs/QUICKSTART.zh.md)；不要把浏览器设备的平台当作执行主机要求 |
| 软件 | Node.js（最低版本见下方自动生成的要求）和 npm；首次启动可引导安装 DSH，也可明确连接已有实例 |
| 网络 | 首次安装能访问 npm registry；真实任务能访问所配置的模型服务；仅本机使用无需公网入口 |
| 配置与数据 | 当前用户可写的配置、状态、数据和缓存目录，以及实际项目工作目录；模型凭据只留在主机 |
| 访问端 | 一个可用浏览器或终端；远程访问期间主机必须在线 |

尚未测定统一的 CPU、内存或磁盘最低值，不给出虚假的硬件门槛；资源消耗取决于 DSH、项目规模与并发任务。持久化、端口及平台细节见[快速开始](docs/QUICKSTART.zh.md)。

## 选择部署方式

| 你的目标 | 推荐方式 | 注意 |
| --- | --- | --- |
| 先在本机试用 | `npx turnwire@next --open` | 前台运行，保持终端打开；首次按提示准备 DSH 和模型密钥 |
| 经常使用 | `npm install -g turnwire@next`，然后 `turnwire --open` | 固定安装命令，但仍是前台进程，不会自动变成后台服务 |
| 已有 DSH | 配置已有实例的 URL/token，再启动 Turnwire | 必须明确授权连接；外部 DSH 不由 Turnwire 更新或停止 |
| 需要无人值守主机 | 按[后台服务安装步骤](docs/QUICKSTART.zh.md)操作 | 与 npm 前台启动是不同的生命周期，先核对适用环境 |
| 先看产品，不调用模型 | 有源码权限时运行[离线 Demo](docs/DEVELOPING.zh.md) | 不需要模型密钥，不执行真实编码任务 |
| 手机或异地接续 | 主机跑起来后配置临时隧道或[自托管 Relay](docs/RELAY-INSTALL.zh.md) | Relay 只是远程连接组件，不能替代执行主机；长期使用需要稳定地址 |

## 开始使用

### 推荐：npm 预览版

<!-- BEGIN GENERATED INSTALL: scripts/sync-docs.mjs -->
选择满足当前安装包与 runtime 要求的执行主机，并准备 **Node.js 22.13+** 和 npm。已发布的 [npm 预览版](https://www.npmjs.com/package/turnwire) 不需要仓库权限、源码构建或系统服务配置：

```sh
npx turnwire@next
# 或长期安装：
npm install -g turnwire@next
turnwire --open
```

**发布通道：** 推送到 `main` 时将预览版发布到 npm `next`。只有明确发布稳定版 GitHub Release 才会发布到 npm `latest`；推送 `main` 不会升级稳定版。使用 `turnwire@next` 获取当前预览版，不固定某个预览版本号。这是 Turnwire 的发布通道，与 DSH runtime 的通道不同。

源码仓库仍为私有；从 npm 安装不需要访问权限。预览版不是稳定版，也不是已签名的原生桌面安装器。统一安装入口不代表支持所有操作系统，仍以安装包约束与 runtime 要求为准。
<!-- END GENERATED INSTALL -->

预览版以前台运行，请保持终端打开，不会安装系统服务。模型密钥通过隐藏输入提供，只留在主机。明确配置了已有 DSH 时会复用；否则询问安装 npm `latest`，解析为精确版本并先隔离验证。本机使用无需 Relay；手机远程访问需要另行配置。

停止自己的前台实例后，可运行 `turnwire start --update-dsh`：先安装、检查新版本，通过后再切换。不自动降级、不热替换活跃 runtime、不更新外部 DSH；普通启动不会悄悄更新已有安装。

详见[快速开始](docs/QUICKSTART.zh.md)、[npm 安装与发布](docs/NPM.zh.md)和[DSH 兼容性与边界](docs/DSH-COMPATIBILITY.zh.md)。兼容矩阵在已配置的主机环境上覆盖基准版/latest/next，不代表对未来任意上游改动的永久兼容保证。

### 可选：后台主机

需要主机在后台运行时，请参阅[快速开始中的服务安装说明](docs/QUICKSTART.zh.md)。安装前先确认对应的平台要求与安全边界；手机访问仍需单独明确配置。

### 第 1 步：主机跑起来

1. 先运行 `node --version`、`npm --version` 确认环境满足要求，再运行 `npx turnwire@next --open`。
2. 按提示允许安装缺失的 DSH，并私下输入模型密钥；已有 DSH 的用户先按[复用说明](docs/QUICKSTART.zh.md)配置连接。
3. 等待启动完成。`--open` 会尝试打开已认证的本机 Web；不支持自动打开浏览器时用 `--no-open`，查看启动器地址，通过 `npx turnwire@next connect` 获取本机连接信息。此输出含凭据，不要公开。
4. 另开终端运行 `npx turnwire@next status`，确认主机及 runtime 在线；`npx turnwire@next doctor --json` 只做离线环境检查，不能替代在线验证。
5. 在 Web 或终端中选择项目工作目录，创建会话并发送任务。能连接主机不代表模型密钥一定有效，实际任务才会验证模型服务访问。

若默认 Web 端口被占用，可用 `npx turnwire@next start --port 9900 --open`。保持主机进程运行，Ctrl-C 会停止它拥有的进程，不停止外部 DSH。

有私有仓库访问权限的开发者可按[从源码开发](docs/DEVELOPING.zh.md)构建、运行离线 Demo，或通过 DSH 接入真实模型。Demo 不需要模型凭据，不调用模型、不运行 shell、不修改文件。

### 第 2 步：装上你要的客户端

| 你想要 | 怎么装 | 需要什么 |
| --- | --- | --- |
| 桌面浏览器 | 打开主机启动器输出的本机地址 | 一台运行中的主机；见[快速开始](docs/QUICKSTART.zh.md) |
| 原生桌面客户端（可选） | 见[客户端能力](docs/CLIENTS.zh.md)与[源码安装说明](docs/DEVELOPING.zh.md) | 先确认文档中的平台、构建与签名要求 |
| 后台主机 | 见[服务安装说明](docs/QUICKSTART.zh.md) | 先确认文档中的平台与服务要求 |
| 自托管 Relay（长期稳定地址） | `deploy/` 下有 Dockerfile、compose.yaml 与 Caddyfile | 一台服务器；详见[一键部署 Relay](docs/RELAY-INSTALL.zh.md) |
| 终端 / 脚本 | `npm run turnwire -- ...`，或构建后 `node apps/cli/dist/main.js ...` | Node.js（最低版本见上文）；命令见[命令行参考](docs/CLI.zh.md) |

### 第 3 步：让手机连上

本机地址 `127.0.0.1` 只代表那台机器自己，手机上的 `127.0.0.1` 是手机自己 —— 所以异地连接必须有一条公网通道。三种选择：

| 方式 | 使用流程 |
| --- | --- |
| 临时隧道 | 选 localhost.run、cpolar 或 Cloudflare，点「开启临时访问」；不需要自己的服务器。cpolar 首次需要账号 Auth Token。**地址会在 daemon 下次启动时变化，需要重新配对** |
| Cloudflare 命名隧道 | 用你自己 Cloudflare 账号下**已存在**的隧道与固定域名，地址不随重启变化；需要隧道名、公开域名与隧道凭据文件 |
| 自托管 Relay | 填服务器的 HTTPS 地址与 Relay 连接密钥，点「保存并连接」；长期使用推荐，也是手机推送的前提 |

通道就绪后生成配对二维码，手机打开已部署的 PWA 粘贴配对码即可。配对链接把密钥放在 URL fragment 中，网页接收后立即移除；默认只为本次浏览会话保存，勾选「记住这台受信任设备」才持久保存。

> 国内网络可能连不上 Cloudflare 临时隧道，或出现延迟与不稳定 —— 它作为快速体验选项保留。长期使用建议选择在主机和手机实际网络中验证过的自托管 Relay；免费 Quick Tunnel 不等同于 Cloudflare China Network（那是另行订阅的企业服务）。

## 手机上能做什么

- 接续同一条会话：看实时进度、发送补充指令、停止正在跑的回合
- 处理审批与收件箱：批准 / 拒绝、回查已处理与已过期的操作
- 切换会话模型与思考强度：输入框上方的小 chip，只列出主机 runtime 注册的模型
- 会话运行中发送时可选**排队**（等当前回合结束）或**插话**（直接引导当前回合），消息上会标出当时用的是哪种
- 会话已归档时仍可查看历史，需要时取消归档继续

## 已知限制

- **主机要醒着、联网**：主机不在线，手机看不到进度。
- **手机推送需要自托管 Relay**：临时地址不支持长期推送（`turnwire notifications status` 会明确告诉你）。
- **切换地址要重新配对**：临时隧道每次重启都会换地址。
- **原生应用是 ad-hoc 签名**：只适合自用或内部分发。
- **没有模型凭据时只能跑 Demo**，无法执行真实编码任务。

## 深入文档

| 文档 | 内容 |
| --- | --- |
| [命令行参考](docs/CLI.zh.md) | 全部 `turnwire` 命令与选项 |
| [从源码开发](docs/DEVELOPING.zh.md) | 构建、接真实 DSH、验证方式、工程结构 |
| [多端功能对等](docs/CLIENTS.zh.md) | 每项能力在各客户端的覆盖与代码归属 |
| [自托管 Relay + PWA](docs/DEPLOYMENT.zh.md) | 固定域名部署、国内网络说明 |
| [一键部署 Relay](docs/RELAY-INSTALL.zh.md) | 从部署表单一键安装服务器 |
| [用 Turnwire 开发 Turnwire](docs/SELF-HOSTING.zh.md) | 开发主机自动更新与安全点 |
| [DSH 接口说明](docs/DSH.zh.md) / [协议与状态边界](docs/PROTOCOL.zh.md) | 运行时契约与 RPC 边界 |
| [验证记录](docs/VALIDATION.zh.md) | 已验证与未验证的条件，逐条列出 |
| [参与贡献](CONTRIBUTING.zh.md) / [安全策略](SECURITY.zh.md) | 开发约束、验证要求与漏洞报告渠道 |

## 现状与边界

当前交付包含一次性配对、经设备凭据认证的每连接 ECDH 会话加密、分阶段连接恢复、持久审批收件箱、Web Push 和可配置的 TLS 局域网入口。配对与远程传输仅支持 v2，不支持 v1 设备或凭据升级；应从主机创建新的 v2 配对。RPC/事件信封仍为 v1。Store 拒绝旧数据库且不迁移，应使用独立的空数据库。Relay 的连接路由仍在内存中，推送密钥与投递队列持久化。

尚不包含 Codex / Claude adapter、团队账户、原生 iOS、自动更新或发行签名。"哪些只在特定条件下验证过"以 [验证记录](docs/VALIDATION.zh.md) 为准。

## 许可

Apache License 2.0 —— 详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。可以自由使用、修改和分发（含商用），需要保留版权与许可声明；本项目不提供任何担保。
