[English](PROTOCOL.md) · 中文

# Turnwire RPC v1 与远程传输 v2

`packages/protocol/src/index.ts` 是 TypeScript 的事实来源。Swift 的 `Models.swift` 独立解码同一线上表示；桌面测试校验代表性信封。

仅限本地的 `/deployment` 端点支持经过认证的 `GET` 状态与 `POST` 部署配置。形状定义在 `packages/protocol/src/deployment.ts`。POST 立即返回一个处于 `running` 状态的任务；客户端轮询 GET 直到 `succeeded`、`failed` 或 `interrupted`。配置包含 runtime 的 SSH/地址/安装设置，绝不包含原始私钥、登录密码或 Relay 凭据。daemon 持久化最新任务并拒绝并发启动。远程 RPC 方法不暴露部署管理。服务器安装完成后仍可能报告本地连接错误；其公网 URL 和 release 仍然可用于恢复。

## 命令

本地客户端向 `/rpc` 发起 POST，并带上 `Authorization: Bearer <local-token>`。请求：

```json
{"v":1,"id":"client-generated-uuid","method":"session.message","params":{"sessionId":"turnwire-session-id","text":"Continue the task"}}
```

成功：`{ "v": 1, "id": "...", "ok": true, "result": ... }`。失败：`{ "v": 1, "id": "...", "ok": false, "error": { "code": "...", "message": "..." } }`。

方法：`system.snapshot`、`session.create`、`session.resume`、`session.message`、`session.cancel`、`session.queue`、`session.queueAction`、`session.autoApprove`、`session.rename`、`session.archive`、`approval.decide`、`events.list`、`history.page`、`subagent.list`、`workspace.list`、`inbox.page`、`request.result`、`notifications.status`、`notifications.subscribe`、`notifications.unsubscribe`。输入在 daemon 边界处校验；主机无法解析或不知道的请求，只要还能读出 `id`，就会用发起方自己的 `id` 作答——未知方法正是旧主机遇到新客户端的情形，而一个无人认领的回复是远程客户端无法匹配的，调用方只能一直等到自己的超时，而不是看到错误。对于变更操作，请求 ID 跨重启持久化。完全相同的 ID/payload 会返回之前的回执。payload 变化则冲突。如果进程在预留之后、回执持久化之前死亡，Turnwire 会返回 `OUTCOME_UNKNOWN`，而不是重放一个可能已经完成的操作。这是至多一次的提交边界，并不声称分布式精确一次执行。

会话命令按会话串行化；cancel 保持独立，因此 Stop 不会排在慢 prompt 之后等待。审批命令按审批串行化。每个成功的决定只应用一次。Runtime 断开和 daemon 重启会取消未完成的审批。

`session.rename` 接受 `{ sessionId, title }`（去除首尾空白，1–200 个字符）。`session.archive` 接受 `{ sessionId, archived }`。两者都会发出 `session.updated`；归档保留历史，并拒绝运行中的会话或待处理审批。已归档会话必须先恢复才能 send/resume。可选的会话 `archived` 字段对较旧记录默认为 false。

工具事件通过 `callId` 关联：`tool.started.detail` 是输入，`tool.finished.detail` 是输出。可选的 `tool.finished.isError` 保留显式的 runtime 失败标志；标志缺失表示未知，而不是保证成功。客户端在重放时同时保留输入和输出。

## 事件

通过 WebSocket 连接本地 `/events`，并把 `{ "type": "auth", "token": "...", "after": 0 }` 作为第一帧发送。token 不出现在 URL 中。Turnwire 重放严格位于游标之后的 journal 事件，然后发送 `{ "type": "ready", "cursor": ... }` 并继续实时推送。

每个事件为 `{ "type": "event", "event": { "seq": 1, "time": "ISO-8601", "data": { "type": "session.created", ... } } }`。journal 序号在每个 Turnwire 状态数据库内全局且单调。状态更新及其事件在一个 SQLite 事务中提交。客户端历史检索通过 `events.list` 分页；客户端按序号合并，并按消息 ID 投影 assistant 的 delta/最终替换。

快照包含 `device`、`sessions`、`approvals`、`runtimes` 和 `cursor`。先获取快照，再从它的游标开始订阅。事件通过同一类型化模型为 CLI、PWA 和 SwiftUI 重放。

## 远程

