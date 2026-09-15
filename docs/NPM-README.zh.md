[English](NPM-README.md) · 中文

# Turnwire

[![npm next](https://img.shields.io/npm/v/turnwire/next?label=npm%20next)](https://www.npmjs.com/package/turnwire/v/next)
[![npm latest](https://img.shields.io/npm/v/turnwire/latest?label=npm%20latest)](https://www.npmjs.com/package/turnwire/v/latest)

在终端、浏览器和手机间继续同一个自托管 Agent 会话。任务由主机上的 DeepSeek Harness（DSH）执行，模型凭据只留在主机。

## 最小部署与方式选择

需要一台满足安装包/runtime 要求的执行主机、Node.js 和 npm（最低版本见下文）、当前用户可写的配置/数据/缓存与项目目录、安装时的 registry 访问能力，以及真实任务所需的模型凭据和模型服务网络。浏览器设备不运行 DSH。尚未测定统一的 CPU、内存或磁盘最低值，资源要求取决于项目与并发任务。本机使用不需要 Relay、容器或公网入口。

准备执行主机后，从以下四种部署方式中选择；启用远程访问后仍可本地访问：

- **本地：** 运行 `npx turnwire@next --open`，在同一电脑打开打印的地址。无需域名、公网 IP、Relay 或隧道；保持终端运行。
- **临时隧道：** 准备所选服务商的隧道工具及出站连接。主机运行后，用 `npx turnwire@next remote` 选择临时访问。默认 Cloudflare quick tunnel 无需自有域名，但重启后地址可能变化，不应作为持久 PWA 入口。
- **命名隧道：** 准备已有 Cloudflare tunnel、已通过 DNS 路由到该 tunnel 的固定 hostname、`cloudflared` 和执行主机上的 tunnel 凭据 JSON。在 `npx turnwire@next remote` 中选择命名 Cloudflare provider，填写 tunnel 名称、hostname 和凭据文件路径。Turnwire 不替你创建这些资源。hostname 固定，但执行主机与隧道进程必须保持在线。
- **自部署 Relay：** 准备自己满足 [Relay 部署要求](https://github.com/turnwire/turnwire/blob/main/docs/RELAY-INSTALL.zh.md)的服务器、公网域名或受支持的公网 IP、可达的 TCP 80/443、出站下载连接、SSH 私钥/agent 和管理员或免密 sudo 权限。在已启动的执行主机运行 `npx turnwire@next deploy` 并填写表单，在自己的 HTTPS 入口持久运行 Relay 并提供 PWA。保留服务器配置和 push 状态，维护证书续期，同时保持独立的执行主机在线。Relay 转发加密连接，不执行 Agent 任务。

任何远程方式配置后，先用 `npx turnwire@next remote status` 检查，再运行 `npx turnwire@next devices pair --name phone --qr`。打开远程 HTTPS Web 入口，用一次性邀请配对，不能使用主机的本机连接 token。保护邀请码、二维码及 tunnel/Relay 凭据。实际确认远程设备连接成功；部署成功不代表设备网络已经验证。

### 主机安装、runtime 与开发选择（不是部署模式）

npx 用于前台启动；或先 `npm install -g turnwire@next`，再 `turnwire --open`，得到可复用的命令，全局安装仍不安装后台服务。需要时按下文配置**外部 DSH runtime**，Turnwire 不停止或更新它。**源码后台服务安装**与**源码 Demo 开发测试**步骤见仓库[快速开始](https://github.com/turnwire/turnwire/blob/main/docs/QUICKSTART.zh.md)（需要访问权限），npm 启动器不安装这些组件。

## 安装预览版

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

这是预览版，不是稳定版或已签名的原生桌面发行版。无需源码仓库权限。npm 安装本身不会启动服务或安装 DSH；运行启动器后以前台运行，请保持终端打开，Ctrl-C 仅停止它拥有的进程。

## 首次启动如何确认成功

按启动器提示安装 DSH 并隐藏输入模型密钥。`--open` 尝试打开已认证的本机 Web；主机无法自动打开浏览器时用 `npx turnwire@next --no-open`，保持进程运行并记录输出的地址。另开终端运行 `npx turnwire@next status` 查看在线状态，用 `npx turnwire@next connect` 获取本机连接信息；后者含凭据，不要分享。远端浏览器的 localhost 不是执行主机，应配置远程访问，不要直接暴露 daemon 端口。

`npx turnwire@next doctor --json` 是离线环境检查，不能证明主机已运行或模型密钥有效。创建会话并发送任务，才能验证真实模型访问。Web 端口冲突时可重新运行 `npx turnwire@next start --port 9900 --open`。Ctrl-C 仅停止拥有的进程。

## 连接 DSH

明确配置了外部 DSH 时优先复用：提供 `TURNWIRE_DSH_URL` 和 `TURNWIRE_DSH_TOKEN`，或在 Turnwire 配置目录创建仅本人可读的 `dsh-connection.json`（0600，包含 `url`、`token`）。Turnwire 不会停止外部 DSH。

否则启动器会询问安装 registry `latest`，解析为精确版本，安装到独立目录并在隔离 HOME 中验证后才选择。模型密钥通过隐藏输入或 `TURNWIRE_HARNESS_DEEPSEEK_API_KEY` 提供，不要把凭据发到 issue 或聊天。

## 常用命令

```sh
turnwire --help
turnwire doctor --json
turnwire start --no-open --port 9898
# 先停止自己的前台实例，再检查更新：
turnwire start --update-dsh
```

DSH 更新需要明确执行：不自动降级、不热替换、不更新外部或自定义入口。验证失败保留旧安装。私有 `managed-dsh.json` 选择文件只由 npm 启动器使用，不由源码系统服务安装器读取。普通启动不会悄悄升级已有 DSH。

本机使用不需要 Relay。手机访问需另外配置配对和远程连接；手机上的 localhost 指手机自己。长期远程访问优先使用自托管 Relay，不要直接把 daemon 端口暴露到公网。

## 兼容性与边界

连接时验证 DSH 核心认证响应结构，无法确认的可选能力保持未知。CI 在配置的平台矩阵上针对基准/latest/next 测试真实启动、模型目录、空会话、重启和进程所有权，不发送模型推理请求，也不保证未来任意 DSH 改动永久兼容。真实推理流、审批、图片和 steer 等仍需要更多端到端验证。

源码仓库当前为私有；从 npm 安装不需要仓库权限。仓库内文档链接需要访问权限，包内提供本独立说明及英文版。

- npm：https://www.npmjs.com/package/turnwire
- 源码和 issue（需要权限）：https://github.com/turnwire/turnwire

许可证 Apache-2.0，依赖许可证随包放在 `licenses/`。
