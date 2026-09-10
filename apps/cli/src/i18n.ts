import { turnwireErrorCodes } from '@turnwire/protocol';

/**
 * The CLI is internationalised per client: error codes are shared in `packages/protocol`, while
 * the sentences a human reads live here. English is the default locale, Chinese is kept as the
 * second locale, and `TURNWIRE_LANG` / `LC_ALL` / `LANG` or `--lang` choose between them.
 */
export type Locale = 'en' | 'zh';
export const locales: readonly Locale[] = ['en', 'zh'];

export function isLocale(value: unknown): value is Locale { return value === 'en' || value === 'zh'; }

/**
 * First non-empty of TURNWIRE_LANG, LC_ALL and LANG wins, so an explicit TURNWIRE_LANG overrides
 * the shell locale; anything that starts with `zh` is Chinese and everything else is English.
 */
export function detectLocale(env: Record<string, string | undefined> = process.env): Locale {
  for (const value of [env.TURNWIRE_LANG, env.LC_ALL, env.LANG]) if (value) return /^zh/i.test(value) ? 'zh' : 'en';
  return 'en';
}

/** Reads `--lang zh` / `--lang=zh` from already-parsed arguments (the program pre-scans argv). */
export function localeFromArgv(argv: readonly string[] = process.argv.slice(2)): Locale | undefined {
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === '--lang') { const candidate = argv[index + 1]; if (isLocale(candidate)) return candidate; }
    else if (value.startsWith('--lang=')) { const candidate = value.slice('--lang='.length); if (isLocale(candidate)) return candidate; }
  }
  return undefined;
}

let active: Locale | undefined;
/** The locale of the current process; falls back to environment detection on first use. */
export function locale(): Locale { return active ?? (active = detectLocale()); }
export function setLocale(value: Locale): void { active = value; }

type MessageParams = Record<string, string | number>;

