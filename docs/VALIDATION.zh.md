[English](VALIDATION.md) · 中文

# 验证记录

于 2026-09-09 和 2026-09-10 使用 Node 22.22.1 与 Apple Swift 6.3.3 执行。

| 面向 | 证据 |
| --- | --- |
| TypeScript | `npm run check` 通过：严格 TypeScript、跨十六个文件的 66 项测试，以及全部生产打包 |
| Core | 持久化 SQLite 元数据/事件事务、请求冲突/去重、被中断的回执、审批竞态、cancel、无效请求与重启恢复 |
| DSH 契约 | 完整的 Connection HTTP 信封、精确的命名参数、cookie 认证、mux 事件、流式/最终消息映射、审批取消竞态与缺凭据时失败关闭 |
| 本地 + Relay | 真实 loopback 服务器演练本地 token/origin/Host 围栏、事件重放、加密跨客户端命令、主机重连与被撤销凭据 |
| 密码学 | 完整性、对端/方向绑定、重放、过期与配对往返 |
| 原生 | 十六项 Swift 测试通过：呈现、protocol、二维码解码、实机 Demo 命令/审批/历史、实机 Relay 设置，以及部署线上/实机 API 检查 |
| PWA | 无头 Chrome 验证 connect/create/prompt/approve/reload、重命名/归档/恢复、侧栏交互以及 1440px、390px、375px 布局；截图检查确认移动端审批控件可容纳 |
| 桌面呈现 | 对隔离且显式标注的 fixture 进行自有窗口截图，验证工作区侧栏、执行视图、带 inspector 的 Markdown/代码/表格结果，以及 1000pt 宽度下的审批控件。截图在 AppKit 预览宿主中使用同一 SwiftUI 内容；原生工具栏布局也被渲染。代码块对齐在检查后得到修正 |
| 共享会话管理 | 本地与加密客户端验证重命名/归档/恢复与历史保留、忙碌/归档防护；CLI 操作浏览器创建的会话并导出私有（0600）Markdown；原生实机测试读回相同的元数据命令 |
| 构建 | monorepo 的 package/CLI/daemon/Relay 打包与 Vite 生产构建；带 ad-hoc 签名的原生 release `Turnwire.app` |
| 官方 DSH | 临时安装 `@deepseek-ai/dsh@0.1.5-alpha.1`；在隔离 `DSH_HOME` 且禁用遥测的情况下，真实 Host 的认证、空会话 create/list/resume/follow 均成功 |
| DeepSeek 凭据配置 | 官方 DSH `--dump-config` 确认模型与 web search 都引用 `TURNWIRE_HARNESS_DEEPSEEK_API_KEY`；overlay 中不存储任何 key 值。实机 Host 从用户的交互式环境启动；自动化验证未请求真实模型推理 |
| 公网远程传输 | 一条临时 Cloudflare HTTPS/WSS 隧道只提供公网 PWA 资产和加密 Relay。一个远程客户端通过公网端点完成认证、读取既有 DSH 会话并取回其事件历史 |
| 公网资产边界 | 集成覆盖包含 PWA 入口点、HEAD、私有 dotfile、编码穿越、符号链接逃逸和 daemon 端点 |
| 手机配对二维码 | 使用 CoreImage 本地生成，并用 Vision 解码验证；该配对在原生应用中仍可撤销 |
| 公网移动浏览器 | 390×844 的 Chrome 通过公网加密 Relay 加载既有会话，启用输入框并在刷新后重连，没有溢出或 JavaScript 错误。扫码配对现在会在 URL fragment 被移除后持久保存在 sessionStorage 中 |
| 远程模式管理 | 真实的本地与加密 Relay 连接演练 临时 → 自托管 → 关闭，保留会话、同服务器 key 复用、仅本地管理、断开前校验、取消、持久化关闭、崩溃清理与重试 |
| 客户端对等 | CLI 子进程、交互式命令分发器和类型化 SDK 操作同一个隔离 daemon：会话创建、加密手机快照、带引号的 prompt、远程关闭、设备撤销、Relay 配置/key 复用、notices、认证错误和 JSON 输出行为 |
| 交互式终端 | 真实 PTY 验证 `turnwire tui`、共享 `ls`、Relay 设置菜单、不回显的密钥输入、`attach`、Ctrl+C 返回菜单，以及干净退出 |
| 终端二维码 | 真实 CLI 写入权限 0600 的 PNG；原生 Vision 解码并精确匹配生成的配对 URL |
| 隧道组件 | 一个全新的私有目录成功下载并 SHA-256 校验官方 Cloudflare release，启动真实隧道并关闭它。子进程测试覆盖密钥环境排除、中止，以及在 URL 通告之后、隧道注册之前的失败 |
| 受管临时公网访问 | 本地 API 启动一条全新的真实隧道，通过 HTTPS 提供 PWA，配对一部测试手机，并通过公网加密 WSS 连接返回两个既有隔离 Demo 会话。关闭访问后清理了受管隧道与 Relay |
| 实机升级 | 重建后的原生应用连接到升级后的 daemon，DSH 会话仍然可用。初次升级期间保留了较早的外部端点；最近一次重启恢复了已保存的临时模式并创建新的临时地址，需要新的手机配对链接 |

