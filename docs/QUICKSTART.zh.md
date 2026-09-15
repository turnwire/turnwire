[English](QUICKSTART.md) · 中文

# Turnwire 快速开始

## 先选择执行主机

**执行主机**运行 Turnwire 和 DSH、访问项目文件，并保存凭据与会话数据。**浏览器客户端**只连接主机，可以在同一台电脑，也可以在其他设备上。手机或使用其他操作系统的浏览器设备不需要 Node、npm 或模型密钥。选择主机时，不必假设它就是你正在阅读本文的设备。

**兼容性说明：** 当前 npm 安装包允许的主机系统是 **Linux 和 macOS**；尚不声明支持原生 Windows 主机。DSH 也必须支持所选主机。下文源码 systemd 启动入口仅支持 Linux。这些主机限制不要求浏览器客户端也运行 Linux/macOS。详见 [npm 安装](NPM.zh.md)和 [DSH 兼容性](DSH-COMPATIBILITY.zh.md)。

## 最低部署要求

| 项目 | 需要准备什么 |
| --- | --- |
| 软件 | npm 安装方式要求执行主机具备 Node.js **22.13+** 和 npm；无需 Git、源码构建或 systemd。源码方式另外需要 Git 和私有仓库访问权限。 |
| 主机 | 普通用户账号，能持续运行前台进程、写入私有目录，并访问 Agent 要处理的项目目录。工作期间保持主机常醒。尚无经过测量的 CPU、RAM 或磁盘最低值；请为安装包、运行时、项目文件、日志、会话和附件预留空间。性能尚未基准测试。 |
| 网络 | 安装时能出站访问 npm registry 和依赖下载地址；真实模型使用时能访问配置的模型服务。外部 DSH 另需可达的认证 HTTP/WebSocket 端点（非回环地址必须 HTTPS）。本机使用无需公网 IP、域名、入站防火墙开孔、Relay 或 tunnel。 |
| 凭据 | 受管真实 DSH 需要有效模型服务密钥，以 `TURNWIRE_HARNESS_DEEPSEEK_API_KEY` 读取；使用启动器隐藏提示或主机私有配置。外部 DSH 需要连接 token，并在 DSH 主机预先配置模型凭据。Demo 两者都不需要。 |
| 持久目录 | 配置、状态、运行时数据目录必须私有且可写，下载缓存也必须可写；重启时保留配置和状态。默认是 `~/.config/turnwire`、`~/.local/state/turnwire`、`~/.local/share/turnwire`、`~/.cache/turnwire`。分别用 `TURNWIRE_CONFIG_HOME`、`TURNWIRE_STATE_HOME`、`TURNWIRE_DATA_HOME`、`TURNWIRE_CACHE_HOME` 覆盖，详见[目录规则](XDG.zh.md)。 |
| 浏览器（可选） | Web/PWA 使用当前版本浏览器；无显示器主机不需要图形桌面或本机浏览器，也可只用 CLI/TUI。 |

选择以下一种部署方式。不要让多个主机进程共用同一状态目录或占用中的端口。单独试用时应同时隔离 config 和 state，避免覆盖现有的本机连接描述文件。

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

### 方式一：npx 前台运行（不全局安装）

1. 在主机检查 `node --version`（22.13 或更新）及 `npm --version`。
2. 运行 `npx turnwire@next doctor --json` 做离线预检。
3. 运行 `npx turnwire@next --open`，按提示批准受管 DSH 安装，在隐藏输入提示中填写模型密钥。`--yes` 可以批准安装，但不能代替缺失的密钥。
4. 保持终端运行，按下文步骤验证成功。后续用相同命令启动，复用相同私有目录；npx 不是常驻服务。

### 方式二：全局安装、前台运行（复用命令）

```sh
npm install -g turnwire@next
turnwire doctor --json
turnwire --open
```

使用普通用户可写的 npm prefix，不要以 root 运行主机。安装只提供可执行命令，每次 `turnwire --open` 都在前台运行。无显示器主机使用 `turnwire --no-open`。非交互启动前应私下在主机配置密钥；禁止打开浏览器并不会禁止凭据提示。

### 方式三：复用已认证的外部 DSH

1. 独立启动兼容的 DSH，并预先在其主机配置模型凭据。私下取得认证端点和连接 token；DSH token 不是模型 API key。
2. 在解析后的 Turnwire config 目录创建属于当前用户的普通文件 `dsh-connection.json`，在填入秘密前设置为 **0600** 权限。用私有编辑器填写，不要在 shell 命令中写入 token。以下只是占位模板，不是可用凭据：

```json
{
  "url": "http://127.0.0.1:3080/",
  "token": "REPLACE_PRIVATELY_WITH_DSH_CONNECTION_TOKEN"
}
```

3. 将示例地址换成实际 DSH 端点；DSH 在另一台主机时必须使用 HTTPS。也可通过私有环境/秘密管理器注入 `TURNWIRE_DSH_URL` 和 `TURNWIRE_DSH_TOKEN`，环境配置优先于文件。不要把真实 token 写入命令参数、shell 历史或公开配置。
4. 运行 `npx turnwire@next --open` 或 `turnwire --open`，然后按下文验证。认证失败会停止启动，不会安装替代实例。Turnwire 不接管外部 DSH、不改凭据、不更新它，Ctrl-C 也不停止它。

