[English](SELF-HOSTING.md) · 中文

# 用 Turnwire 开发 Turnwire

主机可以运行这份检出，而不是已安装的发布版，于是编辑 Turnwire 的 Agent 正是 Turnwire 正在运行的 Agent。本文介绍这个循环、让它仅限开发用途的防护，以及让远程操作者保持连接的自动回滚。

## 为什么这不是产品功能

自动更新被刻意排除在所有产品界面之外：

- 它**没有 RPC 方法**，因此任何客户端都无法调用 —— 本机 CLI、桌面 App 和已配对手机都不行。远程设备无法触发代码部署。
- 安装器（`scripts/install-host-service.mjs`、`scripts/install-linux-host.sh`）从不创建开发用途的 unit，也从不启用重载。按照文档中的安装路径操作，不可能得到一个自我更新的主机。
- 定义新行为不在这里的范围内：这里只改变主机运行的是哪个构建。

边界是文件系统，而不是 API：**只有能在这个 git 检出内运行 shell 的人才能重载它。** `scripts/host-reload.sh` 直接强制这一点 —— 除非目标是 git 工作树，否则它会拒绝，因此已安装的发布版（没有 `.git`）永远无法自我更新，即使有人找到并运行该脚本也一样。它还拒绝 `turnwire-dev.service` 之外的任何 unit，因此发布版主机永远不会被触碰。

## 安装开发主机（不会启动任何东西）

```bash
npm ci --prefix config/dsh-runtime          # the DSH the host will run
cp <release>/config/dsh.env.json config/dsh.env.json   # 0600, gitignored
npm run build
scripts/install-dev-host.sh --state <state> --dsh-home <dsh-state>
```

`--state` 和 `--dsh-home` 必须是当前主机已经在使用的目录，否则主机会在没有已配对设备、没有 Relay token、也没有会话日志的情况下启动。不会启动任何东西：unit 存在但保持 inactive，直到你切换过去。

加上 `--enable-watch` 会同时启用 `turnwire-dev-reload.path` 和补充轮询的 `.timer`。默认关闭；禁用会立即停止两种触发器及正在运行的重载任务。监听只允许兼容的前端静态资源发布，后端或 DSH 变动不会自动重启服务。

## DSH 环境文件

`config/dsh.env.json`（0600，被 gitignore）是 DSH 启动时的环境，而不是"一个 key 的位置"：里面每个字符串都会转发给 DSH 进程；Turnwire 自己的密钥（relay token、DSH 启动 token 和 URL）即使写在这个文件里也会被剥掉。文件里的任何东西都不会进入 daemon 或任何客户端 —— 模型凭据始终留在 DSH 内部。

正因为如此，"接入第二个 endpoint"是改配置而不是改代码。DSH 默认挂载了 `llm-pi-ai`，它的路由是一个以 provider 为键的 dict，所以加一个 endpoint 就是加一条配置加上它的凭据：

```yaml
# config/dsh-deepseek.patch.yml
- id: llm-deepseek
  config:
    apiKeyEnv: TURNWIRE_HARNESS_DEEPSEEK_API_KEY

- id: llm-pi-ai
  config:
    providers:
      gateway:                        # 这个键就是客户端会看到的 provider id
        displayName: 团队网关
        baseURL: https://gateway.example.com/v1
        api: openai-completions       # 也可以是 anthropic-messages、openai-responses 等
        apiKeyEnv: TURNWIRE_HARNESS_GATEWAY_KEY
        models:
          - id: some-model
            name: Some model
```
```json
// config/dsh.env.json
{ "TURNWIRE_HARNESS_DEEPSEEK_API_KEY": "…", "TURNWIRE_HARNESS_GATEWAY_KEY": "…" }
```

Turnwire 侧不需要知道任何事：runtime 的模型目录会为每条已注册的路由报告一个 group 以及它自己的 failures，daemon 会拒绝 runtime 没列出的模型，每个客户端展示的就是这些 group。加一条路由，下一次快照就能在所有客户端看到 —— 不用改客户端，也不用在这边发明模型 id。