官方 DSH 冒烟测试发现，概览中的 `{ args }` 嵌套在 Connection RPC 请求信封内部。实现、fixture 和文档在交付前得到修正。另一次截图捕获起初在响应式侧栏的尺寸过渡期间拍到了它；浏览器检查现在会等待过渡完成，并确认实际的移动端布局。

新建的 Quick Tunnel DNS 记录未能立即生效，Mac 解析器对部分新建名称返回 `ENOTFOUND`。成功的受管隧道公网检查通过公共 DNS-over-HTTPS 获取新主机名的实际 A 记录，并且只在其测试进程内使用；HTTPS 证书与主机名检查保持启用。未更改系统 DNS。这验证了公网 TLS 和加密应用路径，但不能证明通过每一部手机或 ISP 解析器都能立即到达。此前开通的公网端点全程得到保留。

未演练：真实模型推理、实际的 shell/文件工具、WAN 下的 iPhone 连通性、Docker 构建/部署、Gatekeeper 公证或后台 iOS 行为。生产 IP TLS 随后在下文记录的固定 IP 部署中得到了验证。契约 fixture 通过并不意味着对其他验证作出任何声称。PWA shell 可以被缓存；离线任务执行有意不可用。

中国大陆指引基于所链接的 Cloudflare 文档，而非多 ISP 的中国大陆连通性测试。第一次原生实机测试失败，是因为测试 Relay 使用了错误的端口变量启动；改用其支持的 `PORT` 后，全部十一项 Swift 测试针对隔离服务通过。

要重新运行两项原生实机测试，请启动隔离的 Demo daemon 与 Relay，把 `TURNWIRE_TEST_DAEMON_CONFIG` 设为 daemon 的 `client.json`，并设置 `TURNWIRE_TEST_RELAY_URL` 和 `TURNWIRE_TEST_RELAY_TOKEN`，然后调用 `swift test`。没有这些设置时，相关实机测试会跳过；仍有十项独立测试运行。`scripts/ui-check.mjs` 使用 `TURNWIRE_HOME`，并写入 `TURNWIRE_SCREENSHOTS`（默认 `/tmp/turnwire-screenshots`）。

2026-09-10 的重设计验证使用端口 19998 上的隔离 Demo daemon 和 19999 上的 Relay。原生视觉 fixture 与用户会话分离，且不执行工具。CLI、浏览器和 Swift 契约检查在没有真实模型推理的情况下通过。预览截图位于 `turnwire/desktop` 下的任务可视化目录；移动浏览器截图位于 `turnwire/web` 下。

重设计之后，空闲的实机 daemon 被升级到已验证的生产打包；其既有 DSH 会话得到保留，原 DSH Host 保持在线。重建后的原生应用打开了一个工作区窗口并建立了事件连接。已保存的临时远程访问以新的公网地址恢复在线。随后停止了隔离测试服务和预览进程。


## localhost.run、cpolar 与连接验证（2026-09-10）