Relay 使用部署密钥认证主机，并使用各自的 routing token 认证远程端。主机在连接后注册其允许的远程 ID 和 token。配对与撤销只能通过经过认证的**本地** `/devices` API 进行，不能通过可远程调用的方法进行。

新配对使用 v2；既有 RPC/事件信封仍为 v1。routing token 与设备认证凭据和流量密钥不同。`/devices` POST 创建 15 分钟、一次性的邀请。经过认证的本地 PUT 带 `{id}` 会显式替换已有设备的凭据并返回新邀请。GET 包含 `protocol` 和 `enrollment`（`legacy`、`pending`、`enrolled`）。已有 v1 设备继续受支持，不会被静默升级或降级。

### 会话握手

`packages/sdk/src/session-crypto.ts` 规定了字节编码：以 `turnwire.session.v2` 为前缀的 UTF-8 JSON 数组、固定字段顺序、十六进制凭据/MAC、base64 未压缩 P-256 公钥。双方每次连接都生成新的不可导出临时 ECDH 私钥。client hello 包含随机 256 位 nonce、公钥，以及对上下文和 client hello 的 HMAC-SHA-256 证明。服务器在分配会话前验证已配对设备凭据，创建自己的新 nonce/密钥对，并对完整转录（包括双方贡献和所选凭据索引）进行认证。

ECDH 共享字节输入 HKDF-SHA-256。其 salt 是转录的凭据 HMAC；其 info 绑定转录哈希与流量方向。Host 和 client 派生出各自独立的不可导出 AES-256-GCM 密钥。临时握手对象在派生后释放；JavaScript 不提供显式的 CryptoKey 销毁。之后泄露持久化的认证凭据本身并不能派生出更早的 ECDH 流量密钥。这里不声称具备入侵后恢复或逐消息双棘轮。

加密帧为 `{v:2, session, sequence, ciphertext}`。`session` 是转录的 SHA-256 哈希。每个方向在其新密钥下从零开始使用独立的 uint64 计数器。nonce 是四个零字节后跟大端计数器；AAD 绑定会话、发送角色和十进制序号。接收要求精确的下一个序号，验证 AEAD 和消息 schema 后才推进。反射、重放、跳号、篡改密文和旧会话帧都会被拒绝。发送/接收操作串行执行。计数器耗尽会关闭会话以重新协商密钥。`sentAt` 仍是元数据，不是 v2 的安全决策；设备之间的墙上时钟可能不同。

对于首次登记，客户端在消耗邀请之前，把新生成的设备凭据与邀请一起持久保存。加密的 `enroll` 消息把该凭据安装到主机上；`enrolled` 予以确认。随后客户端从已保存的配对中移除邀请材料。如果最终确认丢失，预先持久化的候选凭据可以认证新的 v2 握手；仅凭已被消耗的二维码则不能。允许两个 hello MAC，且仅用于恢复这一登记边界。主机在提交登记时检查其当前凭据。CLI 以 0600 权限原子写入配对文件；PWA 存储在会话存储中，除非用户选择受信任设备 / 启用通知。

V1 兼容性使用此前独立的设备 PSK、随机 96 位 nonce 和 60 秒时间戳窗口。只有 v2 配对才有资格参与直接路由。v2 失败绝不回退到 v1；请从主机显式重新配对。先升级 Relay 再升级主机：感知 v2 的主机注册会通告 `protocol:2`，Relay 把转发的 payload 和关闭请求绑定到连接 UUID，因此迟到的回复无法到达替换后的 socket。更新后的 Relay 仍接受旧版主机。

### 存活检测与路由

每个候选都有独立的传输、Relay 认证、握手和验证截止时间（每阶段默认 5 秒）。SDK 在已认证的已登记设备局域网 WSS 候选与 Relay 之间竞速；只有通过验证的胜者才会派发命令或订阅历史。初始登记使用 Relay，以避免相互竞争的登记尝试。当前直达候选在 E2EE `routes` 消息内刷新，绝不会从浏览器 SSID 推断。

客户端发送加密的 `ping {nonce}`；主机返回 `pong {nonce,challenge,hostId}`。客户端校验 nonce/host/截止时间，发送 `ack {challenge}`，并在 v2 中等待加密的 `confirmed {challenge}`。V1 保留其此前的客户端完成点。前台心跳默认 15 秒，探测截止时间默认 5 秒。RTT 使用单调时钟。主机存在状态在 25 秒后过期。已连接意味着最近验证过的双向路径，而不是保证未来的投递。