### 逐步验证 npm 启动成功

1. 查看终端打印的 Web 地址，通常为 **`http://127.0.0.1:9898`**。可用 `--port PORT` 选择其他空闲 Web 端口；占用中的端口会被拒绝，不会强行清理。`--open` 尝试打开已认证的本机 Web；`--no-open` 禁止自动打开。
2. 在同一账号、相同目录覆盖配置的第二个终端运行 `turnwire status`（或 `npx turnwire@next status`），确认主机有响应且 runtime 就绪。`doctor --json` 仅离线检查环境，不证明主机已运行或模型推理成功。
3. 若浏览器没有打开，请在**执行主机上的浏览器**打开打印的地址，运行 `turnwire connect`（或 `npx turnwire@next connect`），将本机连接信息用于 Web。连接输出和带认证的 URL 都是秘密，不要发到截图、日志或 issue。
4. 确认 Web 已连接，再用 `turnwire models` 查看 runtime 提供的模型目录，通过 Web 或 [CLI](CLI.zh.md)尝试一个小任务。只检查目录/状态不能证明模型服务认证或推理成功。

无显示器主机不需要屏幕：用 `--no-open` 保持运行，在主机用 CLI/TUI；若要从其他设备的浏览器访问，显式配置下文远程方式。手机/笔记本浏览器中的 `127.0.0.1` 指手机/笔记本自身，不是远端执行主机。本机回环 URL 或本机引导秘密不是远程配对链接；不要公开 daemon 端口或把本机秘密复制到手机。

## 源码 Demo：无需模型凭据

具备私有仓库访问权限和 Node/npm 后，使用与活跃部署分开的 checkout/config/state。以下环境变量赋值采用 **POSIX shell 语法**（例如 Bash 或 zsh）：

```sh
git clone https://github.com/turnwire/turnwire.git
cd turnwire
npm ci
npm run build
TURNWIRE_RUNTIME=demo npm run dev
```

保持 daemon 终端运行。在使用相同 config/state 覆盖配置的第二个终端运行：

```sh
npm run turnwire -- status
npm run turnwire -- connect
npm run turnwire -- new 'Try the demo' --runtime demo --title 'First demo'
```

打开 daemon 打印的本机 Web 地址（默认端口 9898），使用私有本机连接信息。Demo 返回模拟响应，不需要 DSH/模型密钥，也不能验证真实推理；下载/构建仍需要网络。连接真实 DSH 参见[源码开发](DEVELOPING.zh.md)。源码方式不是 npm 启动器，不使用它的 `doctor`/`--open` 选项。

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

`--check` 只检查，不安装、不启动。服务开始运行不等于 DSH/模型已健康；在仓库目录运行 `bin/turnwire status`，再私下运行 `bin/turnwire connect`，使用打印的本机地址确认 Web 连接。另行检查模型目录并执行一个小型真实任务。源码 CLI 不提供 npm 启动器的离线 `doctor` 命令。无人登录也需开机运行时，可能要管理员批准：`sudo loginctl enable-linger "$USER"`。

## 手机访问仍由用户明确选择

npm 启动后保持前台终端运行，在第二个终端操作（适用于全局安装）：

```bash
turnwire remote
turnwire devices pair --name phone --qr
```

仅使用 npx 时，以 `npx turnwire@next` 作为相同命令的前缀。源码常驻服务则在其仓库目录使用 `bin/turnwire`，而不是全局可执行文件。

同一主机上的浏览器访问完全本地，无需 Relay 或 tunnel。手机/其他设备访问是可选项：在远程表单里连接已有固定 Relay，或选择临时通道。固定 Relay 提供由操作者管理的稳定端点；临时通道依赖所选服务商、工具和出站连接，地址与有效期可能变化。Cloudflare 是可选项，不是本地使用或固定 Relay 的前置要求。打开远程 Web 端点并使用一次性邀请配对，不要使用主机的本机连接 token。配对码和二维码图片都应作为秘密保护。稳定公网入口仍需要可达的服务器/域名和凭据；启动脚本不会擅自购买 VPS、配置 DNS、开放防火墙或部署公网服务。详见[Relay 部署](RELAY-INSTALL.zh.md)。

daemon 和 DSH 保持回环监听，不默认启用代审批。主机需要常醒，保护私有凭据，分别备份 Turnwire config、state 和 DSH 状态/附件，包括显式配置的 `TURNWIRE_DSH_HOME`。配对仅支持 v2，要求 Relay、主机和客户端使用匹配的当前版本；不支持旧主机或旧设备凭据。

## 验证边界

已发布 npm tarball 通过全新 registry 安装、离线 doctor、demo 主机/认证 RPC/Web 检查及 Linux/macOS 安装包 CI。真实 DSH 基准/latest/next 集成 CI 覆盖认证启动、模型目录、空会话、重启恢复和进程所有权；不代表验证过真实推理或所有未来 DSH 版本，详见[兼容性边界](DSH-COMPATIBILITY.zh.md)。

源码服务启动脚本测试在隔离目录中替换系统命令和安装器，验证流程、重复启动、服务冲突及密钥处理，不重启当前开发主机。这不等于已完成全新虚拟机/真实网络/systemd 的端到端生产部署认证。