- `npm run check` 通过 11 个文件中的 42 项测试和全部生产构建。新测试覆盖通过 CLI/TUI/SDK 选择 provider、cpolar 隐藏输入与已保存 token 复用、私有配置权限/移除、前台子进程关闭、凭据环境排除、localhost.run JSON 通告/地址变化，以及失败/中止的启动。
- 十二项 Swift 测试通过，包括针对 19998/19999 上隔离 Demo/Relay 服务的两项实机测试。实机原生客户端读取 provider 元数据和设备存在状态，在没有 Token 时拒绝首次使用 cpolar，并在不丢失本地会话的情况下切换 Relay/关闭。
- 加密健康测试证明：仅凭 Relay 就绪不能把手机标记为已连接；即使 relay socket 打开，沉默的 Mac 也会超时；错误 host/nonce 的回复会被拒绝；没有断开通知的旧 relay 仍会使主机设备存在状态过期。集成检查通过同一本地 API 读取 未确认 → 已连接 → 离线 的设备。
- 一个真实的匿名 localhost.run 进程建立了公网 HTTPS origin。公网 HTTPS 与加密 WSS 快照取回通过，测得一次 Mac 往返为 439 ms。本次运行不需要覆盖系统 DNS。该测量只是一次连接，不构成速度保证。
- 无头 Chrome 在 390×844 和 375×667 下加载该公网配对，验证手机连接栏与 Mac 设备确认、手动复查、离线状态、重连以及刷新后的配对持久化。没有出现 JavaScript 错误或水平溢出。自有窗口的原生与手机截图位于任务可视化目录 `turnwire/remote` 下。
- 官方 cpolar 3.3.18 macOS arm64 字节已按其发布的 Homebrew formula 进行 SHA-256 校验。使用故意无效的测试 Token 实际启动组件，产生了预期的认证失败。该版本文档所述的 `inspect-addr=false` 意外绑定 `:0`；适配器改为显式绑定 `127.0.0.1:0` 并且只请求 HTTPS。未提供有效的 cpolar 账号 Token，因此经过认证的 cpolar WAN 访问仍未验证。

公网检查使用隔离 Demo 状态，而非真实模型任务。实际 iPhone 运营商网络、后台 iOS 行为以及中国大陆 ISP 对比性能仍未验证。

这些检查之后，空闲的生产 daemon 和原生应用得到更新。既有 DSH 会话得到保留，DSH 保持在线，新的原生进程在远程设置面板打开的情况下建立了本地事件连接。daemon 报告全部三个 provider 选项，并保留用户此前的 Cloudflare 选择；其新的临时地址需要新的配对链接。隔离测试服务和预览进程被停止。在健康 UI 变更之后，既有的本地浏览器 create/prompt/approval/rename/archive/restore 回归也通过了。


## 手机 Markdown 渲染（2026-09-10）

PWA 此前把 assistant 文本直接插入一个预换行的 div。现在它在一个记忆化的 CommonMark/GFM 渲染器上处理未更改的事件文本。四项回归测试覆盖 Markdown 结构、流式/未闭合与嵌套围栏、硬换行、按消息的脚注锚点、惰性 HTML 和不安全 URL 过滤。既有内容安全策略得到保留；图像引用是显式链接。

`npm run check` 通过 12 个文件中的 46 项测试和生产打包。`node --import tsx scripts/markdown-ui-check.mjs` 启动隔离的 Demo、daemon 和加密 Relay 实例，并在 Chrome 中验证实际的 assistant 输出：标题、引用、任务列表、表格对齐、代码复制、在 320/375/390/1440px 下仅在容器内水平滚动、未完成的流式代码、完成的输出以及刷新/重放。同一会话的原始已完成文本通过本地 SDK 原样读回。截图经过目视检查；在发现列过窄后细化了表格尺寸。此 web 资产更新不需要重启原生端或 daemon。实际 iPhone/Safari 测试仍未验证。

运行中的 daemon 无需重启即可提供更新后的 Markdown 打包。交付期间，发现其此前选中的 localhost.run 隧道已停止（`临时通道已停止`）；恢复该传输与静态资产更新是两回事，并且会改变临时配对地址。

## 固定 Relay 部署（2026-09-10）

经用户授权的固定 IP 部署运行 Debian 13.5、一个隔离的官方 Node 22.23.2 二进制文件，以及 systemd 下打包的 Relay/PWA release。SHA-256 release 校验通过。一个独立打包的冒烟检查在没有服务器端 `node_modules` 树的情况下演练了真实的加密健康/快照交换。模型凭据和主机状态被排除在部署之外。

