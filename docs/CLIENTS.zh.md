[English](CLIENTS.md) · 中文

# 能力对等与代码归属

CLI、交互式终端（`turnwire tui`）和原生桌面都是同一个 Turnwire 主机的客户端。在相同的连接权限下，它们必须支持相同的产品操作，并观察到相同的状态。UI 机制可以不同：工作区路径 vs NSOpenPanel、终端二维码 vs NSImage，或打印链接 vs 剪贴板按钮。

## 代码归属

| 层次 | 职责 | 位置 |
| --- | --- | --- |
| 共享 protocol | 请求、结果、校验、事件与远程状态 | `packages/protocol` |
| 领域 | 会话、runtime 路由、审批、回执与事件持久化 | `packages/core` |
| Host 服务 | 远程模式状态、已保存设置、配对与传输生命周期 | `apps/daemon` |
| Relay | 经过认证的 host/device 路由、共享流量上限与公网 PWA 服务 | `apps/relay` |
| 服务器部署 | 可移植安装器、SSH 传输与文件/配置回滚 | `apps/deployer`；daemon 拥有任务与私有状态 |
| Provider 适配器 | 组件安装、provider 网络与子进程生命周期 | `apps/daemon/src/providers` |
| TypeScript 客户端传输 | 本地 RPC、类型化管理与加密远程连接 | `packages/sdk` |
| 终端呈现 | CLI 与 TUI 共用的单一命令注册表、prompt 与二维码渲染 | `apps/cli/src/program.ts`, `terminal.ts` |
| 原生呈现 | Swift 线上模型、API 客户端、SwiftUI 状态与控件 | 同级 `turnwire-desktop` |

`RemoteController` 从 daemon 入口点接收 provider 注册表。localhost.run、cpolar 和 Cloudflare 适配器拥有组件安装与前台进程生命周期。自托管 Relay 不依赖隧道。provider 选项与指引随远程状态一起返回，并由终端和原生客户端展示。cpolar 凭据保留在 daemon 私有状态中；只有 `hasCpolarToken` 会返回给客户端。

TUI 目前提供面向行的交互式命令界面，包括交互式 Relay 设置。它复用整个 CLI 命令注册表；它不是独立的全屏渲染器。`attach` 进入共享会话的对话；Ctrl+C 返回命令界面，且不会停止 Agent。输入被解析为参数，不经过 shell 求值。

## 当前能力覆盖

