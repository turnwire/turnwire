[English](QUICKSTART.md) · 中文

# Turnwire 快速开始

## 推荐：已发布 npm 预览版（Linux / macOS）

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

保持终端打开：这是前台主机，不是后台服务。Ctrl-C 只停止它自己启动的进程，不停止外部 DSH。安装包包含主机、CLI/TUI 和 Web，不是签名的原生 Mac App。使用本机 Web 无需 Relay。模型凭据只留在主机上，并以隐藏方式询问；不要把密钥发到手机或 Relay。

已有 DSH 时，显式配置 `TURNWIRE_DSH_URL` 与 `TURNWIRE_DSH_TOKEN`，或在 Turnwire 配置目录提供权限为 0600 的私有 `dsh-connection.json`。启动器不会扫描其他工具的秘密。没有外部连接时会复用 Turnwire 已托管的安装；仅在安装缺失时询问安装 registry `latest`：先解析成精确版本，在隔离版本目录安装，通过验证后才选择使用。认证失败不会偷偷安装替代实例。

用 `turnwire doctor --json` 离线检查环境。停止自己的前台实例后，运行 `turnwire start --update-dsh` 显式安装并验证托管 DSH 更新。验证失败保留旧选择，不自动降级、不热更新，也不更新外部或自定义 DSH。普通启动不会擅自升级已有 runtime。详见 [npm 安装](NPM.zh.md)、[DSH 兼容性与边界](DSH-COMPATIBILITY.zh.md)和[目录规则](XDG.zh.md)。

## 进阶：源码 Linux 常驻服务

下面是需要私有源码仓库访问权限的替代安装方式。它注册 systemd 用户服务，与 npm 前台预览版不同；不要让两者同时使用同一活跃状态目录或端口。

## 第一次运行

使用有正常 systemd 用户服务的 Linux 普通专用账号，取得仓库并进入目录：

```bash
git clone https://github.com/turnwire/turnwire.git
cd turnwire
bash scripts/start-host.sh
```

已经安装 Node/npm 时，也可以运行 `npm start`，两者是同一入口。Bash 入口可以自行准备固定版本 Node。首次下载/构建耗时取决于网络和 CPU；「一命令」不代表无需前置条件或瞬间安装。

脚本检查环境、准备 Node 与依赖、构建 PWA/主机、隐藏输入模型密钥，并调用已有 Linux 安装器注册常驻服务。默认受管主机需要 `TURNWIRE_HARNESS_DEEPSEEK_API_KEY`，不因此新增或注册模型。私有配置、状态、运行时和下载缓存分别用独立的 `TURNWIRE_CONFIG_HOME`、`TURNWIRE_STATE_HOME`、`TURNWIRE_DATA_HOME`、`TURNWIRE_CACHE_HOME` 覆盖。未覆盖时使用对应的绝对路径 XDG 基目录加 `/turnwire`，默认依次为 `~/.config/turnwire`、`~/.local/state/turnwire`、`~/.local/share/turnwire`、`~/.cache/turnwire`。`TURNWIRE_HOME` 已删除，设置它会被拒绝。不自动识别旧布局；DSH 环境文件只默认使用解析后的 config 目录中的 `dsh.env.json`，也可用 `TURNWIRE_DSH_ENV_FILE` 显式指定。Store 以 `UNSUPPORTED_STORAGE` 拒绝旧库，不提供迁移；当前格式须使用独立空状态目录。详见 [XDG 目录规则](XDG.zh.md)。不要把密钥放进命令行参数、公开部署文件或截图。

需要 Bash、正常工作的 systemd 用户服务及下载/解压 Node 所需工具，不以 root 运行。安装路径使用不含空格的简单路径，与既有服务安装器限制一致。该入口仅支持 Linux；Mac 使用原生/源码安装说明，不会假装安装 Linux 服务。

## 后续启动

同一时间只运行一个启动脚本，首次构建未做并发串行化。上次运行结束后，再次执行同一命令：匹配的服务已运行时保持不动；匹配的已安装服务停止时直接启动，不重新构建。若服务属于其他安装目录，拒绝覆盖或重启。这个入口不是升级命令；替换版本应先等当前任务结束，再按[维护指南](FIRST-UPGRADE.zh.md)操作。

```bash
bash scripts/start-host.sh --check
systemctl --user status turnwire-host
journalctl --user -u turnwire-host -n 100
```

`--check` 只检查，不安装、不启动。服务开始运行不等于 DSH/模型已健康，应继续执行脚本提示的状态与连接检查。无人登录也需开机运行时，可能要管理员批准：`sudo loginctl enable-linger "$USER"`。

## 手机访问仍由用户明确选择

npm 启动后保持前台终端运行，在第二个终端操作（适用于全局安装）：

```bash
turnwire remote
turnwire devices pair --name phone --qr
```

仅使用 npx 时，以 `npx turnwire@next` 作为相同命令的前缀。源码常驻服务则在其仓库目录使用 `bin/turnwire`，而不是全局可执行文件。

在远程表单里连接已有固定 Relay，或选择临时通道。稳定公网入口仍需要可达的服务器/域名和凭据；启动脚本不会擅自购买 VPS、配置 DNS、开放防火墙或部署公网服务。详见[Relay 部署](RELAY-INSTALL.zh.md)。

daemon 和 DSH 保持回环监听，不默认启用代审批。主机需要常醒，保护私有凭据，分别备份 Turnwire config、state 和 DSH 状态/附件，包括显式配置的 `TURNWIRE_DSH_HOME`。配对仅支持 v2，要求 Relay、主机和客户端使用匹配的当前版本；不支持旧主机或旧设备凭据。

## 验证边界

已发布 npm tarball 通过全新 registry 安装、离线 doctor、demo 主机/认证 RPC/Web 检查及 Linux/macOS 安装包 CI。真实 DSH 基准/latest/next 集成 CI 覆盖认证启动、模型目录、空会话、重启恢复和进程所有权；不代表验证过真实推理或所有未来 DSH 版本，详见[兼容性边界](DSH-COMPATIBILITY.zh.md)。

源码服务启动脚本测试在隔离目录中替换系统命令和安装器，验证流程、重复启动、服务冲突及密钥处理，不重启当前开发主机。这不等于已完成全新虚拟机/真实网络/systemd 的端到端生产部署认证。