既有的 Caddy 2.6.2 进程保留其 PID 和 Hermes 站点配置；两个 Hermes listener 都保留其 PID。Turnwire 的 Relay 只绑定 `127.0.0.1:9899`，以自身用户运行，开机启用，并在显式服务重启后成功恢复。原 Hermes 根路径继续返回后端的 404，而既有模型 API 服务根路径返回 200。

Let's Encrypt 的 staging 与生产 IP 证书签发通过。外部 curl、Node fetch/WSS 和 Chrome 都在未禁用证书或主机名校验的情况下接受了生产证书链。`default_sni` 覆盖没有 SNI 的 IP 客户端。Certbot 的续期 dry run 成功，证书复制/校验/Caddy 重载钩子通过，每小时续期计时器处于活动并已启用。

一个隔离 Demo 主机通过公网服务连接。加密健康、快照、会话创建/重命名、坏 host token 拒绝、公网资产一致性、缺失 source map 和私有路由 404 检查全部通过。390×844 的 Chrome 加载公网配对，在输入框启用的情况下完成历史加载，并在刷新后重连，没有 JavaScript 错误或页面溢出。两次运行测得的加密往返为 373 ms 和 632 ms；这些是开发机测量，不是手机运营商或速度保证。

运行中的生产 Mac 通过共享本地 SDK 切换到固定 Relay，而没有重启 Core、原生应用或 DSH。其既有会话和待处理审批得到保留，DSH 保持在线。一个临时配对客户端验证了实际 Mac 的加密快照和设备确认，随后被撤销；固定 Relay 恢复在线。实际 iPhone/Safari、蜂窝网络以及中国大陆 ISP 对比性能仍未验证。机器特定设置存储在私有 Turnwire 状态中；可移植运维参见 `docs/RELAY-INSTALL.zh.md`。

生产 Mac 最初的 3,885 事件重放暴露了一个小型 Demo 检查未发现的共享 Relay 缺陷：经过认证的主机触达每秒 1,000 条消息的手机入口限制并断开。一个 4,000 事件的加密重放回归在修复前复现了该失败。Relay 现在对经过认证的主机重放豁免该手机限制，同时保留 payload/缓冲区上限；另一项经过认证的手机洪泛测试仍会收到关闭码 4429。完整检查通过 13 个文件中的 48 项测试，release `20260910.2` 包含该修复。不需要更改客户端 protocol 或原生模型。

修复部署后，两个临时公网配对针对真实生产 Mac 完成了加密验证（健康往返 357 ms 和 524 ms）。390×844 的 Chrome 也读取了实际既有会话/历史，达到已验证连接状态并启用输入框，没有页面溢出或 JavaScript 错误。未发送真实模型 prompt。两个验证设备都被撤销，固定 Relay 保持在线。

## 可移植一键部署（2026-09-10）

特定于服务器的 Caddy/systemd/hook 模板被一个接收 runtime 配置的 TypeScript 安装器取代。实际的机器地址、SSH 登录和 key 路径被移入私有 Turnwire 状态，包括此前的部署记录。一次仓库扫描未在可分发源码/文档中发现实际服务器 IP、SSH key 名称、用户 home 路径或此前主机特定模板名称的任何出现。

`npm run check` 通过 14 个文件中的 57 项测试。九项部署测试覆盖必需的 runtime 输入、命令/URL/路径注入拒绝、可配置的 IP/域名证书模板、保留全局选项/站点的幂等 Caddy 合并、子进程环境凭据排除、字面 shell 引用、带权限的备份恢复、完整 release manifest、无 macOS 元数据的归档、本地授权、共享异步任务以及 CLI/TUI/表单对等。已知进行中的任务在 daemon 重启后被标记为 interrupted。

`node --import tsx scripts/native-live-check.mjs` 通过全部 14 项 Swift 测试，包括针对隔离 daemon 的三项实机测试。部署 fixture 演练真实原生 HTTP 请求/状态契约，但不打开 SSH。原生部署表单也在自有预览窗口中渲染并做了目视检查；由于离屏缓存图像未能正确包含原生控件层，改用了窗口截图。