| 能力 | CLI | 交互式终端 | 原生桌面 |
| --- | --- | --- | --- |
| Host/runtime 状态与共享会话 | `status`, `ls` | 相同命令 | 侧栏与状态 |
| 在工作区中创建会话 | `dirs`，再 `new --cwd --runtime` | 相同命令 | 新建会话 / 文件夹选择器 |
| 插话引导正在运行的回合，或在其后排队 | `send --steer`（默认是排队） | 相同命令 | 回合运行时的输入框切换开关 |
| 发送消息并跟随历史/事件/工具 | `send`, `attach`（最近 40 条记录） | 相同命令 | 对话（最近 40 条记录） |
| 搜索 / 查看归档会话 | `ls --search`, `--archived`, `--all` | 相同命令 | 工作区分组、搜索与归档过滤 |
| 重命名 / 归档 / 恢复 | `rename`, `archive`, `unarchive` | 相同命令 | 会话菜单与上下文菜单 |
| 检查工具输入/输出、失败与历史 | `history <id> --before <cursor> --limit <count>`, `attach`, `--json` | 相同命令 | 对话 / 执行标签页；加载更早记录；可展开的工具详情 |
| 导出记录 | `export --output` | 相同命令 | 会话菜单 → 导出 |
| 恢复与取消 | `resume`, `stop` | 相同命令 | 恢复 / 停止 |
| 选择会话模型与 reasoning 强度 | `models`, `model <session> <provider>/<model> [--effort]`, `new --model` | 相同命令或模型菜单 | 会话模型选择器 |
| 持久审批收件箱与已处理/已过期历史 | `inbox`, `inbox --all --before` | 相同命令 | 收件箱，带 pending/all 过滤与分页 |
| 查询结果不确定的命令 | `result <request-id>` | 相同命令 | 收件箱 → 查询操作结果 |
| 配置局域网 TLS 桥接 | `remote direct configure --config`, `status`, `off` | 相同命令或表单/菜单 | 远程控制 → 局域网直连表单 |
| 配置主机推送投递 | `notifications on/off/status` | 相同命令或表单/菜单 | 远程控制 → 手机通知 |
| 升级配对凭据 | `devices upgrade <id> --qr` | 相同命令或菜单 | 已配对设备 → 重新配对 |
| 阅读并决定审批 | `approvals`, `approve`, `reject` | 相同命令 | 审批控件 |
| 选择临时或自托管远程访问 | `remote temporary`, `remote relay` | 相同命令或 `remote` 菜单 | 远程控制设置 |
| 部署 / 更新 Relay 服务器 | `deploy --config`, `deploy --status` 或交互式 `deploy` | 相同命令、表单或远程菜单项 | 自托管 Relay → 部署/更新服务器表单与私有 JSON 导入 |
| 选择 localhost.run / cpolar / Cloudflare | `remote temporary --provider localhost-run`（或 `cpolar`, `cloudflare`） | 相同命令或 provider 选择器；掩码显示的 cpolar Token | 隧道服务选择器；安全的 cpolar Token 输入框 |
| 查看进度 / 连接状态 | `remote status --watch` | 相同命令或菜单刷新 | 状态轮询 |
| 关闭远程访问或取消启动 | `remote off` | 相同命令或菜单 | 关闭远程访问 |
| 通过链接/配对码/二维码配对 | `devices pair --qr`, `--qr-file phone.png` | 相同命令或菜单 | 配对链接 / 二维码 |
| 列出并撤销设备 | `devices list`, `devices revoke` | 相同命令或菜单 | 设备列表 / 撤销 |
| 验证已配对设备的连接 | `devices list --watch`；远程客户端 `connection` | 相同命令；设备菜单显示最近确认 | 设备状态、最近确认与延迟，每 2 秒刷新 |
| 查看会话正在跑的后台子代理 | `agents <session>` | 相同命令 | 尚未支持 —— 见下方说明 |
| 修改还在排队的那条提示（改写、收回、插队） | `queue <session>`、`queue edit/remove/steer` | 相同命令 | 尚未支持 —— 见下方说明 |
| 把一个会话的审批委托出去（帮我批准） | `approve-for-me <session> [--off]` | 相同命令 | 尚未支持 —— 见下方说明 |
| 回答 Agent 正在等的问题 | `questions`、`answer <question> '标签' [--text …]` | 相同命令 | 尚未支持 —— 见下方说明 |

主机管理使用经过认证的本地 `/remote` 和 `/devices`。已配对手机或远程 CLI 可以操作会话和审批，但不能更改主机设置或配对更多设备。这是由 daemon 强制执行的连接权限边界，而不是缺失的 UI 功能。PWA 目前承担这一已配对手机角色。

后台子代理视图（`subagent.list`）、排队提示自己的三个操作、审批委托（`session.autoApprove`）、以及回答 Agent 的提问（`question.answer`）已在 PWA 和 CLI/交互终端中提供。桌面端对应功能还没做，所以上表那几格是真实的缺口，而不是平台差异。被委托的会话是唯一"批准之前没有人看过"的地方；而问题永远不会被委托，因为它没有安全的默认答案。

两个"文件夹选择器"并不是一回事：手机通过 `workspace.list` 走的是主机自己的目录，这也是远程连接下唯一有意义的选择器；`turnwire dirs` 让终端拿到同一份列表。桌面端的面板选的是 Mac 上的文件夹，因此只有桌面连的是本机 daemon 时才和主机一致；远程连接的桌面端仍然需要手动输入路径。

