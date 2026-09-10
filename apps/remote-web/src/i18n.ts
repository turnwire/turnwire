import { useEffect, useState } from 'react';

/**
 * The phone PWA's text catalogues. Error codes are a shared contract (`turnwireErrorCodes`);
 * the user-visible sentences that go with them live here, per client, like every other string.
 *
 * English is the default. Chinese is kept as the second locale, and a manual choice persisted in
 * `localStorage` wins over the browser language.
 */
export type Locale = 'en' | 'zh';

const STORAGE_KEY = 'turnwire.locale';

/** English is the source of truth for the key set: `zh` is typed against it below. */
const en = {
  // Session status, shown by the status chip and the sidebar dot's accessible name.
  'status.idle': 'Ready',
  'status.running': 'Running',
  'status.waiting_approval': 'Waiting for approval',
  'status.interrupted': 'Interrupted',
  'status.error': 'Needs attention',

  // Small shared words.
  'common.newSession': 'New session',
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.reject': 'Reject',
  'common.approveOnce': 'Approve once',
  'common.unarchive': 'Unarchive',
  // A question the agent is blocked on. Every question in a batch is answered together.
  'question.aria': 'Question from the agent',
  'question.title': 'The agent is asking',
  'question.other': 'Or type an answer…',
  'question.send': 'Send answer',
  // Delegated approvals: nobody is asked while this is on.
  'session.autoApprove': 'Approve for me',
  'session.autoApproveOff': 'Ask me again',
  'session.autoApproveOn': 'Approving for you',
  'session.autoApproveHint': 'Every approval in this session is granted as it arrives, until you turn this off or the host restarts.',
  'approval.autoOn': 'Granted for you',
  'common.listSeparator': ', ',

  // Language switch.
  'locale.label': 'Language',
  'locale.englishShort': 'EN',
  'locale.chineseShort': '中',

  // Sidebar.
  'sidebar.closeSessionList': 'Close session list',
  'sidebar.closeList': 'Close list',
  'sidebar.inbox': 'Inbox',
  'sidebar.searchSessions': 'Search sessions',
  'sidebar.searchPlaceholder': 'Search sessions or working directories',
  'sidebar.archived': 'Archived',
  'sidebar.workSessions': 'Work sessions',
  'sidebar.sessionList': 'Session list',
  'sidebar.emptyNoSession': 'Create a session to get started.',
  'sidebar.emptyNoHost': 'Sessions appear here once you connect to a host.',
  'sidebar.connectHost': 'Connect your host',
  'sidebar.connected': 'Connected',
  'sidebar.connecting': 'Connecting',
  'sidebar.offline': 'Offline',
  'sidebar.localNote': 'Tasks run on your host',

  // Top bar.
  'topbar.openSessionList': 'Open session list',
  'topbar.deviceConnection': 'Device connection',
  'topbar.inbox': 'Inbox',
  'topbar.workspace': 'Workspace',
  'topbar.sessionActions': 'Session actions',
  'topbar.rename': 'Rename',
  'topbar.newSessionName': 'New session name',
  'topbar.saveName': 'Save name',
  'topbar.archiveSession': 'Archive session',
  'topbar.connectionSettings': 'Connection settings',

  // Remote connection health.
  'health.connectedTo': 'Connected to {host}',
  'health.host': 'host',
  'health.connecting': 'Connecting to host…',
  'health.details': 'Round trip {latency} ms · Last confirmed {time} · {route}',
  'health.routeDirect': 'Direct on local network',
  'health.oldPairing': ' · Old pairing, can be upgraded on the host',
  'health.retry': 'Retrying in about {seconds}s; use the button to reconnect now.',
  'health.unconfirmed': 'Connected appears only after the host confirms encryption.',
  'health.connectingAction': 'Connecting…',
  'health.reconnectNow': 'Reconnect now',

  // Error banner.
  'error.dismiss': 'Dismiss error',

  // Empty workspace.
  'empty.eyebrow': 'One session, continued anywhere',
  'empty.title': 'Work starts here.',
  'empty.bodyLine1': 'Run the Agent on your host,',
  'empty.bodyLine2': 'follow progress, add ideas and handle approvals here.',

  // Conversation.
  'conversation.aria': 'Conversation',
  'conversation.demoNote': ' · Does not run real code',
  'conversation.loadingEarlier': 'Loading earlier records…',
  'conversation.retryEarlier': 'Retry loading records',
  'conversation.loadEarlier': 'Load earlier records',
  'conversation.loading': 'Loading conversation…',
  'conversation.readyLine1': 'This session is ready.',
  'conversation.readyLine2': 'Tell the Agent what you want to accomplish.',
  'conversation.you': 'You',
  'message.queuedChip': 'Queued',
  'message.steerChip': 'Steered',

  // Archived and interrupted sessions.
  'session.archivedRow': 'This session is archived; its history is still viewable.',
  'session.resumeHint': 'Resume the session to continue working.',
  'session.resume': 'Resume session',

  // Approvals.
  'approval.panelAria': 'Pending approvals',
  'approval.needed': 'Your approval is needed',
  'approval.once': 'This time only',

  // Model picker.
  'model.label': 'Model',
  'model.defaultModel': 'Default model',
  'model.runtimeDefault': 'Runtime default',
  'model.runtimeDefaultNamed': 'Runtime default ({provider}/{model})',
  'model.unavailableSuffix': ' · Currently unavailable',
  'model.reasoningEffort': 'Reasoning effort',
  'model.defaultSuffix': ' (default)',
  'model.loadingCatalog': 'Loading model catalog…',
  'model.unavailable': '{name} unavailable',

  // Queued prompts: the row owns the only edit/cancel/steer controls in the page.
  'queue.aria': 'Queued messages',
  'queue.edit': 'Edit',
  'queue.editLabel': 'Edit the queued message',
  'queue.save': 'Save',
  'queue.remove': 'Cancel',
  'queue.steer': 'Jump the queue',

  // Background agents: a delegation returns at once, so this is where a child's progress shows.
  'agents.aria': 'Background agents',
  'agents.running': '{count} background agents running',
  'agents.more': '+{count} more running',
  'agents.seconds': '{value}s',
  'agents.minutes': '{minutes}m {seconds}s',
  'agents.steps': '{done}/{total} steps',
  'agents.current': '{done}/{total} steps · {content}',

  // Composer.
  'composer.messageAria': 'Message',
  'composer.placeholder': 'Describe the task, or add your next thought…',
  'composer.chooseModel': 'Choose model',
  'composer.stopTask': 'Stop task',
  'composer.stop': 'Stop',
  'composer.send': 'Send message',
  'composer.encrypted': 'Encrypted device connection',
  'composer.local': 'Local connection',
  'composer.shared': 'All clients share the current session',
  'composer.disconnected': 'Disconnected, reconnecting',

  // Tool calls.
  'tool.subagent': 'Subagent · {description}',
  'tool.failed': 'Failed',
  'tool.returned': 'Returned',
  'tool.running': 'Running',
  'tool.input': 'Input parameters',
  'tool.output': 'Result',
  'tool.tool': 'Tool',
  'tool.subagentCount': 'Subagent ×{count}',
  'tool.namedCount': '{tool} ×{count}',
  'tool.manyItems': '{count} items including {tool}',
  'tool.failures': '{count} failed',
  'tool.allReturned': 'All returned',
  'tool.noResult': 'No result received',

  // Create-session dialog.
  'create.intro': 'Choose a working directory on the host to start a shared session.',
  'create.name': 'Session name',
  'create.namePlaceholder': 'e.g. Refactor network requests',
  'create.cwd': 'Working directory',
  'create.choose': 'Choose folder',
  'create.folderPicker': 'Choose a working directory',
  'create.home': 'Home',
  'create.up': 'Up',
  'create.noFolders': 'No subfolders here.',
  'create.reading': 'Reading folders…',
  'create.truncated': 'Showing the first {shown} of {total} folders.',
  'create.useFolder': 'Use this folder',
  'create.runtime': 'Runtime',
  'create.runtimeOffline': ' · Not connected',
  'create.noRuntime': 'Start and configure DSH, then reconnect Turnwire.',
  'create.creating': 'Creating',
  'create.create': 'Create session',

  // Connection view.
  'connection.eyebrow': 'Your host, continued in your pocket',
  'connection.title': 'Connect and keep working.',
  'connection.bodyLine1': 'Follow the same session live,',
  'connection.bodyLine2': 'and send your next thought back to the host.',
  'connection.factPermissions': 'You stay in control of permissions',
  'connection.factLocal': 'Code and execution stay on the host',
  'connection.connectDevice': 'Connect a device',
  'connection.remotePairing': 'Remote pairing',
  'connection.localPairing': 'Local connection',
  'connection.pairingCode': 'Pairing code',
  'connection.pairingPlaceholder': 'Paste the pairing code or link generated by the host',
  'connection.pairingHelpBefore': 'Run ',
  'connection.pairingHelpAfter': ' in the host terminal to get a pairing code.',
  'connection.hostUrl': 'Host service URL',
  'connection.token': 'Connection token',
  'connection.tokenPlaceholder': 'Paste the local connection token',
  'connection.connectHelpBefore': 'Run ',
  'connection.connectHelpAfter': ' on this host to see connection details.',
  'connection.remember': 'Remember this trusted device',
  'connection.connecting': 'Connecting',
  'connection.connect': 'Connect to host',
  'connection.back': 'Back to session',
  'connection.disconnect': 'Disconnect and forget',

  // Inbox.
  'inbox.title': 'Inbox',
  'inbox.subtitle': 'Actions that need you across all sessions.',
  'inbox.includeHandled': 'Include handled',
  'inbox.pushUnsupported': 'This browser does not support notifications yet; on iPhone, add the page to the Home Screen first.',
  'inbox.needRelay': 'Configure a fixed Relay that supports push on the host first',
  'inbox.notAuthorised': 'Notifications are not authorised yet; allow Turnwire notifications in system settings.',
  'inbox.remindersTitle': 'Get reminders even when you leave the page',
  'inbox.loadingStatus': 'Loading notification status…',
  'inbox.iosHint': 'On iPhone, add to the Home Screen first. Notifications only show pending reminders; details load after connecting to the host.',
  'inbox.disable': 'Turn off notifications on this device',
  'inbox.enable': 'Enable notifications and remember device',
  'inbox.emptyConnected': 'Nothing pending.',
  'inbox.emptyDisconnected': 'The inbox updates after you connect to a host.',
  'inbox.status.pending': 'Pending',
  'inbox.status.approved': 'Approved',
  'inbox.status.rejected': 'Rejected',
  'inbox.status.cancelled': 'Expired',
  'inbox.loadEarlier': 'Load earlier items',
  'inbox.requestResult': 'Check an unconfirmed request result',
  'inbox.requestId': 'Request ID',
  'inbox.check': 'Check',

  // Shared protocol error codes (`turnwireErrorCodes`). Rendered instead of the host's message
  // whenever the client can see a code; an unknown code falls back to the host's own message.
  'error.APPROVAL_EXPIRED': 'This approval was already handled or has expired.',
  'error.AUTHENTICATION_FAILED': 'The encrypted connection could not be verified. Pair again or update the host.',
  'error.DISCONNECTED': 'The remote connection is unavailable.',
  'error.DSH_AUTH_FAILED': "The DSH startup token is invalid; copy the current token from DSH's terminal.",
  'error.DSH_AUTH_REQUIRED': 'Set TURNWIRE_DSH_TOKEN, or set the full URL printed when DSH starts as TURNWIRE_DSH_URL.',
  'error.DSH_HTTP_ERROR': 'DSH returned an HTTP error.',
  'error.EXPIRED_MESSAGE': "The devices' clocks differ by more than a minute; sync their time.",
  'error.HANDSHAKE_REUSED': 'The handshake has already finished.',
  'error.HOST_OFFLINE': 'The host is offline.',
  'error.HTTP_ERROR': 'The host returned an HTTP error.',
  'error.INVALID_CIPHERTEXT': 'The encrypted message was invalid.',
  'error.INVALID_CURSOR': "The event cursor is beyond the host's journal.",
  'error.INVALID_WORKSPACE': 'The working directory is invalid; use an existing absolute path.',
  'error.MODEL_SELECTION_UNSUPPORTED': 'This runtime does not support model selection.',
  'error.MODEL_UNAVAILABLE': 'The selected model is currently unavailable; choose another from the model catalog.',
  'error.NOT_AVAILABLE': 'This action is not available for this device.',
  'error.OUTCOME_UNKNOWN': 'The host was interrupted while handling this request; check session state before sending a new request.',
  'error.PROBE_TIMEOUT': 'The connection check timed out.',
  'error.QUEUE_ITEM_GONE': 'That message is no longer waiting to be sent.',
  'error.QUESTION_EXPIRED': 'That question was already answered or has expired.',
  'error.RATE_LIMITED': 'Too many remote messages; slow down and try again.',
  'error.REKEY_REQUIRED': 'The encrypted connection needs to be re-established.',
  'error.REMOTE_ERROR': 'The host rejected the connection; check the host diagnostics.',
  'error.REPLAYED_MESSAGE': 'A replayed or out-of-order message was rejected.',
  'error.REQUEST_CONFLICT': 'This request ID is already used by another command.',
  'error.REQUEST_PENDING': 'This request is still waiting for its result.',
  'error.RESUME_REQUIRED': 'Resume this session before sending a message.',
  'error.RUNTIME_UNAVAILABLE': 'The runtime is not available.',
  'error.SESSION_ARCHIVED': 'Unarchive this session before continuing.',
  'error.SESSION_BUSY': 'Stop the task or resolve approvals before archiving the session.',
  'error.SESSION_NOT_FOUND': 'Session not found.',
  'error.STAGE_TIMEOUT': 'The connection timed out.',
  'error.WORKSPACE_UNREADABLE': 'The host cannot read that folder; choose another one.',
  // Returned by `errorResponse`/the SDK but outside the shared contract; kept local, not invented
  // as protocol codes.
  'error.INVALID_REQUEST': 'The request was invalid.',
  'error.INTERNAL_ERROR': 'The host hit an internal error.',
  'error.UNAUTHORIZED': 'The connection token is invalid; reconnect.',
  'error.ADMIN_ERROR': 'Host administration failed.',
};