随后该可移植命令使用既有服务器的私有配置执行了一次真实更新，验证了 HTTPS 并注册了一个隔离主机。之后通过生产 daemon 的更新以相同配置成功。既有凭据和有效 IP 证书得到复用；原共享 Caddy 进程保持运行。生产 Mac 在升级到新 daemon 时保留了既有会话和 DSH runtime，重建后的原生应用带着远程控制重新打开。

真实部署验证发现了两个可移植性缺陷：macOS tar 包含了 release manifest 之外的 AppleDouble 文件，且 `/tmp` 与安装目录位于不同文件系统。打包现在排除该元数据，安装会在原子切换其本地符号链接之前复制/校验 release。跨文件系统失败演练了此前服务配置的恢复。之后一次 SSH 中断发生在安装器启动之前；服务器检查确认了此前健康的 release，重试成功。

在空机器、Ubuntu、ARM 服务器、基于密码的 SSH 以及任意既有反向代理布局上的全新开通未做实机测试。当前安装器支持私钥/agent SSH 和 Debian/Ubuntu systemd 主机；既有非 Caddy 占用 80/443 端口以及冲突的 IP TLS 配置会在预检时失败。网络中断可能留下不确定的服务器结果，如 `docs/RELAY-INSTALL.zh.md` 所述。


## 按需历史与桌面追赶（2026-09-10）

对实机主机的诊断最初发现 7,835 个事件，其中 7,521 个是 token delta；会话处于空闲，且全部 91 次工具调用都有返回结果。桌面端加载了整个原始 journal，并在视图读取中反复重建记录。截图中失败的 `ask_user_question` 也有真实错误结果；其失败与历史/渲染延迟不同。

所有客户端现在使用共享的 `history.page` 投影，初始读取 40 条完整记录，并显式获取更早的页面。工具输入/结果对保持在一起；页面大小也以 512 KiB 为目标。原始 journal 得到保留。桌面/PWA 压缩实时 delta，并以 50 ms 批量提交呈现更新；原生视图读取使用缓存消息，未变化的 Markdown 视图跳过重复解析。快照不能被更早的状态事件覆盖。原生重连会使缓存历史失效并获取当前快照；页面读取与实时事件连接并行运行。完整导出仍会显式加载所有页。

验证通过：完整 TypeScript 检查（63 项测试），随后是第六项历史回归（15 个文件中共 64 项测试）；16 项 Swift 测试，包括通过 `scripts/native-live-check.mjs` 的四项实机检查。覆盖包括数千个 delta、原始顺序、失败工具、并发页面/实时合并、旧 journal 迁移、受限字节大小、无未请求完整重放的加密初始连接、快照/监听器竞态、CLI/TUI 分页、原生完整导出以及离线完成后重连。`scripts/history-ui-check.mjs` 通过了加密 Chrome 390 px 检查：最近 40 条记录的第一页、加载更多后共 93 条记录、保持滚动位置、实时完成与重新加载。其隔离首屏渲染在此开发机上测得 126 ms；这不是公网或手机速度保证。既有 Markdown 浏览器回归也在 320/375/390/1440 px 下通过。

生产升级等待会话空闲，然后保留了两个会话和既有 DSH 进程。升级后，实机首页 RPC 分别返回 62/63 个投影事件（40 条记录，含工具对），约 167/70 KB，耗时 4/2 ms。原生 release 被重新打开。公网 Relay/PWA 使用既有的一键部署 profile 更新，复用凭据和证书。这些检查未调用模型 prompt 或真实 shell/文件工具。物理 iPhone/Safari/蜂窝行为仍未测试。

部署后的公网 HTML 与 JavaScript 与最终本地构建逐字节一致；既有手机回到已确认连接状态。原生应用建立了其本地 daemon 事件连接。


## Linux 无头主机（2026-09-10）

通过用户既有的 SSH 访问安装了一台 Debian 13 x86_64 主机。Node 22.23.2 已对照官方 SHA-256 manifest 校验。DSH 及其依赖由可移植的 `config/dsh-runtime` package/lock 文件固定（0.1.5-alpha.1）；lock 会归一化 package 路径，而不是指向开发机。Turnwire 生产依赖是在 Linux 上安装的，而不是从 macOS 复制。