部署通过 `/deployment` 使用同一套本地权限边界。客户端提交 runtime 配置并显示共享的异步状态；它们自身从不运行 SSH 或安装服务。daemon 拥有该任务、持久化私有配置、从子进程中剥离模型凭据，并通过 `RemoteController` 连接已安装的 Relay。服务器地址、登录账号和 key 路径是必需的 runtime 输入。可选的高级设置可通过每个客户端中的共享 JSON 配置以及原生高级字段使用。关闭客户端不会中断任务；daemon 中断会被显式报告以便恢复。

## 变更验收

重命名和归档是由 Core 元数据与 journal 事件支撑的 protocol 命令。归档会保留历史、拒绝活动会话/待处理审批，并在恢复前阻止 resume/send。本地与加密客户端通过同一事件流看到变更。原生 Markdown 渲染、按会话草稿、结果视图、内容搜索和审批中心都是对共享记录的呈现。共享投影会丢弃不携带文本的 assistant 消息，因此在每个客户端中，仅由工具调用构成的回合会显示其工具块，而不是空气泡。回合运行期间发送的 prompt 默认排在它之后；当客户端要求时（`mode: steer`），也可以改为插话引导该回合；被记录的消息携带 `queued` 或 `steer`，因此每个客户端都能标注实际发生了哪一种。只有 `stop` 会取消回合，且它从不注入文本。

手机/PWA 把 assistant 事件文本渲染为 CommonMark + GFM（标题、列表、引用、行内/围栏代码、表格、任务列表、链接和脚注）。代码和宽表格在各自区域内滚动；代码可以复制。未完成的流式围栏会按代码渲染，并在完成后更新。该渲染器属于 web 呈现层：它不改变事件文本、CLI 历史/导出、原生渲染或共享会话规则。用户输入和原始工具结果保留其字面表示。原始 HTML 保持惰性，图像引用按既有图像策略显示为显式链接。原生应用已有自己的 Markdown 呈现；终端可以保留源格式。PWA 也选择会话模型与 reasoning 强度，入口是输入框中的一个 chip，按需展开，而不是放在会话标题中：手机打开会话时会固定在最新消息上，因此可滚动区域内的控件恰好会在最需要它的地方跑到屏幕外，而常驻展开的一行会让输入框失去键盘所需的高度。工具调用遵循同样的规则：折叠的行直接写出这个调用在做什么——它跑的命令、它读写的文件、它委派的任务——超出宽度用省略号截断，悬停或长按可以看到全文，因此没人需要为了弄清一条命令是什么而展开它。连续的工具调用在运行期间只占一行，显示最新的一条；最后一次返回后变成这次运行的汇总（「shell ×3 · 已返回」）。展开一次运行不会再画出框套框：调用在一条细线下面缩进，唯一的框是真正被打开的那一个调用。

行为特性应从其所属的共享层开始，然后通过所有适用的客户端暴露。检查来自一个客户端的命令是否能在另一个客户端中可见，且无需客户端特定的重启或数据库。对校验、授权和生命周期影响使用有意义的集成覆盖。Swift 实机测试提供跨语言契约检查。纯 UI 的便利功能可以留在其平台原生侧。

不得把 provider 可用性与主机注册混为一谈。Relay 连接可用并不能证明每个手机网络都能解析并到达其公网 origin。Cloudflare Quick Tunnel 是可选的开发用访问方式；为中国大陆选择固定 Relay 时，请使用部署指南。

手机始终显示连接栏，包括窄屏。`RemoteClient` 只有在与预期 Mac 完成一次加密 nonce 往返后才发布健康状态。它在前台时每 15 秒探测一次，5 秒后超时；回到前台时先确认并复用仍然持有的 socket，而不是重建——只有确实已经不存在的 socket 才会重建，因此切标签页不再等于重连。V2 还会等待主机对最终确认的确认。Mac 在把设备标记为已连接之前，需要对其自身新发出的 challenge 收到加密确认；如果没有再次确认，其肯定状态会在 25 秒后过期。仅凭 Relay 就绪和已保存的配对凭据无法产生肯定的连接状态。这些是近期的观察结果，不保证未来的连通性或后台 iOS 执行。