/** The key set every locale must cover. */
export type MessageKey = keyof typeof en;

type Catalog = { [K in MessageKey]: string };

const zh: Catalog = {
  'status.idle': '就绪',
  'status.running': '进行中',
  'status.waiting_approval': '等待审批',
  'status.interrupted': '已中断',
  'status.error': '需要处理',

  'common.newSession': '新建会话',
  'common.close': '关闭',
  'common.cancel': '取消',
  'common.reject': '拒绝',
  'common.approveOnce': '批准本次',
  'common.unarchive': '取消归档',
  'question.aria': '来自 Agent 的问题',
  'question.title': 'Agent 在问你',
  'question.other': '或直接输入回答…',
  'question.send': '提交回答',
  'session.autoApprove': '帮我批准',
  'session.autoApproveOff': '恢复询问我',
  'session.autoApproveOn': '正在帮你批准',
  'session.autoApproveHint': '这个会话的审批一到就自动批准，直到你关掉它，或主机重启。',
  'approval.autoOn': '已代你批准',
  'common.listSeparator': '、',

  'locale.label': '语言',
  'locale.englishShort': 'EN',
  'locale.chineseShort': '中',

  'sidebar.closeSessionList': '关闭会话列表',
  'sidebar.closeList': '关闭列表',
  'sidebar.inbox': '收件箱',
  'sidebar.searchSessions': '搜索会话',
  'sidebar.searchPlaceholder': '搜索会话或工作目录',
  'sidebar.archived': '已归档',
  'sidebar.workSessions': '工作会话',
  'sidebar.sessionList': '会话列表',
  'sidebar.emptyNoSession': '新建一个会话，开始工作。',
  'sidebar.emptyNoHost': '连接主机后，工作会话会显示在这里。',
  'sidebar.connectHost': '连接你的主机',
  'sidebar.connected': '已连接',
  'sidebar.connecting': '连接中',
  'sidebar.offline': '离线',
  'sidebar.localNote': '任务在你的主机上运行',

  'topbar.openSessionList': '打开会话列表',
  'topbar.deviceConnection': '设备连接',
  'topbar.inbox': '收件箱',
  'topbar.workspace': '工作空间',
  'topbar.sessionActions': '会话操作',
  'topbar.rename': '重命名',
  'topbar.newSessionName': '新的会话名称',
  'topbar.saveName': '保存名称',
  'topbar.archiveSession': '归档会话',
  'topbar.connectionSettings': '连接设置',

  'health.connectedTo': '已连接到 {host}',
  'health.host': '主机',
  'health.connecting': '正在连接主机…',
  'health.details': '往返 {latency} ms · 最近确认 {time} · {route}',
  'health.routeDirect': '局域网直连',
  'health.oldPairing': ' · 旧配对，可在主机升级',
  'health.retry': '约 {seconds} 秒后重试；可点按钮立即重连。',
  'health.unconfirmed': '收到主机的加密确认后才会显示已连接。',
  'health.connectingAction': '连接中…',
  'health.reconnectNow': '立即重连',

  'error.dismiss': '关闭错误提示',

  'empty.eyebrow': '一个会话，随处接续',
  'empty.title': '工作从这里开始。',
  'empty.bodyLine1': '在主机上运行 Agent，',
  'empty.bodyLine2': '在这里查看进度、补充想法和处理审批。',

  'conversation.aria': '会话内容',
  'conversation.demoNote': ' · 不执行真实代码',
  'conversation.loadingEarlier': '正在读取更早记录…',
  'conversation.retryEarlier': '重试加载记录',
  'conversation.loadEarlier': '加载更早记录',
  'conversation.loading': '正在读取会话…',
  'conversation.readyLine1': '这个会话准备好了。',
  'conversation.readyLine2': '告诉 Agent 你想完成什么。',
  'conversation.you': '你',
  'message.queuedChip': '排队发送',
  'message.steerChip': '插话',

  'session.archivedRow': '会话已归档，历史记录仍可查看。',
  'session.resumeHint': '恢复会话后继续工作。',
  'session.resume': '恢复会话',

  'approval.panelAria': '待审批操作',
  'approval.needed': '需要你的批准',
  'approval.once': '仅本次',

  'model.label': '模型',
  'model.defaultModel': '默认模型',
  'model.runtimeDefault': '运行时默认',
  'model.runtimeDefaultNamed': '运行时默认（{provider}/{model}）',
  'model.unavailableSuffix': ' · 当前不可用',
  'model.reasoningEffort': '思考强度',
  'model.defaultSuffix': '（默认）',
  'model.loadingCatalog': '正在读取模型目录…',
  'model.unavailable': '{name} 不可用',

  'queue.aria': '排队中的消息',
  'queue.edit': '编辑',
  'queue.editLabel': '编辑排队中的消息',
  'queue.save': '保存',
  'queue.remove': '取消',
  'queue.steer': '插队',

  'agents.aria': '后台子代理',
  'agents.running': '{count} 个子代理正在运行',
  'agents.more': '还有 {count} 个正在运行',
  'agents.seconds': '{value} 秒',
  'agents.minutes': '{minutes} 分 {seconds} 秒',
  'agents.steps': '{done}/{total} 项待办',
  'agents.current': '{done}/{total} 项待办 · {content}',

  'composer.messageAria': '消息',
  'composer.placeholder': '描述任务，或补充下一步想法…',
  'composer.chooseModel': '选择模型',
  'composer.stopTask': '停止任务',
  'composer.stop': '停止',
  'composer.send': '发送消息',
  'composer.encrypted': '设备间加密连接',
  'composer.local': '本机连接',
  'composer.shared': '所有客户端共享当前会话',
  'composer.disconnected': '连接已断开，正在重连',

  'tool.subagent': '子代理 · {description}',
  'tool.failed': '失败',
  'tool.returned': '已返回',
  'tool.running': '执行中',
  'tool.input': '输入参数',
  'tool.output': '返回结果',
  'tool.tool': '工具',
  'tool.subagentCount': '子代理 ×{count}',
  'tool.namedCount': '{tool} ×{count}',
  'tool.manyItems': '{tool} 等 {count} 项',
  'tool.failures': '{count} 项失败',
  'tool.allReturned': '全部已返回',
  'tool.noResult': '未收到结果',

  'create.intro': '选择主机上的工作目录，开始一个共享会话。',
  'create.name': '会话名称',
  'create.namePlaceholder': '例如：重构网络请求',
  'create.cwd': '工作目录',
  'create.choose': '选择目录',
  'create.folderPicker': '选择工作目录',
  'create.home': '主目录',
  'create.up': '上一级',
  'create.noFolders': '这里没有子目录。',
  'create.reading': '正在读取目录…',
  'create.truncated': '共 {total} 个目录，只显示前 {shown} 个。',
  'create.useFolder': '使用这个目录',
  'create.runtime': '运行时',
  'create.runtimeOffline': ' · 未连接',
  'create.noRuntime': '请先启动并配置 DSH，然后重新连接 Turnwire。',
  'create.creating': '正在创建',
  'create.create': '创建会话',

  'connection.eyebrow': '你的主机，随身接续',
  'connection.title': '连接，继续工作。',
  'connection.bodyLine1': '查看同一个会话的实时进度，',
  'connection.bodyLine2': '把下一步想法发回主机。',
  'connection.factPermissions': '操作权限由你掌握',
  'connection.factLocal': '代码和执行留在本机',
  'connection.connectDevice': '连接设备',
  'connection.remotePairing': '远程配对',
  'connection.localPairing': '本机连接',
  'connection.pairingCode': '配对码',
  'connection.pairingPlaceholder': '粘贴主机生成的配对码或配对链接',
  'connection.pairingHelpBefore': '在主机的终端运行 ',
  'connection.pairingHelpAfter': ' 获取配对码。',
  'connection.hostUrl': '主机服务地址',
  'connection.token': '连接令牌',
  'connection.tokenPlaceholder': '粘贴本机连接令牌',
  'connection.connectHelpBefore': '在这台主机上运行 ',
  'connection.connectHelpAfter': ' 查看连接信息。',
  'connection.remember': '记住这台受信任设备',
  'connection.connecting': '正在连接',
  'connection.connect': '连接主机',
  'connection.back': '返回会话',
  'connection.disconnect': '断开并忘记连接',

  'inbox.title': '收件箱',
  'inbox.subtitle': '所有会话中需要你处理的操作。',
  'inbox.includeHandled': '包含已处理',
  'inbox.pushUnsupported': '此浏览器尚不支持通知；iPhone 请先将页面添加到主屏幕再打开。',
  'inbox.needRelay': '请先在主机配置支持推送的固定 Relay',
  'inbox.notAuthorised': '通知尚未获得授权，请在系统设置中允许 Turnwire 通知。',
  'inbox.remindersTitle': '离开页面也能收到提醒',
  'inbox.loadingStatus': '正在读取通知状态…',
  'inbox.iosHint': 'iPhone 请先添加到主屏幕。通知只显示待办提醒，详情在连接主机后读取。',
  'inbox.disable': '关闭本设备通知',
  'inbox.enable': '启用通知并记住设备',
  'inbox.emptyConnected': '暂无待办。',
  'inbox.emptyDisconnected': '连接主机后更新收件箱。',
  'inbox.status.pending': '待处理',
  'inbox.status.approved': '已批准',
  'inbox.status.rejected': '已拒绝',
  'inbox.status.cancelled': '已失效',
  'inbox.loadEarlier': '加载更早待办',
  'inbox.requestResult': '查询未确认的操作结果',
  'inbox.requestId': '请求 ID',
  'inbox.check': '查询',

  'error.APPROVAL_EXPIRED': '审批已处理或已失效。',
  'error.AUTHENTICATION_FAILED': '加密连接验证失败，请重新配对或更新主机。',
  'error.DISCONNECTED': '远程连接不可用。',
  'error.DSH_AUTH_FAILED': 'DSH 启动令牌无效；请从 DSH 的终端输出复制当前令牌。',
  'error.DSH_AUTH_REQUIRED': '请设置 TURNWIRE_DSH_TOKEN，或将 DSH 启动时输出的完整 URL 设置为 TURNWIRE_DSH_URL。',
  'error.DSH_HTTP_ERROR': 'DSH 返回了 HTTP 错误。',
  'error.EXPIRED_MESSAGE': '设备时间相差超过一分钟，请同步设备时间。',
  'error.HANDSHAKE_REUSED': '握手已经结束。',
  'error.HOST_OFFLINE': '主机当前离线。',
  'error.HTTP_ERROR': '主机返回了 HTTP 错误。',
  'error.INVALID_CIPHERTEXT': '加密消息无效。',
  'error.INVALID_CURSOR': '事件游标超出主机记录范围。',
  'error.INVALID_WORKSPACE': '工作目录无效，请使用存在的绝对路径。',
  'error.MODEL_SELECTION_UNSUPPORTED': '此运行时不支持选择模型。',
  'error.MODEL_UNAVAILABLE': '所选模型当前不可用，请从模型目录中重新选择。',
  'error.NOT_AVAILABLE': '此设备不支持该操作。',
  'error.OUTCOME_UNKNOWN': '主机在处理此请求时中断，请先确认会话状态再发送新请求。',
  'error.PROBE_TIMEOUT': '连接检测超时。',
  'error.QUEUE_ITEM_GONE': '这条消息已经不在排队中了。',
  'error.QUESTION_EXPIRED': '这个问题已经回答过或已过期。',
  'error.RATE_LIMITED': '远程消息过于频繁，请稍后再试。',
  'error.REKEY_REQUIRED': '需要重新建立加密连接。',
  'error.REMOTE_ERROR': '主机拒绝了连接，请查看主机诊断。',
  'error.REPLAYED_MESSAGE': '消息重复或顺序不正确，已拒绝。',
  'error.REQUEST_CONFLICT': '此请求 ID 已被另一条命令使用。',
  'error.REQUEST_PENDING': '此请求正在等待结果。',
  'error.RESUME_REQUIRED': '请先恢复此会话，再发送消息。',
  'error.RUNTIME_UNAVAILABLE': '运行时不可用。',
  'error.SESSION_ARCHIVED': '请先取消归档，再继续会话。',
  'error.SESSION_BUSY': '请先停止任务或处理审批，再归档会话。',
  'error.SESSION_NOT_FOUND': '未找到该会话。',
  'error.STAGE_TIMEOUT': '连接超时。',
  'error.WORKSPACE_UNREADABLE': '主机无法读取该目录，请选择其他目录。',
  'error.INVALID_REQUEST': '请求无效。',
  'error.INTERNAL_ERROR': '主机内部错误。',
  'error.UNAUTHORIZED': '连接令牌无效，请重新连接。',
  'error.ADMIN_ERROR': '主机管理操作失败。',
};