新的 `scripts/install-linux-host.sh` 和 `install-host-service.mjs` 从其参数派生全部安装路径，生成可用的 `turnwire` wrapper 和可选的用户 PATH 快捷方式，并注册 `turnwire-host.service`。已启用用户 lingering。supervisor 启动 DSH，捕获其短时有效的 loopback 启动 URL，并启动未改动的 Turnwire daemon。DSH 凭据从私有目标配置加载，只提供给 DSH，并从 supervisor 日志中脱敏。目标进程检查验证：DSH 拥有配置的模型 key，daemon 没有；日志既不含模型 key 也不含活动启动 token；凭据文件权限为 0600。

`npm run check` 通过 16 个文件中的 66 项测试和全部生产打包，包括新的 supervisor 就绪、token/key 隔离、脱敏、优雅关闭和 DSH 启动失败测试。一个真实 SSH PTY 验证了远程 TUI、runtime 状态和 Relay 状态。该主机以独立主机身份和单独的手机配对使用既有公网 Relay。DSH 和 daemon 都只监听 loopback。Phone/SDK 标签现在指向该主机并显示其上报的名称，因此 Linux 主机不会被描述为 Mac。

Linux 用户服务重启恢复了其原主机身份、会话和 Relay 配置。新的 SSH 登录可解析 `turnwire` 快捷方式；TUI 退出后服务在用户 lingering 下保持活动并已启用。一次真实公网加密连接验证了该主机与既有桌面主机不同、DSH 在线，并且同样的空工作区可被远程看到。390×844 的 Chrome 启用了输入框，收到已确认的主机存在状态，并在重新加载后重连。测得一次加密往返为 455 ms。未发送模型推理 prompt。未演练物理手机/蜂窝条件和完整的操作系统重启。

## 远程传输 v2、收件箱、推送与局域网（2026-09-10）