后台 PWA 的可见性事件会保留已建立的 socket，只暂停重试计时：重建一次已验证的加密会话代价很高，而隐藏的标签页通常仍然持有它；如果在后台期间 socket 真的断开，就等用户回来再重连。网络断开则不同——那种情况下 socket 无法存活，客户端会立即丢弃它并报告离线。前台/pageshow/online/网络变化提示会先确认幸存的 socket 仍有响应再复用它，确认失效时才立即重建（不等待后台退避），因此来回切标签页不会再出现可见的重连。用户主动点击"立即重连"时会有意重建加密会话，而不是信任可能已僵死的 socket。反复连接失败使用完全抖动的指数退避，上限 30 秒；认证失败需要用户操作。由单个 SDK owner 调度远程重试。UI 健康状态暴露路由、protocol、stage、attempt、已用时间、最近 RTT 和重试延迟，且不含密钥。历史重放跟随在验证之后，可以稍后完成。

RPC 变更回执本就独立于传输持久化。`request.result {requestId}` 返回 `not_found`、`pending`、`unknown` 或 `completed`，并带有已保存的响应。丢失连接不会自动重新提交命令。事件游标可恢复遗漏的事件；它们并不构成精确一次执行。

Relay 无法解密既有的 E2EE 帧，但能看到标识符、routing token、连接元数据、大小和时序。提供 PWA JavaScript 同样是一个信任边界：被攻陷的静态 origin 可以更改端点代码。Web Push 会在 Relay 处增加订阅端点/key 元数据和通用的通知时序；任务文本和审批详情仍留在主机和已配对客户端上。

## 本地信任

远程模式管理同样仅限本地：经过认证的 `GET /remote` 返回 `mode`、`state`、`message`、活动的公网 URL、已保存的 Relay 服务器 URL、`hasRelayToken` 和 provider `notices`；它从不返回主机密钥。较旧的 daemon 可能省略 notices。`PUT /remote` 接受 `{ "mode": "off" }`、`{ "mode": "temporary" }`，或 `{ "mode": "relay", "serverUrl": "https://turnwire.example.com", "token": "..." }`。提供的 token 包含 32–500 个字符，与 Relay 认证一致。仅当精确归一化后的服务器 URL 已有保存的 key 时，才可以省略 token。变更校验在停止旧传输之前完成。PUT 返回已接受的起始状态；调用方轮询 GET 直到在线或出错。

这些 schema 位于 `packages/protocol`。`LocalClient` 暴露类型化的 `remoteStatus`、`configureRemote`、`devices`、`pairDevice` 和 `revokeDevice` 方法；`RemoteClient` 不暴露任何管理方法。原生 Swift 使用匹配的线上模型和实机 daemon 契约测试。CLI 和 TUI 使用同一命令注册表和 SDK 调用。

临时配置还接受 `provider: "localhost-run" | "cpolar" | "cloudflare"` 以及可选的 `cpolarToken`。cpolar 首次使用需要一个 Token（1–500 个字母、数字、下划线、点或连字符）；后续请求可以复用已保存的值。为另一个 provider 提供 cpolar Token 会在断开连接之前被拒绝。GET 返回 `provider`、`providers: [{ id, name, description, requiresToken }]` 和 `hasCpolarToken`，从不返回 Token 本身。旧的已保存临时配置保留 Cloudflare 作为其 provider。cpolar 子进程读取私有的 0600 每次运行配置文件，并在退出时删除；凭据被排除在 argv 和 provider 环境之外。

daemon 串行化传输切换、取消待处理的启动，并拥有临时 Relay 和 provider 进程。临时隧道只暴露公网 PWA 资产和 Relay 转发。主机通过 loopback 连接此 Relay；已配对手机使用公网 WSS 端点。启动会等待 provider 的公网地址/注册，然后是主机在 Relay 的注册。公网 DNS 传播可能需要更久。地址变化会更新配对端点并使已显示的原生二维码失效。切换模式不会重启 Core 或 DSH。持久偏好覆盖环境引导默认值，包括显式选择关闭。只有在 Relay 注册完成后才能配对；刷新设备允许列表会立即使传输标记为未就绪，直到重新注册。