从游标 0 开始的显式事件订阅可能包含数千个加密事件。Relay 对手机施加其消息入口速率限制，而经过认证的主机可以重放该历史而不触发手机限制。帧大小与慢消费者缓冲上限对两种角色仍然强制执行。这是所有远程客户端共享的传输行为；不需要客户端特定的绕过方案或线上格式变更。该回归测试演练 4,000 个真实加密事件、健康确认以及随后的快照请求，并附带一项独立的手机洪泛拒绝检查。

### 按需会话历史

`history.page` 是一个共享的只读 Core RPC，供 SDK、CLI/TUI、Swift 和手机/PWA 使用。它按每条记录的首个事件序号向后分页（`before` 为排他），默认返回 40 条完整记录，并返回 `events`、`cursor`、`hasMore`、`nextBefore`。存储在保持原始 journal 不变的同时，维护消息、工具输入/结果对、审批请求/决议和错误的持久投影。已有数据库会以事务方式一次性回填。页面目标上限为 512 KiB（单条记录保持完整）；原始 `events.list` 仍可供 journal 消费者使用。

打开会话会立即加载最近一页，而不是从头加载数千个 token 片段。Swift 和 web 提供“加载更早记录”；CLI/TUI 显示下一条 `history --before` 命令。搜索和显示的记录数只覆盖已加载记录。完整导出是显式操作，仍会访问每一页（`export`、原生“导出完整会话…”）；`history --all` 也会读取所有页。加载更早的页面会保持阅读位置。

投影后的消息事件携带可选的 `originSeq`（原始显示顺序）和 `seq`（其最新合并的事件）。客户端增量归并实时事件，每 50 ms 批量提交可见更新，并缓存投影后的记录。页面合并会吸收直到页面游标的事件，并把更新的在途事件恰好重放一次。历史不得改变实时的会话/审批状态：快照优先于更早的元数据事件。Swift 从新快照和最近一页重连。仅请求的远程连接使用 `subscribe {after:"latest"}` 进行即时的加密健康校验；随后一个显式监听器从其请求的游标开始重放，涵盖快照/监听器竞态窗口。原始显式订阅保留完整重放语义。

校验：`tests/history.test.ts` 覆盖 4,000 个 delta、完整工具对、向后游标边界、并发更新、既有 journal 迁移、本地/加密对等以及快照非回归。CLI/TUI 对等测试演练同一分页命令。`scripts/native-live-check.mjs` 为原生分页/导出/实时更新检查种下相同的长历史形状。`scripts/history-ui-check.mjs` 在 390 px 视口下演练加密浏览器分页、滚动锚定、完成和重新加载。浏览器自动化不是真实 iPhone/蜂窝网络测试。

Linux 安装可以运行可选的 `turnwire-host.service` supervisor（`apps/daemon/src/host-service.ts`）和 `bin/turnwire tui`。它启动同一个 daemon 与 DSH runtime；TUI 仍是客户端，SSH/TUI 退出不拥有主机生命周期。生成的服务路径派生自安装目录。每台主机保留自己的私有身份、状态和远程配对。不会授予额外的远程管理权限。

### 远程传输 v2 与通知

所有 TS 客户端共享 SDK 的分阶段连接状态、带抖动的重试和会话加密。原生端仍为 Swift/SwiftUI，并使用相同的本地管理与 Core RPC。PWA 增加了浏览器特有的通知权限、Service Worker 展示以及可见性/在线提示；其收件箱和审批决定与 CLI/TUI/原生一样使用 Core。主机范围的通知管理仍仅限本地。远程用户只能订阅/退订自己的设备。

本地原生连接不会独立实现浏览器或 Relay 生命周期。其远程设置暴露直达 listener 配置、通知可用性/偏好、配对升级以及设备 protocol/enrollment 状态。手机通知投递使用模拟 provider 测试；实际的 iPhone 通知权限、锁屏投递和局域网证书接受需要设备测试。