- `npm run check`：20 个文件中的 75 项测试通过，包含 TypeScript 检查和生产构建。在把存在状态过期切换为单调时钟后，额外的针对性检查通过；墙上时钟跳变测试会让存在状态保持连接，直到单调时钟过期。
- `node --import tsx scripts/native-live-check.mjs`：17 项 Swift 测试通过，包括新的实机收件箱、已决议审批历史、直达设置、通知偏好和回执查询契约。release 应用已构建、本地签名，并在远程控制处重新打开。
- 会话密码学测试演练经过认证的 ECDH、被篡改的转录、错误凭据/设备上下文、反射、重放、乱序消息、并发加密排序、不同墙上时钟和新会话密钥。实机登记检查覆盖一次性邀请、客户端凭据的持久替换、最终登记响应丢失，以及对复制已消耗二维码的拒绝。
- 一次真实回归暴露了旧 Relay 响应在其新握手完成之前到达替换设备连接的问题。Relay 连接 UUID 现在把 payload 转发和关闭请求绑定到正确的 socket。修复后快速重连/登记集成测试通过。既有 v1 传输/审批/重放兼容性测试也通过。
- `tests/direct.test.ts` 启动一个独立的 TLS 服务器，使用显式受信任的测试 CA 和正常的证书/主机名校验。演练了直达连通性、私有 HTTP 路由 404 和自动 Relay 恢复。产品代码没有 TLS 绕过。该 loopback fixture 不是真实的 Wi-Fi 或 iPhone 局域网权限测试。
- 推送测试使用模拟 provider。它们验证私有 SQLite 文件权限、持久 VAPID 身份/队列、去重投递、过期订阅移除、端点限制、按设备范围的订阅授权和通用通知。收件箱测试在 daemon 重启后保留已决议/已取消记录，并取消待处理的 runtime 审批。
- `scripts/remote-resilience-check.mjs` 在 390×844 的真实 Chrome 中通过：一次性配对、重新加载、离线/在线恢复、模拟可见性事件、收件箱审批、跨标签页记住凭据、无页面错误且无水平溢出。收件箱截图是在等待抽屉过渡完成后检查的。此浏览器检查未把通知投递/权限模拟为成功的 OS 推送。
- 既有的一键部署更新了公网 Relay，并添加了其私有的持久推送数据库。在确认空闲状态后，更新了 Mac daemon 和 Linux 主机服务；主机 ID、会话和 DSH 配置得到保留。Linux 模型配置仍为 0600。一个私有应用归档支持在 Linux 主机上回滚。
- 临时公网 v2 配对验证了两台真实主机、加密快照/历史、反复重连和 Web Push 可用性，且未发送模型 prompt。在这些运行中观察到的验证 RTT 为 Mac 1302 ms、Linux 1358 ms；它们是开发机观察值，不是速度保证。一次 Linux 验证尝试触达 5 秒传输阶段截止时间；随后一次尝试成功。没有证据表明所有 WAN 重试都已被消除。
- Chrome 在 390×844 下通过公网 HTTPS PWA 加载了真实 Linux 主机，验证 v2，启用输入框和推送订阅入口，并在重新加载后重连，无页面错误/溢出。所有临时验证配对都被撤销。真实 Linux TUI 还运行了 `remote status`、`notifications status`、`remote direct status` 和 `inbox`，随后分离，而服务保持活动。
- 一条很长的排队提示以前会把整行撑到提示自身的宽度，于是排队区域可以被左右拖动：在 390px 下实测，容器宽 358px、可滚动内容 1184px，编辑/取消/插队三个按钮的右边缘落在 x=1188。原因与工具分组那次是同一个 grid 自动轨道问题——nowrap 的一行会把自己的整段文本宽度当作轨道最小值——因此给排队区域钉上 `minmax(0, 1fr)`，并明确不允许横向滚动。按钮保持尺寸，文本用省略号截断，完整提示仍留在该行的 `title` 上。正在运行的子代理列表存在同样的缺陷（标签很长时盒子 384px、内容 1154px），现在用同一行防护修掉了。`scripts/ui-check.mjs` 在桌面与手机两种宽度下都做了测量：旧 CSS 下报 `{"client":714,"scroll":1488}`，新 CSS 下通过。
- 折叠的工具行现在会说明这个调用在做什么：从它自己的参数里读出命令、路径或委派的任务，超出部分用省略号截断，整行仍然保留全文。连续调用在运行期间显示最新的一条，最后一次返回后变成汇总；展开一次运行会让调用在细线下缩进，而不是画出框套框。离线 Demo 现在会产生一次三连调用、最后一条保持 2.5 秒仍在执行，因为只看过「单条已完成调用」的客户端根本无法走到这个形态；`scripts/ui-check.mjs` 在 390px 下断言了实时行、汇总行、唯一的展开边框以及真实的截断。
- 选择会话的工作目录不再需要手动输入绝对路径。`workspace.list` 读取主机上的一层目录（只列文件夹、跳过点开头目录、符号链接指向文件夹时跟随，并用 `total` 说明该层被截断时的总数），PWA 新建会话对话框据此逐层选择，`turnwire dirs` 为终端打印同一份列表。主机读不了的文件夹返回 `WORKSPACE_UNREADABLE`，而不是看起来空着。三项 Core 测试覆盖列表、默认主目录、文件系统根目录与拒绝场景；`scripts/ui-check.mjs` 在 Chrome 里走一遍选择器（打开、上一级、主目录、使用该目录并写回输入框），`scripts/remote-resilience-check.mjs` 再在 390px 的加密连接上走一遍，要求操作按钮始终在屏幕内、列表只在自己的框里滚动。三个浏览器场景与 138 项测试全部通过。
- 切标签页改为复用 socket，而不是重连。隐藏 PWA 会保留已验证的加密 socket，只暂停重试计时；网络断开仍会立即丢弃 socket 并报告离线，"立即重连"也仍会有意重建会话。`scripts/remote-resilience-check.mjs` 现在断言隐藏再显示页面后健康栏仍为 `connected`，且不会打开第二个 WebSocket（此前该脚本断言的是相反行为）；`tests/connection-health.test.ts` 用可计数的对端 socket 钉住同一契约，并单独覆盖在隐藏期间真正断开的 socket。`npm run check` 通过 27 个文件中的 135 项测试，随后是该项 Chrome 检查和历史 Chrome 检查。

实际 iPhone/Safari 权限、锁屏 Web Push 投递、Wi-Fi/蜂窝切换、局域网 DNS/证书接受以及区域性推送 provider 可达性仍未验证。在用户提供合适的 WSS URL 和受信任证书之前，生产局域网 listener 保持关闭。当前通知 `queued` 统计的是等待 Relay 接受的 daemon outbox；Relay 接受并不证明 OS 通知已投递。