function render(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

const en = {
  'program.description': 'Turnwire: one local agent session, every device.',
  'option.url': 'daemon URL',
  'option.token': 'local daemon token',
  'option.pairing': 'remote pairing file',
  'option.json': 'machine-readable output',
  'option.lang': 'UI language: en or zh',

  'command.status': 'Show daemon, device and runtime status',
  'command.ls': 'List shared sessions',
  'command.rename': 'Rename a shared session',
  'command.archive': 'Archive an inactive session without deleting history',
  'command.unarchive': 'Return an archived session to the workspace',
  'command.new': 'Create a session in a workspace',
  'command.models': 'List the models this host can run and the default for new sessions',
  'command.model': 'Choose the model a session runs on (provider/model; see: turnwire models)',
  'command.history': 'Read recent complete records; load earlier records with --before',
  'command.export': 'Export the shared transcript as Markdown',
  'command.send': 'Send a follow-up prompt',
  'command.resume': 'Resume a persisted session',
  'command.stop': 'Cancel the current agent turn',
  'command.result': 'Query a command result after a lost response',
  'command.inbox': 'Persistent approval inbox',
  'command.approvals': 'List pending approvals',
  'command.approve': 'Approve one pending operation',
  'command.reject': 'Reject one pending operation',
  'command.attach': 'Follow output and send prompts; Ctrl+C detaches without stopping the agent',
  'command.connection': 'Verify a fresh round trip to the host',
  'command.connect': 'Print local connection details for the PWA',
  'command.devices': 'Pair and revoke remote devices (local authorization required)',
  'command.devices.upgrade': 'Replace an existing pairing with a one-time v2 enrollment QR',
  'command.remote': 'Choose temporary access or a self-hosted Relay',
  'command.remote.temporary': 'Start a temporary public address',
  'command.remote.relay': 'Connect a self-hosted Relay; reads TURNWIRE_RELAY_TOKEN or retains the saved key for this URL',
  'command.remote.off': 'Disable remote access while keeping local sessions running',
  'command.deploy': 'Deploy/update a Relay server through the local daemon',
  'command.notifications': 'Manage host push delivery; phone permission is requested in the PWA',
  'command.direct': 'Configure the isolated TLS LAN bridge',
  'command.tui': 'Interactive terminal using the same commands and capabilities as CLI',

  'option.archived': 'show archived sessions',
  'option.all': 'include archived sessions',
  'option.search': 'filter by title or workspace',
  'option.cwd': 'workspace directory',
  'option.title': 'session title',
  'option.runtime': 'runtime id (dsh or demo)',
  'option.model': 'model to run the session on; see: turnwire models',
  'option.effort': 'reasoning effort id for the chosen model',
  'option.before': 'load the page before this cursor',
  'option.limit': 'records per page (1–100)',
  'option.allTranscript': 'explicitly load the complete transcript',
  'option.output': 'write a private file without overwriting an existing file',
  'option.steer': 'steer the turn that is already running instead of queueing behind it',
  'option.inboxAll': 'include resolved and expired items',
  'option.inboxBefore': 'load older items',
  'option.watchDevices': 'follow verified device connection state',
  'option.deviceName': 'device name',
  'option.qr': 'show a pairing QR in the terminal',
  'option.qrFile': 'save a private PNG QR without overwriting files',
  'option.qrNew': 'show the new QR',
  'option.deployConfig': 'private JSON deployment configuration',
  'option.status': 'read deployment state without starting work',
  'option.noWait': 'return immediately; deployment continues in the daemon',
  'option.watchRemote': 'follow connection status; Ctrl+C exits without changing access',
  'option.provider': 'cloudflare, cloudflare-named, localhost-run or cpolar; defaults to the saved provider',
  'option.tunnelName': 'named tunnel: tunnel name or id already registered with Cloudflare',
  'option.tunnelHostname': 'named tunnel: public hostname routed to that tunnel',
  'option.tunnelCredentials': 'named tunnel: provider credential file, readable on this host',
  'option.tunnelProtocol': 'named tunnel: auto, http2 or quic',
  'option.jsonConfig': 'private JSON configuration',

  'status.summary': '{device} · {count} sessions',
  'session.archived': 'archived',
  'new.title.default': 'New session',
  'new.success': 'Session {id}\nModel: {model}\nAttach: turnwire attach {id}',
  'model.unset': 'not specified (using the runtime default)',
  'models.default': 'Default: {model}',
  'models.group': '\n{name} ({id})',
  'models.groupNotRoutable': '\n{name} ({id}) · currently not servable',
  'models.effort': '  effort: {efforts}{default}',
  'models.effortDefault': ' (default {effort})',
  'models.failure': '\nUnavailable: {name} ({id}) — {message}',
  'history.steer': ' (steer)',
  'history.queued': ' (queued)',
  'history.io': 'Input:\n{input}\nOutput:\n{output}',
  'history.pending': 'Not returned yet',
  'history.earlier': 'Earlier records: turnwire history {session} --before {cursor}',
  'history.failed': ' · failed',
  'role.you': 'You',
  'role.error': 'Error',
  'role.assistant': 'Turnwire',
  'attach.approval': '\nApproval: {tool}\n{reason}\nturnwire approve {id}\nturnwire reject {id}',
  'connection.verified': 'Verified connection to the host',
  'device.defaultName': 'My phone',

  'terminal.promptNeedsTty': 'The interactive interface needs a terminal; use turnwire subcommands in scripts',
  'terminal.entry': 'Phone entry: {url}',
  'pairing.link': 'Phone pairing link:\n{text}',
  'pairing.code': 'Pairing code (paste it into the phone page):\n{text}',
  'pairing.qrTooNarrow': 'The QR needs at least {width} columns. Enlarge the terminal, or use --qr-file pairing.png.',
  'pairing.relayNoUrl': 'Relay has no phone web address yet; use the pairing code',
  'pairing.qrSaved': 'Pairing QR: {path}',
  'remote.title': '\nRemote control · {mode}{provider} · {state}\n{message}',
  'remote.menu': '1 Temporary tunnel   2 Self-hosted Relay   3 Disable remote access\n4 Pair phone   5 Paired devices   6 Revoke device   7 Refresh status   8 One-click server deployment   9 LAN direct   10 Notifications   11 Upgrade device pairing   0 Back',
  'remote.choose': 'Choose > ',
  'remote.chooseProvider': 'Choose a temporary tunnel (leave empty to go back) > ',
  'remote.invalidProvider': 'Invalid tunnel number',
  'remote.cpolarTokenSaved': 'cpolar Auth Token (saved, may be empty) > ',
  'remote.cpolarToken': 'cpolar Auth Token > ',
  'remote.tunnelName': 'Tunnel name or ID > ',
  'remote.tunnelHostname': 'Public hostname > ',
  'remote.tunnelCredentials': 'Credentials file path (readable on this host) > ',
  'remote.tunnelProtocol': 'Transport protocol auto/http2/quic [http2] > ',
  'remote.namedTunnelFields': 'A named tunnel needs a tunnel name, public hostname and credentials file',
  'remote.tunnelProtocolInvalid': 'Transport protocol must be auto, http2 or quic',
  'remote.relayServer': 'Server address{saved} > ',
  'remote.relayServerSaved': ' (leave empty to use {url})',
  'remote.relayToken': 'Relay connection key (empty keeps the saved server) > ',
  'remote.upgradeDevice': 'Device number to upgrade (its pairing becomes invalid; empty to go back) > ',
  'remote.deviceName': 'Device name (default: {default}) > ',
  'remote.deviceConfirmed': ' · last confirmed {time}',
  'remote.deviceUnconfirmed': ' · phone connectivity not confirmed yet',
  'remote.revokeDevice': 'Device number to revoke (leave empty to go back) > ',
  'remote.invalidDevice': 'Invalid device number',
  'remote.choiceRange': 'Choose 0–8',
  'deploy.running': 'Deployment continues in the daemon; Ctrl+C only exits the progress view.',
  'deploy.intro': 'One-click Relay deployment · Debian/Ubuntu + systemd\nUses an SSH key or agent; the account needs administrator rights or passwordless sudo. Configuration stays in private local state; the server generates and keeps the connection key.',
  'deploy.configPath': 'Private JSON configuration path (empty to fill the form; Ctrl+C to go back) > ',
  'deploy.label.host': 'SSH server IP / domain',
  'deploy.label.sshUser': 'SSH login account',
  'deploy.label.identityFile': 'Absolute SSH private key path (empty to use the agent)',
  'deploy.label.publicAddress': 'Phone entry IP / domain',
  'deploy.label.email': 'Certificate email (optional)',
  'deploy.saved': ' [saved: {value}]',
  'deploy.port': 'SSH port [{port}] > ',
  'deploy.connectAfter': 'Connect to this host after deployment? [Y/n] > ',
  'tui.intro': 'Turnwire interactive terminal\nCommands match the CLI; type remote to open remote settings, attach <session ID> to continue a conversation.\nType help for commands, quit to exit. Exiting does not stop tasks.',
  'tui.already': 'Already in the interactive terminal',
  'tui.prompt': 'turnwire > ',
  'direct.title': '{message}\nLocal candidate addresses: {addresses}',
  'direct.none': 'none',
  'direct.choose': '1 Configure and enable LAN direct   2 Disable   0 Back > ',
  'direct.field.url': 'WSS address (domain resolving to the LAN host)',
  'direct.field.listenHost': 'Listen address (default 0.0.0.0)',
  'direct.field.port': 'Listen port (leave empty to use the WSS address port)',
  'direct.field.certificatePath': 'Certificate path trusted by the browser',
  'direct.field.privateKeyPath': 'Private key path',
  'notifications.title': '{message}\nPending delivery: {queued}',
  'notifications.choose': '1 Allow phone notification subscriptions   2 Disable host notifications   0 Back > ',
  'command.parseIncomplete': 'Unterminated quote or escape',
};

const zh: Record<keyof typeof en, string> = {
  'program.description': 'Turnwire：一个本地代理会话，连接每台设备。',
  'option.url': 'daemon URL',
  'option.token': '本地 daemon token',
  'option.pairing': '远程配对文件',
  'option.json': '机器可读输出',
  'option.lang': '界面语言：en 或 zh',

  'command.status': '显示 daemon、设备与运行时状态',
  'command.ls': '列出共享会话',
  'command.rename': '重命名共享会话',
  'command.archive': '归档非活动会话，不删除记录',
  'command.unarchive': '将已归档会话恢复到工作区',
  'command.new': '在工作区创建会话',
  'command.models': '列出此主机可运行的模型，以及新会话的默认模型',
  'command.model': '选择会话运行的模型（provider/model；参见：turnwire models）',
  'command.history': '读取最近的完整记录；用 --before 加载更早记录',
  'command.export': '将共享记录导出为 Markdown',
  'command.send': '发送后续提示',
  'command.resume': '恢复已持久化的会话',
  'command.stop': '取消当前代理回合',
  'command.result': '响应丢失后查询命令结果',
  'command.inbox': '持久审批收件箱',
  'command.approvals': '列出待处理审批',
  'command.approve': '批准一个待处理操作',
  'command.reject': '拒绝一个待处理操作',
  'command.attach': '跟随输出并发送提示；Ctrl+C 断开但不会停止代理',
  'command.connection': '验证到主机的最新往返连接',
  'command.connect': '打印 PWA 的本机连接信息',
  'command.devices': '配对和撤销远程设备（需要本机授权）',
  'command.devices.upgrade': '用一次性 v2 注册二维码替换现有配对',
  'command.remote': '选择临时访问或自托管 Relay',
  'command.remote.temporary': '启动临时公网地址',
  'command.remote.relay': '连接自托管 Relay；读取 TURNWIRE_RELAY_TOKEN 或保留该地址已保存的密钥',
  'command.remote.off': '关闭远程访问，同时保持本机会话运行',
  'command.deploy': '通过本机 daemon 部署/更新 Relay 服务器',
  'command.notifications': '管理主机推送；手机权限在 PWA 中请求',
  'command.direct': '配置隔离的 TLS 局域网桥接',
  'command.tui': '交互式终端，命令与能力与 CLI 一致',

  'option.archived': '显示已归档会话',
  'option.all': '包含已归档会话',
  'option.search': '按标题或工作区过滤',
  'option.cwd': '工作区目录',
  'option.title': '会话标题',
  'option.runtime': '运行时 ID（dsh 或 demo）',
  'option.model': '会话运行的模型；参见：turnwire models',
  'option.effort': '所选模型的思考强度 ID',
  'option.before': '加载此游标之前的页',
  'option.limit': '每页记录数（1–100）',
  'option.allTranscript': '显式加载完整记录',
  'option.output': '写入私有文件，不覆盖已有文件',
  'option.steer': '插话到正在运行的回合，而不是排队等待',
  'option.inboxAll': '包含已处理与已过期条目',
  'option.inboxBefore': '加载更早条目',
  'option.watchDevices': '跟随已验证的设备连接状态',
  'option.deviceName': '设备名称',
  'option.qr': '在终端显示配对二维码',
  'option.qrFile': '保存私有 PNG 二维码，不覆盖已有文件',
  'option.qrNew': '显示新二维码',
  'option.deployConfig': '私有 JSON 部署配置',
  'option.status': '只读取部署状态，不启动工作',
  'option.noWait': '立即返回；部署在 daemon 中继续',
  'option.watchRemote': '跟随连接状态；Ctrl+C 退出且不改变访问配置',
  'option.provider': 'cloudflare、cloudflare-named、localhost-run 或 cpolar；默认使用已保存的 provider',
  'option.tunnelName': '命名隧道：已在 Cloudflare 注册的隧道名称或 ID',
  'option.tunnelHostname': '命名隧道：路由到该隧道的公开域名',
  'option.tunnelCredentials': '命名隧道：provider 凭证文件，需在本机可读',
  'option.tunnelProtocol': '命名隧道：auto、http2 或 quic',
  'option.jsonConfig': '私有 JSON 配置',

  'status.summary': '{device} · {count} 个会话',
  'session.archived': '已归档',
  'new.title.default': '新会话',
  'new.success': '会话 {id}\n模型：{model}\n接入：turnwire attach {id}',
  'model.unset': '未指定（使用运行时默认）',
  'models.default': '默认：{model}',
  'models.group': '\n{name} ({id})',
  'models.groupNotRoutable': '\n{name} ({id}) · 当前不可服务',
  'models.effort': '  思考强度：{efforts}{default}',
  'models.effortDefault': '（默认 {effort}）',
  'models.failure': '\n不可用：{name} ({id}) — {message}',
  'history.steer': '（插话）',
  'history.queued': '（排队发送）',
  'history.io': '输入：\n{input}\n输出：\n{output}',
  'history.pending': '尚未返回',
  'history.earlier': '更早记录：turnwire history {session} --before {cursor}',
  'history.failed': ' · 失败',
  'role.you': '你',
  'role.error': '错误',
  'role.assistant': 'Turnwire',
  'attach.approval': '\n审批：{tool}\n{reason}\nturnwire approve {id}\nturnwire reject {id}',
  'connection.verified': '已验证连接到主机',
  'device.defaultName': '我的手机',

  'terminal.promptNeedsTty': '交互界面需要终端；脚本请使用 turnwire 的子命令',
  'terminal.entry': '手机入口：{url}',
  'pairing.link': '手机配对链接：\n{text}',
  'pairing.code': '配对码（粘贴到手机页面）：\n{text}',
  'pairing.qrTooNarrow': '二维码需要至少 {width} 列。请放大终端，或使用 --qr-file pairing.png。',
  'pairing.relayNoUrl': 'Relay 尚未配置手机网页地址，请使用配对码',
  'pairing.qrSaved': '配对二维码：{path}',
  'remote.title': '\n远程控制 · {mode}{provider} · {state}\n{message}',
  'remote.menu': '1 临时隧道   2 自托管 Relay   3 关闭远程访问\n4 配对手机   5 已配对设备   6 撤销设备   7 刷新状态   8 一键部署服务器   9 局域网直连   10 通知   11 升级设备配对   0 返回',
  'remote.choose': '选择 > ',
  'remote.chooseProvider': '选择临时通道（留空返回）> ',
  'remote.invalidProvider': '通道序号无效',
  'remote.cpolarTokenSaved': 'cpolar Auth Token（已保存，可留空）> ',
  'remote.cpolarToken': 'cpolar Auth Token > ',
  'remote.tunnelName': '隧道名称或 ID > ',
  'remote.tunnelHostname': '公开域名 > ',
  'remote.tunnelCredentials': '凭证文件路径（本机可读）> ',
  'remote.tunnelProtocol': '传输协议 auto/http2/quic [http2] > ',
  'remote.namedTunnelFields': '命名隧道需要隧道名称、公开域名和凭证文件',
  'remote.tunnelProtocolInvalid': '传输协议只能是 auto、http2 或 quic',
  'remote.relayServer': '服务器地址{saved} > ',
  'remote.relayServerSaved': '（留空使用 {url}）',
  'remote.relayToken': 'Relay 连接密钥（已保存的同一服务器可留空）> ',
  'remote.upgradeDevice': '升级设备序号（原配对将失效，留空返回）> ',
  'remote.deviceName': '设备名称（默认：{default}）> ',
  'remote.deviceConfirmed': ' · 最近确认 {time}',
  'remote.deviceUnconfirmed': ' · 尚未确认手机连通',
  'remote.revokeDevice': '撤销设备序号（留空返回）> ',
  'remote.invalidDevice': '设备序号无效',
  'remote.choiceRange': '请选择 0–8',
  'deploy.running': '部署在 daemon 中继续；Ctrl+C 只退出进度查看。',
  'deploy.intro': '一键部署 Relay · Debian/Ubuntu + systemd\n使用 SSH 私钥或 agent，账号需要管理员权限或免密 sudo。配置保存在本机私有状态，服务器生成并保留连接密钥。',
  'deploy.configPath': '私有 JSON 配置路径（留空填写表单；Ctrl+C 返回）> ',
  'deploy.label.host': 'SSH 服务器 IP / 域名',
  'deploy.label.sshUser': 'SSH 登录账号',
  'deploy.label.identityFile': 'SSH 私钥绝对路径（留空使用 agent）',
  'deploy.label.publicAddress': '手机入口 IP / 域名',
  'deploy.label.email': '证书邮箱（可选）',
  'deploy.saved': ' [已保存：{value}]',
  'deploy.port': 'SSH 端口 [{port}] > ',
  'deploy.connectAfter': '部署后连接本机？[Y/n] > ',
  'tui.intro': 'Turnwire 交互终端\n命令与 CLI 相同；输入 remote 打开远程设置，attach <会话 ID> 接续对话。\n输入 help 查看命令，quit 退出。退出不会停止任务。',
  'tui.already': '当前已在交互终端中',
  'tui.prompt': 'turnwire > ',
  'direct.title': '{message}\n本机候选地址：{addresses}',
  'direct.none': '暂无',
  'direct.choose': '1 配置并开启局域网直连   2 关闭   0 返回 > ',
  'direct.field.url': 'WSS 地址（域名解析到局域网主机）',
  'direct.field.listenHost': '监听地址（默认 0.0.0.0）',
  'direct.field.port': '监听端口（留空使用 WSS 地址端口）',
  'direct.field.certificatePath': '浏览器信任的证书路径',
  'direct.field.privateKeyPath': '私钥路径',
  'notifications.title': '{message}\n待投递：{queued}',
  'notifications.choose': '1 允许手机订阅通知   2 关闭主机通知   0 返回 > ',
  'command.parseIncomplete': '引号或转义尚未结束',
};

export type TextKey = keyof typeof en;
export const messages: Record<Locale, Record<TextKey, string>> = { en, zh };

/**
 * Error text is keyed by the shared error code, so a server code and a client-side validation
 * failure resolve through the same lookup. `--json` deliberately bypasses this and prints the
 * server's own message.
 */
const enErrors = {
  INVALID_REQUEST: 'Invalid request',
  INTERNAL_ERROR: 'Internal error',
  UNAUTHORIZED: 'The connection token is invalid; reconnect',
  AUTHENTICATION_FAILED: 'Encrypted connection verification failed; pair again or update the host',
  ADMIN_ERROR: 'Host administration failed',
  HTTP_ERROR: 'Turnwire returned an HTTP error',
  OUTCOME_UNKNOWN: 'The connection was interrupted; query the request result before retrying',
  REQUEST_CONFLICT: 'That request id was already used by another command',
  REQUEST_PENDING: 'This request is still waiting for a result',
  NOT_AVAILABLE: 'Enable or disable device notifications from a paired phone',
  INVALID_WORKSPACE: 'The workspace must be an existing absolute directory',
  INVALID_CURSOR: 'The event cursor is beyond the host journal; read state again',
  SESSION_NOT_FOUND: 'Session not found',
  SESSION_BUSY: 'Stop the task or resolve approvals before archiving the session',
  SESSION_ARCHIVED: 'Restore the session before continuing',
  RESUME_REQUIRED: 'Resume this session before sending a message',
  APPROVAL_EXPIRED: 'The approval was already handled or expired',
  MODEL_SELECTION_UNSUPPORTED: 'This runtime does not support model selection',
  MODEL_UNAVAILABLE: 'The selected model is not available; choose again from the model catalog',
  RUNTIME_UNAVAILABLE: 'The requested runtime is not configured',
  DISCONNECTED: 'The remote connection is unavailable',
  CONNECTION_FAILED: 'Connection failed',
  HOST_OFFLINE: 'The host is offline',
  REMOTE_ERROR: 'The host rejected the connection; check host diagnostics',
  HANDSHAKE_REUSED: 'The handshake already finished',
  REKEY_REQUIRED: 'The encrypted connection must be re-established',
  REPLAYED_MESSAGE: 'Encrypted session or message sequence mismatch',
  EXPIRED_MESSAGE: 'Device clocks differ by more than a minute; sync device time',
  RATE_LIMITED: 'Too many remote messages',
  INVALID_CIPHERTEXT: 'Invalid encrypted payload',
  STAGE_TIMEOUT: 'A connection stage timed out',
  PROBE_TIMEOUT: 'The connection probe timed out',
  DSH_AUTH_REQUIRED: 'Set TURNWIRE_DSH_TOKEN, or set TURNWIRE_DSH_URL to the full URL DSH prints at startup',
  DSH_AUTH_FAILED: 'The DSH startup token is invalid; copy the current token from the DSH terminal output',
  DSH_HTTP_ERROR: 'The DSH endpoint returned an HTTP error',
  CLI_MISSING_CONFIG: 'No daemon configuration found. Run npm run dev first, or connect with --url and --token.',
  CLI_MODEL_SPEC: 'Use provider/model, for example deepseek-official/deepseek-v4-flash',
  CLI_LOCAL_CONNECTION_REQUIRED: 'Remote access configuration and device management need a local connection',
  CLI_QR_JSON_CONFLICT: '--json cannot be combined with QR output options',
  CLI_DEPLOY_CONFIG_REQUIRED: 'Use --config to point at a private JSON configuration, or run turnwire deploy in a terminal to open the form',
  CLI_NAMED_TUNNEL_INCOMPLETE: 'A named tunnel requires --tunnel-name, --tunnel-hostname and --tunnel-credentials',
  CLI_TUI_REQUIRES_TTY: 'turnwire tui needs an interactive terminal; use CLI subcommands in scripts',
  CLI_TUNNEL_SELECTION: 'Invalid tunnel number',
  CLI_DEVICE_SELECTION: 'Invalid device number',
  CLI_PROMPT_TTY: 'The interactive interface needs a terminal; use turnwire subcommands in scripts',
  CLI_RELAY_URL_REQUIRED: 'Relay has no phone web address yet; use the pairing code',
  CLI_NAMED_TUNNEL_FIELDS: 'A named tunnel needs a tunnel name, public hostname and credentials file',
  CLI_TUNNEL_PROTOCOL: 'Transport protocol must be auto, http2 or quic',
  CLI_PARSE_INCOMPLETE: 'Unterminated quote or escape',
};

const zhErrors: Record<keyof typeof enErrors, string> = {
  INVALID_REQUEST: '请求无效',
  INTERNAL_ERROR: '内部错误',
  UNAUTHORIZED: '连接令牌无效，请重新连接',
  AUTHENTICATION_FAILED: '加密连接验证失败，请重新配对或更新主机',
  ADMIN_ERROR: '主机管理操作失败',
  HTTP_ERROR: 'Turnwire 返回 HTTP 错误',
  OUTCOME_UNKNOWN: '连接中断，请先查询请求结果再重试',
  REQUEST_CONFLICT: '请求 ID 已被另一条命令使用',
  REQUEST_PENDING: '此请求正在等待结果',
  NOT_AVAILABLE: '请从已配对的手机启用或关闭本设备通知',
  INVALID_WORKSPACE: '工作目录必须是存在的绝对路径文件夹',
  INVALID_CURSOR: '事件游标超出主机记录，请重新读取状态',
  SESSION_NOT_FOUND: '会话不存在',
  SESSION_BUSY: '请先停止任务或处理审批，再归档会话',
  SESSION_ARCHIVED: '请先取消归档，再继续会话',
  RESUME_REQUIRED: '请先恢复此会话，再发送消息',
  APPROVAL_EXPIRED: '审批已处理或已失效',
  MODEL_SELECTION_UNSUPPORTED: '此运行时不支持选择模型',
  MODEL_UNAVAILABLE: '所选模型当前不可用，请从模型目录中重新选择',
  RUNTIME_UNAVAILABLE: '请求的运行时未配置',
  DISCONNECTED: '远程连接不可用',
  CONNECTION_FAILED: '连接失败',
  HOST_OFFLINE: '主机当前离线',
  REMOTE_ERROR: '主机拒绝了连接，请查看主机诊断',
  HANDSHAKE_REUSED: '握手已经结束',
  REKEY_REQUIRED: '需要重新建立加密连接',
  REPLAYED_MESSAGE: '加密会话或消息序号不匹配',
  EXPIRED_MESSAGE: '设备时间相差超过一分钟，请同步设备时间',
  RATE_LIMITED: '远程消息过多',
  INVALID_CIPHERTEXT: '加密数据无效',
  STAGE_TIMEOUT: '连接阶段超时',
  PROBE_TIMEOUT: '连接检测超时',
  DSH_AUTH_REQUIRED: '请设置 TURNWIRE_DSH_TOKEN，或将 DSH 启动时输出的完整 URL 设置为 TURNWIRE_DSH_URL',
  DSH_AUTH_FAILED: 'DSH 启动令牌无效；请从 DSH 的终端输出复制当前令牌',
  DSH_HTTP_ERROR: 'DSH 端点返回 HTTP 错误',
  CLI_MISSING_CONFIG: '找不到 daemon 配置。请先运行 npm run dev，或通过 --url 和 --token 连接。',
  CLI_MODEL_SPEC: '模型请用 provider/model 形式，例如 deepseek-official/deepseek-v4-flash',
  CLI_LOCAL_CONNECTION_REQUIRED: '远程访问配置和设备管理需要本机连接',
  CLI_QR_JSON_CONFLICT: '--json 不能与二维码输出选项同时使用',
  CLI_DEPLOY_CONFIG_REQUIRED: '使用 --config 指定私有 JSON 配置，或在终端运行 turnwire deploy 打开表单',
  CLI_NAMED_TUNNEL_INCOMPLETE: '命名隧道需要 --tunnel-name、--tunnel-hostname 和 --tunnel-credentials',
  CLI_TUI_REQUIRES_TTY: 'turnwire tui 需要交互式终端；脚本请使用 CLI 子命令',
  CLI_TUNNEL_SELECTION: '通道序号无效',
  CLI_DEVICE_SELECTION: '设备序号无效',
  CLI_PROMPT_TTY: '交互界面需要终端；脚本请使用 turnwire 的子命令',
  CLI_RELAY_URL_REQUIRED: 'Relay 尚未配置手机网页地址，请使用配对码',
  CLI_NAMED_TUNNEL_FIELDS: '命名隧道需要隧道名称、公开域名和凭证文件',
  CLI_TUNNEL_PROTOCOL: '传输协议只能是 auto、http2 或 quic',
  CLI_PARSE_INCOMPLETE: '引号或转义尚未结束',
};

export type ErrorKey = keyof typeof enErrors;
export const errorMessages: Record<Locale, Record<ErrorKey, string>> = { en: enErrors, zh: zhErrors };

/** A client-side failure that carries an English fallback message and a localisable code. */
export class LocalizedError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'LocalizedError'; }
}

/** Builds a validation error whose `message` is the English fallback and whose `code` localises. */
export function localizedError(code: ErrorKey): LocalizedError {
  return new LocalizedError(code, errorMessages.en[code]);
}

/** Localises a known error code; unknown codes keep the server's own message verbatim. */
export function messageForError(code: string | undefined, fallback: string): string {
  const template = code ? errorMessages[locale()][code as ErrorKey] : undefined;
  return template ?? fallback;
}

export function t(key: TextKey, params?: MessageParams): string {
  return textIn(locale(), key, params);
}

/** Renders one key in an explicit locale; `--json` keeps English for stable machine output. */
export function textIn(target: Locale, key: TextKey, params?: MessageParams): string {
  return render(messages[target][key], params);
}

/** Pads to a display width, counting CJK/full-width characters as two columns. */
export function padEnd(text: string, width: number): string {
  let displayed = 0;
  for (const character of text) displayed += isWide(character) ? 2 : 1;
  return text + ' '.repeat(Math.max(0, width - displayed));
}

function isWide(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3fffd));
}

/** Every code the shared protocol declares; the completeness test covers each one. */
export function protocolErrorCodes(): readonly string[] { return turnwireErrorCodes; }