daemon 绑定到 `127.0.0.1`。Host header 与 origin 检查保护其浏览器表面。只有已配置的开发 origin 被允许跨源；默认允许 loopback 的 Vite origin。RPC 和设备管理需要随机本地 bearer token，并以仅所有者可读的文件权限持久化。PWA 资产是公开的，但不含连接密钥。Service worker 只缓存静态 shell/资产，不缓存 RPC 响应、会话历史或凭据。

本地 token 和每个已配对设备都对 Turnwire 配置的工作区拥有完全控制权。配对不会绕过 runtime 的工具审批。生产访问应使用 WSS 和受保护的静态 origin，示例部署让 Relay 端口保持在 Docker 内部。

## 分页历史

`history.page {sessionId, before?, limit?}` 从 Core 读取完整的投影历史记录。`limit` 为 1–100，默认 40；`before` 是排他的正数原始记录序号。响应 `{events, cursor, hasMore, nextBefore}` 包含紧凑消息事件、完整工具启动/结果对、审批和错误。`nextBefore` 在最旧一页为 null。cursor 是页面捕获时的 journal watermark，而不是最旧记录。`originSeq` 在事件上可选，保留被压缩消息的原始位置；`seq` 是其最新包含版本。原始事件订阅和 `events.list` 保持原有含义。

加密的 `subscribe` 接受数字 `after` 或 `"latest"`。后者从当前 journal 游标开始，避免为连接健康检查或快照请求进行历史重放。显式事件监听器从快照游标开始订阅，以覆盖并发变更。客户端不得把位于或早于其快照游标的元数据事件应用到当前状态。页面获取与实时事件使用页面 watermark 进行对账，watermark 之后的 delta 只应用一次。

## Agent 在等回答的问题

`question.answer {questionId, answers}` 回答正在运行的 Agent 阻塞等待的那一批问题；快照通过 `questions` 携带待回答的那些，`question.requested` / `question.resolved` 记录提问与选择。runtime 通过与审批相同的 Remote waterfall（`user-questions/request`）提问，因此正在关注该会话的客户端会收到问题，没有关注的客户端会把它交给主机的其他回答者，而不是替别人回答。

回答用的是 runtime 自己的形状 —— `[{id, selected: [...], custom?}]` —— 整批一起发送，因为主机是把这一批当作一个决定来问的。与审批不同，这里没有任何委托：问题没有安全的默认答案，所以"帮我批准"永远不会替它作答。

## 代别人批准

`session.autoApprove {sessionId, enabled}` 把一个会话的审批委托出去：打开期间，每个 `approval.requested` 一到就直接批准，而不是等人回答；打开时也会先处理已经等着的那些。runtime 的词汇是封闭的 —— `allowed-once` 是它唯一的授权 —— 所以这是 Turnwire 在同一个 `approval.decide` 路径之上做的决定，不是 runtime 的策略。

有两点让它保持诚实。会话字段 `autoApprove` 是主机状态而不是存储字段：它出现在快照里，重启即忘 —— 委托针对的是当下正在做的事，重启后应该有人再看一眼。这样产生的批准会在 `approval.resolved` 上带 `approval.auto: true`，记录因此说明没人被问过；只写 `approved` 是看不出来的。

## 选择工作目录

`workspace.list {path?}` 返回主机上某一个文件夹的 `{path, home, parent?, total, entries}`，让客户端可以选择会话的 `cwd`，而不是要求人手动输入一个绝对路径——在手机上这正是问题所在。它只列文件夹、跳过点开头目录，并在符号链接指向文件夹时跟随它；`total` 是该层文件夹的总数，因此当某个扁平目录（比如 `node_modules`）超过上限时，客户端可以说明自己只显示了一页。文件系统根目录没有 `parent`，不传 `path` 时默认从主机主目录开始。主机读不了的文件夹返回 `WORKSPACE_UNREADABLE`，而不是看起来空着；路径校验与 `session.create` 相同，所以这里列出的目录都能真正承载会话。它是读取：不预留请求 ID，客户端按轮询 `system.snapshot` 的方式调用它。

## 还没跑的那条提示

`session.queue {sessionId}` 返回 `{items: [{messageId, target, text}]}` —— 还在排队的提示，`next-turn` 在 `next-step` 之前。它是读取，因此刚加载页面的客户端不必"看着队列长出来"就能渲染它；`text` 是 runtime 自己那份，所以任何一端改过的内容，其他端看到的都是改后的。