## 重载

```bash
scripts/host-reload.sh             # 检查内容变化；只发布兼容的前端资源
scripts/host-reload.sh --frontend  # 显式确认前后端兼容并初始化/发布前端
scripts/host-reload.sh --daemon --dry-run  # 仅验证暂存构建，不访问或修改运行主机
scripts/host-reload.sh --daemon    # 显式租约排空、只替换 daemon、验证后恢复提交
```

- **按组件计算内容指纹。** 文档和测试不触发部署；同一个已修改文件的后续内容变化也能识别。部署锁防止并行发布。
- **默认不重启后台。** 后端或 DSH 内容变化只报告需要人工维护，不再把查询失败当成空闲，也不在重载时同步模型列表。`busyKnown: false` 表示运行状态未知，不能用它证明可以停止任务。
- **分阶段发布前端。** 构建到临时目录，保留旧哈希资源，最后替换入口；本地健康检查成功才更新部署标记。检查失败回滚入口；不会因为改 README 重启主机。
- **daemon 与 DSH 生命周期分离。** daemon 意外退出进行有限退避重试，耗尽后保持 DSH 存活。维护时可向监督进程发送 `SIGUSR2` 只重新启动 daemon，现有连接仍会短暂中断，待决审批仍可能取消；它不是零中断部署。DSH 退出则停止依赖它的 daemon，由 systemd 恢复整组。
- **显式托管范围排空。** `--daemon` 先构建独立暂存产物，再获取持久 `/maintenance` 租约并等待已接纳操作、托管根会话/后代/队列全部已知空闲。未知不放行。随后仅替换 daemon，确认监督进程/DSH 身份不变、daemon 代数推进且运行时就绪，才释放租约。失败保留私有恢复日志和租约，只有仍确认拥有关闭入口时才回滚；不猜测丢失响应后能否重开。它不能阻止其他 DSH 客户端直接提交，也不重启 DSH。
- **经认证的就绪检测。** stdout 只用于发现固定版本启动凭据；真正就绪要求 cookie 握手及认证的 `session/list` RPC 成功，并持续更新私有 `run/host-readiness.json`（不含令牌）。查询失败或记录过期禁止部署。旧监督进程没有该记录时拒绝执行；首次安装新监督进程需另行确认维护窗口，不伪造记录或强制中断活动任务。

## 安全地切换主机

```bash
scripts/host-switch.sh
```

它停止发布版 unit 并启动开发版 unit，然后一个瞬态 systemd unit —— 位于主机 unit 的 cgroup 之外，因此重启无法杀死它 —— 会恢复发布版主机，除非开发主机在 `TURNWIRE_SWITCH_WINDOW`（默认 600s）内连上 Relay。Relay 链路是正确的检查，因为它证明主机已启动并用存储的 token 完成认证，而不依赖手机是否唤醒。如果你不在机器旁时切换出了问题，机器会自行恢复。

`--no-watchdog` 会跳过这个防护。

## 这一步无法替你完成

手机**从 Relay 加载** PWA，所以手机运行的是 Relay 部署时带的那个 bundle。协议常量发生变化的主机，只能服务用同一份源码构建的手机。切换后重载手机；如果它报告认证失败，就重新部署 Relay，让手机拿到新的 bundle：

```bash
npm run turnwire -- deploy --config <private config>
```

已有配对不受影响：配对凭据是一个 token 和一个密钥，其中没有协议常量，所以两端就同一份源码达成一致就足够了。即使加密通道失败，Relay 仍会通过普通 HTTPS 继续提供页面，因此手机端总是可以重载。

## 手工回滚

```bash
systemctl --user stop turnwire-dev.service
systemctl --user start turnwire-host.service
```

发布版目录树不会被上述任何操作修改，所以发布版主机永远只差一条命令。
