[English](DSH.md) · 中文

# DSH runtime 适配器

目标：`@deepseek-ai/dsh@0.1.5-alpha.1`，源码修订 `5dda764ed3aa172535a7967b06ff95d9cbfe536a`。2026-09-09 时 npm 的默认 tag 指向 `0.1.2-rc.1`，因此说明固定使用与被检查源码匹配的 alpha 版本。所有 DSH 专有名称都位于 `packages/runtime-dsh`。

## 已验证的源码契约

1. 启动 URL 认证：`GET /?token=...` 返回 **303** 以及一个绑定 authority 的 cookie。HTTP API 请求与 WebSocket 握手复用该 cookie。参见 [BrowserAuth](https://github.com/deepseek-ai/deepseek-harness/blob/5dda764ed3aa172535a7967b06ff95d9cbfe536a/packages/client/connection/src/browser-auth.ts)。
2. 一元 RPC：`POST /api/<namespace>/<method>` 携带完整的 Connection 信封 `{ "type": "client-request", "rpcId": "...", "method": "namespace/method", "payload": { "args": { ...namedArguments } } }`。响应为 `{ "type": "server-response", "rpcId": "...", "result": { "ok": true, "value": ... } }`，或带有 `error` 的失败结果。适配器会校验关联关系。参见 [Connection RPC Host](https://github.com/deepseek-ai/deepseek-harness/blob/5dda764ed3aa172535a7967b06ff95d9cbfe536a/packages/client/connection/src/rpc-host.ts) 与 [Gateway](https://github.com/deepseek-ai/deepseek-harness/blob/5dda764ed3aa172535a7967b06ff95d9cbfe536a/packages/api/gateway/src/index.ts)。
3. `session/list` 期望 `_request`，而 `session/create`、`session/prompt`、`session/cancel`、`session/page` 和 `session/follow` 期望 `request`。用已存在的 ID 复用 `session/create` 会接管该会话，**前提是没有其他客户端持有它唯一的写句柄**：已在别处打开的会话（例如 DSH Web UI）会以 `SessionAlreadyOwnedError` 拒绝被接管。`session/list` 读取已存储的行而不恢复 Agent，`session/prompt` 则按需挂接一个，因此适配器通过跟随来恢复已有会话，而不是再次认领它。prompt 包含 `requestId`、`sessionId`、`mode: "queue"` 和文本内容部分。参见 [Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/5dda764ed3aa172535a7967b06ff95d9cbfe536a/packages/api/session-controller/src/index.ts) 与 [wire types](https://github.com/deepseek-ai/deepseek-harness/blob/5dda764ed3aa172535a7967b06ff95d9cbfe536a/packages/api/session-controller/src/types.ts)。
4. 流在 `/api/remote.mux` 上多路复用。Client 发送 `open` / `cancel`；Host 发送 `item` / `end` / `error`，通过 `streamId` 关联。`$events` 打开被转发的 Host 事件流；其 `ready` 帧提供该代的 `clientId`。参见 [stream protocol](https://github.com/deepseek-ai/deepseek-harness/blob/5dda764ed3aa172535a7967b06ff95d9cbfe536a/packages/api/gateway/src/stream-protocol.ts)。
5. 审批以 `waterfall` 帧到达，对应 `approval/request`。Turnwire 只认领自己拥有的会话，把无关事件委托出去，并通过 `$events/result` 以 `allowed-once` 或 `rejected` 回复。代丢失会使待处理请求过期。参见 [client Remote events](https://github.com/deepseek-ai/deepseek-harness/blob/5dda764ed3aa172535a7967b06ff95d9cbfe536a/packages/api/gateway/src/client/remote-events.ts)。
6. `api-session/status` 携带一个 **boolean**。持久事件携带 `seq`、`time`、`type`、`data`。Assistant 的瞬态分块使用 `text-delta`；已持久化的 attempt 可以包含紧凑的 `text-chunks` 记录。Turnwire 跳过 reasoning 文本。参见 [session event vocabulary](https://github.com/deepseek-ai/deepseek-harness/blob/5dda764ed3aa172535a7967b06ff95d9cbfe536a/packages/core/session/src/types.ts) 与 [assistant stream encoding](https://github.com/deepseek-ai/deepseek-harness/blob/5dda764ed3aa172535a7967b06ff95d9cbfe536a/packages/llm/llm/src/assistant-stream.ts)。
7. 模型选择由两个 `session` 方法加一个持久会话事件组成。`session/modelCatalog` **不接受参数**并返回整个目录；`session/selectModel` 接受 `{ request: { sessionId, provider, model, reasoningEffort? } }` 并返回 **Host 解析后**的选择。Host 把该选择记录为 `model/selection` 会话事件，并折叠进 `{ lastUsed, pending }`，因此在回合运行期间的切换会在 prompt 组装时被快照，并在后续步骤生效，而不会把一个步骤拆到两个模型上。参见 [Host declarations](https://github.com/deepseek-ai/deepseek-harness/blob/5dda764ed3aa172535a7967b06ff95d9cbfe536a/packages/api/session-controller/src/index.ts)（方法位于 `sessionController` 第 249 和 258 行）。

gateway 概览文档在流支持方面不如实现新，并且漏掉了 Connection HTTP 信封。一次针对已发布 alpha 的实机冒烟测试发现了这一差异；适配器与契约 fixture 使用实际的承载信封。

## 归属与恢复

- Turnwire 生成自己的会话 ID，并把返回的 DSH ID 单独持久化。
- DSH 拥有自己的 runtime、工具、会话日志、provider 配置和凭据。
- Turnwire 存储用于客户端重放的投影事件、自身元数据以及持久的上游游标。它不读取也不修改 DSH 存储文件。
- 重连会打开一个新的 follow 快照，按需分页读取更早的遗漏记录，并跳过位于或早于其已存上游游标的事件。
- Assistant 的最终文本会替换当前展示消息。瞬态流基线会在重连后修复部分流式文本。
- 审批请求是实时的关联句柄，而不是持久的权限授予。启动会使此前待处理的审批失效；只有新的活动请求才能被决定。
- 初始能力集暴露基本 prompt、流、恢复、工具和审批。模型目录与按会话的模型选择已针对所固定的 Host 验证，但 `AgentRuntime` 尚未暴露；在暴露之前，会话运行在 Host 的 `agent-default-model` 上。结构化 diff 呈现、文件浏览、jobs UI、图像、工具提问表单和命令目录尚未暴露。

`tests/dsh.test.ts` 下的契约 fixture 复现了这些精确签名，包括在审批 RPC 完成前的取消。真实的模型任务仍需要配置好的 DSH provider。切勿把 API key、DSH 启动 token 或配对码放入被跟踪的文件。

## 模型选择契约

`session/modelCatalog` 使用空参数，于 2026-09-10 针对所固定的 Host 测得：

```json
{
  "default": { "provider": "deepseek-official", "model": "deepseek-v4-flash" },
  "routableProviders": ["deepseek-official"],
  "failures": [],
  "groups": [{
    "id": "deepseek-official",
    "name": "DeepSeek",
    "models": [{
      "id": "deepseek-v4-flash",
      "name": "DeepSeek-V4-Flash",
      "description": "Fast, efficient, and economical; …",
      "reasoning": { "efforts": [{ "id": "off" }, { "id": "low" }, { "id": "high" }, { "id": "max" }], "defaultEffort": "high" }
    }]
  }]
}
```

仅凭这些形状看不出来的事实：

- 注册的 provider 路由是 `deepseek-official`，**而非** `deepseek`。客户端必须从目录中选择，而不是自行构造 provider id。
- 目录发现在**没有**解析出模型凭据时也能工作：即使环境中没有任何 key，也会列出三个 DeepSeek 模型及其 reasoning 强度。因此缺失凭据会在 prompt 运行时暴露，而不是在读取目录时暴露。
- `reasoning` 携带 `efforts` 和 `defaultEffort`。不带 `reasoningEffort` 进行选择会返回解析后的强度：`{"selected":{"provider":"deepseek-official","model":"deepseek-v4-flash","reasoningEffort":"high"}}`。客户端应渲染返回的选择，而不是假定所请求的那个。
- 未知路由会以错误码 **`session/model-unavailable`**、消息 `no adapter registered for provider "…"` 和 `details: { provider, model }` 失败。这是按请求的错误，不是会话失败。
- `session/create` 返回 `{ "sessionId", "agentPreset": "standard" }`；`agentPreset` 是 Turnwire 尚未建模的附加状态。

`scripts/dsh-model-probe.mjs` 在隔离的 Host 上复现上述全部内容（独立的 `DSH_HOME`、不发送 prompt、不调用模型），是 DSH 升级后重新验证的参照。

## DeepSeek 环境凭据

用 `npm run dev:dsh` 启动 Host。其 `--patch config/dsh-deepseek.patch.yml` overlay 把官方 `llm-deepseek` 和 `web-search-deepseek` provider 的 `apiKeyEnv` 设为 **`TURNWIRE_HARNESS_DEEPSEEK_API_KEY`**。这是凭据引用，不是被插值的密钥本身。启动前在 Host 的环境中导出该变量。该 key 不是 Turnwire daemon/client 的认证 token。

DSH 按请求解析凭据；继承的环境优先于它托管的凭据来源。已有的 `llm-deepseek` 用户设置可以覆盖组合中的 `apiKeyEnv`，因此带有显式保存引用的部署也必须更新该引用。Turnwire 的启动器不会重写这些设置。参见官方 [DeepSeek adapter](https://github.com/deepseek-ai/deepseek-harness/blob/5dda764ed3aa172535a7967b06ff95d9cbfe536a/packages/llm/llm-deepseek/README.md)。

## 实机验证，2026-09-09

把官方 `@deepseek-ai/dsh@0.1.5-alpha.1` 安装到临时 prefix，用独立的 `DSH_HOME` 启动，禁用遥测，并让适配器连接其 loopback Host。演练了认证、空会话创建、会话列出、幂等恢复和 follow 流打开。未发送 prompt 或模型调用。实机检查发现了缺失的 HTTP Connection 信封，已在实现和 fixture 中修正。

2026-09-10 用 `scripts/dsh-model-probe.mjs` 针对同一固定修订重新验证：认证、`session/modelCatalog`、`session/create`，以及 `session/selectModel` 的成功与失败路径。`typert.host.js` 中的声明提供了方法名和参数名；实机 Host 提供了 provider 路由、解析后的 `reasoningEffort`、`agentPreset` 字段和 `session/model-unavailable` 错误形状，这些在类型声明中都不可见。未发送 prompt，也未调用模型。