runtime 已经开始执行的提示既不在队列里，也不可再改：它会从 `session.queue` 消失，对它的操作返回 `QUEUE_ITEM_STARTED`，而不会再被转发出去。runtime 在把提示交给模型之后仍会保留一段时间的 inbox 条目，并且会接受对它的修改——这正是「取消了却还是收到」和「行从所有客户端消失、模型却在回答它」的成因。主机知道自己何时宣布它开始，因此就以这个事实作答。

`session.queueAction {sessionId, messageId, action}` 修改一条还排在运行中回合后面的提示。`messageId` 是客户端拿到的那条消息的 id；runtime 会把它翻译成自己队列里的条目，因此已经过期的行只会失败，不会改到别的提示上。动作有三种：`{kind:"edit", text}`、`{kind:"remove"}`、`{kind:"steer"}` —— 改写它、收回它，或者把它送进正在运行的那个回合。已经离开队列的提示返回 `QUEUE_ITEM_GONE`。

journal 记录的是提示最初发出时的样子，所以结果会写回：编辑发出带新 `text` 的 `message.updated`，插队发出 `steer: true` 的 `message.updated`，收回发出 `message.removed`，后者会把这条消息从所有投影里删掉。没有这一步，记录就会描述一条并非真正运行的提示，或者一条根本没跑过的提示。

## 后台子代理

`subagent.list {sessionId}` 返回 `{subagents: SubagentView[]}` —— 一个会话委派出去的子代理，直接子代理在前，嵌套的在后。委派工具把活交给子代理后立即返回，所以父会话自己的记录显示不出子代理在做什么；这就是那个视图。每一项为 `{id, parentId, depth, label, mode, activity, elapsedMs?, todos}`：`label` 是委派时带的简短描述，`activity` 是运行时对子代理是否仍在工作的实时判断，`elapsedMs` 是它已运行（或最终运行）的时长，`todos` 是子代理自己维护的计划。它是读取而不是变更：不预留请求 ID，客户端按轮询 `system.snapshot` 的方式轮询它。无法枚举子代理的运行时返回空列表而不是报错，客户端于是什么都不显示，而不是失败。

## 收件箱与 Web Push

`inbox.page {status?:"pending"|"all", before?, limit?}` 返回 `{items:[{position,approval,sessionTitle}],nextBefore,cursor}`。position 在决议过程中保持稳定，页面默认 40 项。权威收件箱与审批一起在 Core 事务中持久化。已决议和已取消的项仍可读取；daemon 重启会取消待处理的实时 runtime 审批，而不是使之复活。

`notifications.status` 暴露可用性以及此经过认证客户端的订阅状态。订阅/退订使用由传输提供的远程身份，而不是调用方提供的 device ID。本地 `/notifications` GET/PUT 控制主机范围的投递。全局设置、私有订阅和由 journal 游标驱动的 outbox 位于 daemon 上。Relay 把 VAPID key、订阅和去重的投递队列持久化到私有 SQLite 文件中。只有经过认证的主机才能为其当前允许列表中的设备发出 push-control 帧；provider 端点被限制为受支持的 HTTPS 服务。过期订阅会被移除；瞬时投递失败会在队列 TTL 内重试。

推送内容始终是通用的收件箱提示，不包含命令、标题、审批 ID、代码或工具参数。Service worker 显示一条通知并打开/聚焦收件箱；它绝不做审批决定。浏览器权限在用户手势中请求。需要安装到 iOS 主屏幕。Web Push 依赖稳定的 origin 和醒着的主机来产生新工作；它不承诺后台 WebSocket 执行，也不会唤醒睡眠中的电脑。

## 隔离的局域网 listener

经过认证的本地 `/direct` GET/PUT 配置一个独立的 HTTPS/WSS 服务器、受信任的证书/私钥路径、对外通告的 URL、绑定地址和端口。配置是 runtime 输入。网络接口地址只是主机表单的候选项；它们不是可达性的证明。URL 必须使用 WSS 并与配置的证书匹配。DNS 解析、浏览器 CA 信任和本地网络权限也必须在手机上可用。产品代码中不存在不安全的 `ws://` 回退或证书校验绕过。

直达 listener 只接受已配对的 v2 E2EE 流量，检查浏览器 origin，并对 HTTP 管理路由返回 404。loopback 的管理/DSH 端口保持独立。关闭远程也会禁用直达 listener；直达偏好仍会被保存以备下次启用。证书在 listener 启动时加载；替换证书文件后，请重新应用配置以重新加载。不包含局域网证书的自动签发。
