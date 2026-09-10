# Turnwire

同一个 Agent 会话，在终端、原生 Mac 应用和手机上接续。

Turnwire 使用 TypeScript 实现核心、daemon、CLI、DSH 适配器、Relay 和手机 PWA。原生 SwiftUI 客户端位于独立的 [turnwire-desktop](https://github.com/turnwire/turnwire-desktop) 仓库。所有客户端连接同一个 `turnwire-host`，DSH 是可替换的第一个 runtime。

CLI、交互终端/TUI 和原生客户端在相同连接权限下提供相同功能。业务规则和状态由共享服务维护，各端负责交互。代码归属与能力矩阵见 [多端功能对等](docs/CLIENTS.md)。

```text
CLI ───────────────┐
SwiftUI Desktop ──┼── turnwire-host ── Turnwire Core ── AgentRuntime ── DSH Host
                  │     │
Phone PWA ─ Relay ┘     SQLite
           密文转发     元数据 / 事件缓存 / 审批 / 命令回执
```

## 快速运行

需要 Node.js 22.13+ 和 npm。将两个仓库克隆到同一父目录，方便运行原生客户端和跨仓库验证：

```bash
git clone https://github.com/turnwire/turnwire.git
git clone https://github.com/turnwire/turnwire-desktop.git
cd turnwire
```

安装依赖并构建：

```bash
npm ci
npm run build
```

先使用无需模型凭据的离线演示，确认完整的多端工作流：

```bash
TURNWIRE_RUNTIME=demo npm run dev
```

另开终端：

```bash
npm run turnwire -- connect
npm run turnwire -- new '检查这条会话的审批同步' --runtime demo --title '第一次接续'
npm run turnwire -- ls
```

浏览器打开 `http://127.0.0.1:9898`，选择「本机连接」，填入 `turnwire connect` 输出的地址和令牌。创建会话、发送消息、批准或拒绝操作。Demo 不调用模型，不运行 shell，不修改文件；输入包含「审批」或 `approval` 时产生一条演示审批。

`npm run dev` 运行 daemon，`npm run dev:web` 单独运行 Vite 开发服务器。生产构建的 PWA 由 daemon 同源提供。默认状态目录为 `~/.turnwire`；可通过 `TURNWIRE_HOME` 指定独立目录。不要同时用多个 daemon 操作同一状态目录。

## 连接真实 DSH

适配器依据官方源码版本 **0.1.5-alpha.1**、提交 `5dda764ed3aa172535a7967b06ff95d9cbfe536a` 实现，使用官方 API Gateway 和 Remote mux，不解析终端输出。DSH 的稳定发布标签与 alpha 的接口可能不同，不要默认混用。详情见 [DSH 接口说明](docs/DSH.md)。

```bash
# 终端 1：确保已 export TURNWIRE_HARNESS_DEEPSEEK_API_KEY。
# 只检查是否存在，不输出密钥。
test -n "$TURNWIRE_HARNESS_DEEPSEEK_API_KEY" && npm run dev:dsh

# 终端 2：复制 DSH 输出的启动 URL，包含 ?token=...。
TURNWIRE_DSH_URL='http://127.0.0.1:3080/?token=YOUR_DSH_LAUNCH_TOKEN' npm run dev

# 终端 3
npm run turnwire -- status
npm run turnwire -- new '说明当前项目的结构' --title '了解项目'
```

`npm run dev:dsh` 加载 [DeepSeek 配置](config/dsh-deepseek.patch.yml)，让模型和网页搜索使用环境变量 `TURNWIRE_HARNESS_DEEPSEEK_API_KEY`（拼写为 **TURNWIRE**）。配置仅保存变量名，DSH 在请求时读取凭据。密钥需要存在于启动 DSH 的终端环境中；只设置在 daemon 或桌面端进程中不会传给已经运行的 DSH。

DSH 独立运行并保留自己的数据目录、模型配置和凭据。Turnwire 不读取或修改 DSH 内部持久化文件。如果已有 DSH `settings.yaml` 显式设置了 `llm-deepseek.apiKeyEnv`，该用户设置优先于启动配置，需要将其引用名同步为 `TURNWIRE_HARNESS_DEEPSEEK_API_KEY`。`TURNWIRE_DSH_TOKEN` 是单独的本机连接令牌，也可以单独传入；token 缺失、版本不兼容或服务离线时会明确报错，不会自动降级为 Demo。未经配置的模型无法执行真实 coding 任务。

## CLI

开发时使用 `npm run turnwire -- ...`；构建后可直接 `node apps/cli/dist/main.js ...`，也可将相应 workspace 的 `turnwire` / `turnwire-host` 可执行文件加入自己的 PATH。

| 命令 | 用途 |
| --- | --- |
| `turnwire status` | 查看设备和 runtime 状态 |
| `turnwire ls --search 关键词` / `--archived` / `--all` | 搜索会话与工作目录，查看归档 |
| `turnwire rename SESSION_ID 标题` | 重命名共享会话 |
| `turnwire archive SESSION_ID` / `turnwire unarchive SESSION_ID` | 归档与取消归档，保留历史 |
| `turnwire history SESSION_ID` | 查看消息和完整工具输入、输出 |
| `turnwire export SESSION_ID --output 会话.md` | 导出 Markdown 记录 |
| `turnwire new [prompt] --cwd /absolute/path --title 标题` | 创建会话，默认 DSH |
| `turnwire models` | 列出当前 runtime 注册的模型、默认模型与可选思考强度 |
| `turnwire model SESSION_ID provider/model [--effort EFFORT]` | 选择会话运行的模型与思考强度；只接受 runtime 目录里的模型 |
| `turnwire attach SESSION_ID` | 读取历史并跟随实时输出；TTY 下可继续输入 |
| `turnwire send SESSION_ID '消息'` | 发送后续消息 |
| `turnwire resume SESSION_ID` | 恢复中断的会话 |
| `turnwire stop SESSION_ID` | 取消当前 Agent turn |
| `turnwire approvals` | 列出待审批操作 |
| `turnwire approve APPROVAL_ID` / `turnwire reject APPROVAL_ID` | 一次性审批 |
| `turnwire inbox` / `turnwire inbox --all` | 待审批收件箱；`--all` 含已处理和已过期记录 |
| `turnwire result REQUEST_ID` | 查询结果不确定的请求最终是否已提交 |
| `turnwire notifications status` / `on` / `off` | 查看或切换主机的 Web Push 投递 |
| `turnwire devices pair --name 我的手机` | 生成远程设备配对码 |
| `turnwire devices list` / `turnwire devices revoke DEVICE_ID` | 查看或撤销设备 |
| `turnwire connect` | 查看本机连接信息 |
| `turnwire connection` | 检测与 Mac 的实际往返连接，远程配对同样可用 |
| `turnwire devices list --watch` | 查看已配对设备是否已确认连通、最近确认时间和延迟 |
| `turnwire tui` | 进入复用 CLI 命令的交互终端 |
| `turnwire remote` | 交互式远程设置，包括模式选择、配对和撤销 |
| `turnwire remote status --watch` | 持续查看连接进度，Ctrl+C 退出查看 |
| `turnwire deploy` / `turnwire deploy --config 私有配置.json` | 表单或一条命令部署 / 更新 Relay，自动配置 HTTPS 和常驻服务 |
| `turnwire deploy --status` | 查看所有本机客户端共享的部署进度 |
| `turnwire devices pair --qr` | 在终端显示手机配对二维码 |
| `turnwire devices pair --qr-file phone.png` | 保存权限为 0600 的 PNG 二维码，不覆盖现有文件 |

`--json` 输出结构化数据，`--url` / `--token` 覆盖本地连接，`--pairing FILE` 使用文件中的远程配对码。`attach` 的 Ctrl+C 只断开客户端；`stop` 才会停止 Agent。客户端退出不会关闭 daemon 或 DSH。

## 原生 macOS

```bash
cd ../turnwire-desktop
swift test
bash scripts/bundle.sh
open dist/Turnwire.app
```

需要 macOS 14+、Xcode 16+ / Swift 6。应用会读取 `~/.turnwire/client.json`，也可以手工输入地址和令牌。手工保存的令牌进入 macOS Keychain。支持按工作目录分组与搜索、重命名、归档、恢复、Markdown 导出，以及工作目录选择、审批、停止和远程配对。工作区分为对话、执行记录和结果视图，工具输入与输出分别展示，保留失败状态和耗时；支持 Markdown、代码、表格、内容搜索、每会话草稿和全局审批中心。⌘N 新建、⌘F 查找、⌘R 刷新、⌘Return 发送。开发包采用 ad-hoc 签名；对外发布还需 Developer ID 签名与 notarization。

## 手机与 Relay

现在也可以从 CLI、TUI 或 macOS「自托管 Relay」里的部署表单一键安装服务器。地址、SSH 账号、私钥路径来自私有运行时配置；部署成功后默认连接本机。详见 [一键部署与运维](docs/RELAY-INSTALL.md)。

本机地址 `127.0.0.1` 只代表当前设备，不能在手机上指向 Mac。异地连接可选择自动创建临时隧道，或连接自己部署的 Relay 和 PWA；Mac 主动连出，无需向公网开放 daemon 端口。

在原生 Turnwire 右上角打开「远程控制」，选择一种方式：

| 方式 | 使用流程 |
| --- | --- |
| 临时隧道 | 选择 localhost.run、cpolar 或 Cloudflare，再点击「开启临时访问」；无需自己的服务器，cpolar 首次需要账号的 Auth Token |
| Cloudflare 命名隧道 | 用自己账号下**已存在**的隧道与固定域名，地址不随重启变化；需要隧道名、公开域名和隧道凭据文件 |
| 自托管 Relay | 填写服务器的 HTTPS 地址和 Relay 连接密钥，点击「保存并连接」；服务器部署见下方文档 |

通道就绪后填写设备名称并生成配对二维码。手机顶部显示「已连接到 Mac」、延迟和最近确认时间才表示完成实际连接检测；Mac 的设备列表也会显示已连接、离线或等待连接。手机在前台每 15 秒检测，超时退出已连接状态并自动重连。可以随时关闭远程访问；切换和关闭只影响远程连接，本地 Agent 会话保持运行。切换到新地址后需要重新生成配对链接。临时模式会在 daemon 下次启动时重新创建地址，自托管配置会恢复连接。

CLI 也支持同样的选择：

```bash
npm run turnwire -- remote temporary --provider localhost-run
# cpolar 首次可用 turnwire remote 菜单隐藏输入 Token，或通过 TURNWIRE_CPOLAR_AUTH_TOKEN 传入。
npm run turnwire -- remote temporary --provider cpolar
# 命名隧道：用自己 Cloudflare 账号里已存在的隧道与固定域名，重启不换地址。
npm run turnwire -- remote temporary --provider cloudflare-named \
  --tunnel-name turnwire --tunnel-hostname turnwire.example.com \
  --tunnel-credentials ~/.cloudflared/TUNNEL_ID.json
npm run turnwire -- remote status
# TURNWIRE_RELAY_TOKEN 通过调用 CLI 的终端环境传入；同一地址已保存密钥时可省略。
npm run turnwire -- remote relay https://turnwire.example.com
npm run turnwire -- remote off
```

开启命令立即返回启动状态，使用 `remote status` 查看进度。配置保存在 daemon 的私有状态目录，优先于旧的 Relay 环境变量；手机无法修改这些本机管理设置。DeepSeek API key 仍只由 DSH 使用。

国内网络可能无法连接 Cloudflare 临时隧道，或出现延迟与不稳定。它作为快速体验选项保留；长期使用建议选择在 Mac 和手机实际网络中验证过的自托管 Relay。Cloudflare China Network 是另行订阅的企业服务，免费 Quick Tunnel 不等同于中国网络。参见 [国内网络说明](docs/DEPLOYMENT.md#国内网络)。

本地验证 Relay：

```bash
TURNWIRE_RELAY_TOKEN='REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS' npm run dev:relay

# 另一个终端；不要同时运行之前的 turnwire-host。
TURNWIRE_RUNTIME=demo \
TURNWIRE_RELAY_URL=ws://127.0.0.1:9899 \
TURNWIRE_RELAY_TOKEN='REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS' \
npm run dev
```

公网使用 HTTPS/WSS，参见 [部署文档](docs/DEPLOYMENT.md)。配置后，在 Mac 原生客户端「远程控制」生成配对码，或使用 `turnwire devices pair`。手机打开已部署的 PWA，粘贴配对码。Safari 中可「添加到主屏幕」。配对链接把密钥放在 URL fragment 中，网页接收后立即移除 fragment。默认为本次浏览会话保存连接；只有选中「记住这台受信任设备」才持久保存。

要先用手机蜂窝网络体验，可按部署文档的「临时跨网络体验」选择隧道服务并启动临时访问。扫码或打开配对链接后会自动连接，刷新保留本次浏览会话的配对。手机与原生客户端共享会话、消息、进度和审批；Mac 需要保持唤醒、联网。手机也能切换该会话的模型与思考强度：输入框上方的小 chip 展开后只列出 runtime 注册的模型，改动落在主机上，刷新不丢。

## 工程结构

```text
apps/cli             终端客户端
apps/daemon          turnwire-host、本机鉴权、事件流、Remote bridge
apps/relay           认证、在线连接、密文转发
apps/deployer        通用服务器安装器、SSH 传输、发布校验与回滚
apps/remote-web      React + Vite PWA
packages/protocol    版本化消息、类型和运行时校验
packages/runtime     AgentRuntime 接口和明确标注的 Demo
packages/runtime-dsh 官方 DSH HTTP / WebSocket 适配器
packages/core        会话、权限、SQLite、事件和请求去重
packages/sdk         本机 / Remote 客户端、加密、会话展示模型
```

## 验证

```bash
npm run check   # strict TypeScript + integration tests + production build

# 另开终端启动隔离的 Demo，验证实际浏览器交互（需要 Chrome）：
TURNWIRE_HOME=/tmp/turnwire-preview-state TURNWIRE_RUNTIME=demo npm run dev
TURNWIRE_HOME=/tmp/turnwire-preview-state node scripts/ui-check.mjs
```

测试覆盖请求去重、审批竞态、数据库恢复、事件补发、本机鉴权、DNS rebinding 防护、Relay 撤销、密文完整性、跨设备隔离、重放拒绝、模型目录与选择校验（未注册的模型会被拒绝）、DSH 合约和 UI 主要流程。文档里的脚本名、仓库路径、CLI 命令、DSH 版本与凭据变量名由 `tests/docs.test.ts` 机械核对，说明过时会直接让 CI 失败。DSH 合约夹具用于校验具体协议，不能替代实际模型与工程的端到端验证。

当前交付包含一次性配对、经设备凭据认证的每连接 ECDH 会话加密、分阶段连接恢复、持久审批收件箱、Web Push 和可配置的 TLS 局域网入口。已有旧配对可以继续使用并从主机显式升级。Relay 的连接路由仍在内存中，推送密钥与投递队列持久化。尚不包含 Codex/Claude adapter、团队账户、原生 iOS、自动更新或发行签名。参见 [协议与状态边界](docs/PROTOCOL.md)。