/** Every catalogue, exposed so tests can prove they stay in step. */
export const catalogs: Record<Locale, Catalog> = { en, zh };

/** Every message key, in the English catalogue's order. */
export const messageKeys = Object.keys(en) as MessageKey[];

/** Every error code has a `error.<CODE>` entry; this proves both locales cover the shared list. */
export function errorMessageKey(code: string): MessageKey {
  return `error.${code}` as MessageKey;
}

export function messageForError(code: string | undefined, fallback: string): string {
  if (code && messageKeys.includes(errorMessageKey(code))) return catalogs[current][errorMessageKey(code)];
  return fallback;
}

/** A localized sentence for any thrown value, falling back to its own message for unknown codes. */
export function errorText(error: unknown): string {
  const fallback = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return messageForError(typeof code === 'string' ? code : undefined, fallback);
}

/** Chinese browsers get Chinese; every other browser gets English. The protocol list stays shared. */
export function detectLocale(): Locale {
  const stored = storedLocale();
  if (stored) return stored;
  const language = typeof navigator === 'undefined' ? undefined : navigator.language || navigator.languages?.[0];
  return language && /^zh\b/i.test(language) ? 'zh' : 'en';
}

function storedLocale(): Locale | undefined {
  try {
    const value = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    return value === 'en' || value === 'zh' ? value : undefined;
  } catch { return undefined; }
}

let current: Locale = detectLocale();
const listeners = new Set<() => void>();

export function getLocale(): Locale { return current; }

/** Flip the override and persist it; every subscribed component re-renders. */
export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* A blocked storage still switches this session. */ }
  for (const listener of listeners) listener();
}

export function clearLocaleOverride(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* nothing persisted to clear */ }
}

/** Interpolates `{name}` placeholders; a missing variable is left visible instead of blanked. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const catalog = catalogs[current];
  const template = catalog[key] ?? catalogs.en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match);
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/**
 * The translator for the active locale. Calling the hook is what subscribes a component to
 * language changes, so every component that renders text should call it once.
 */
export function useLocale(): Translate {
  const [, force] = useState(0);
  useEffect(() => { const listener = () => force(value => value + 1); listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  return t;
}

// Keep a second tab in step when the override changes elsewhere.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY) return;
    const next: Locale = event.newValue === 'zh' ? 'zh' : 'en';
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener();
  });
}
