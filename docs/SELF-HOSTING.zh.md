[English](SELF-HOSTING.md) · 中文

# 用 Turnwire 开发 Turnwire

主机可以运行这份检出，而不是已安装的发布版，于是编辑 Turnwire 的 Agent 正是 Turnwire 正在运行的 Agent。本文介绍这个循环、让它仅限开发用途的防护，以及恢复流程。切换或重载可能中断远程连接；回滚不保证恢复不兼容的状态。

## 为什么这不是产品功能

自动更新被刻意排除在所有产品界面之外：

- 它**没有 RPC 方法**，因此任何客户端都无法调用 —— 本机 CLI、桌面 App 和已配对手机都不行。远程设备无法触发代码部署。
- 安装器（`scripts/install-host-service.mjs`、`scripts/install-linux-host.sh`）从不创建开发用途的 unit，也从不启用重载。按照文档中的安装路径操作，不可能得到一个自我更新的主机。
- 定义新行为不在这里的范围内：这里只改变主机运行的是哪个构建。

边界是文件系统，而不是 API：**只有能在这个 git 检出内运行 shell 的人才能重载它。** `scripts/host-reload.sh` 直接强制这一点 —— 除非目标是 git 工作树，否则它会拒绝，因此已安装的发布版（没有 `.git`）永远无法自我更新，即使有人找到并运行该脚本也一样。它还拒绝 `turnwire-dev.service` 之外的任何 unit，因此发布版主机永远不会被触碰。

## 安装开发主机（不会启动任何东西）

```bash
npm ci --prefix config/dsh-runtime          # the DSH the host will run
export TURNWIRE_DSH_ENV_FILE=/absolute/private/dsh.env.json # 已准备好的文件，权限 0600
npm run build
scripts/install-dev-host.sh --state <state> --dsh-home <dsh-state>
```

显式选择 `--state` 和 `--dsh-home`。只有确认状态使用当前最终存储 schema、v2 配对且 DSH home 兼容后，才能复用。Store 拒绝旧数据库且不迁移；不兼容的安装应使用独立空状态，重新配置主机并创建新配对，不应把新主机指向旧状态来升级。见[首次升级](FIRST-UPGRADE.zh.md)。config/data/cache 使用分离的 XDG 路径或显式 `TURNWIRE_CONFIG_HOME`、`TURNWIRE_DATA_HOME`、`TURNWIRE_CACHE_HOME` 覆盖；`--state` 设置 `TURNWIRE_STATE_HOME`，不设置其他路径，也不检测旧布局。不会启动任何东西：unit 存在但保持 inactive，直到你切换过去。

加上 `--enable-watch` 会同时启用 `turnwire-dev-reload.path` 和补充轮询的 `.timer`。默认关闭；禁用会立即停止两种触发器及正在运行的重载任务。监听只允许兼容的前端静态资源发布，后端或 DSH 变动不会自动重启服务。

## DSH 环境文件

私有 `TURNWIRE_DSH_ENV_FILE`（权限 0600，默认 `~/.config/turnwire/dsh.env.json`，通过 `TURNWIRE_CONFIG_HOME` / `XDG_CONFIG_HOME` 解析）是 DSH 启动时的环境，而不是"一个 key 的位置"：里面每个字符串都会转发给 DSH 进程；Turnwire 自己的密钥（relay token、DSH 启动 token 和 URL）即使写在这个文件里也会被剥掉。文件里的任何东西都不会进入 daemon 或任何客户端 —— 模型凭据始终留在 DSH 内部。

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
// TURNWIRE_DSH_ENV_FILE
{ "TURNWIRE_HARNESS_DEEPSEEK_API_KEY": "…", "TURNWIRE_HARNESS_GATEWAY_KEY": "…" }
```

Turnwire 侧不需要知道任何事：runtime 的模型目录会为每条已注册的路由报告一个 group 以及它自己的 failures，daemon 会拒绝 runtime 没列出的模型，每个客户端展示的就是这些 group。加一条路由，下一次快照就能在所有客户端看到 —— 不用改客户端，也不用在这边发明模型 id。

## 重载

```bash
scripts/host-reload.sh             # 检查内容变化；只发布兼容的前端资源
scripts/host-reload.sh --frontend  # 验证运行中后端契约后初始化/发布前端
scripts/host-reload.sh --daemon --dry-run  # 仅验证暂存构建，不访问或修改运行主机
scripts/host-reload.sh --daemon    # 显式租约排空、只替换 daemon、验证后恢复提交
```

- **按组件计算内容指纹。** 文档和测试不触发部署；同一个已修改文件的后续内容变化也能识别。部署锁防止并行发布。
- **默认不重启后台。** 后端或 DSH 内容变化只报告需要人工维护，不再把查询失败当成空闲，也不在重载时同步模型列表。`busyKnown: false` 表示运行状态未知，不能用它证明可以停止任务。
- **分阶段发布前端。** 构建到临时目录，保留旧哈希资源，最后替换入口；本地 `/health` 必须返回实际运行构建的 `identity.buildId` 与 `identity.contractDigest`。前端 `turnwire-build.json` 的所需契约必须匹配，显式 `--frontend` 也不能绕过。daemon 构建身份覆盖实际打包依赖图、捕获的源码输入、构建配置及声明依赖锁，不再依赖手工枚举源码目录；已安装外部依赖的实际字节不属于此源码/构建身份，必须与 lockfile 保持一致。源码运行模式或不提供构建身份的后端不能用于发布验证。构建前、发布前后均验证实际身份，成功才更新部署标记；检查失败回滚入口，不会因为改 README 重启主机。
- **daemon 与 DSH 生命周期分离。** daemon 意外退出进行有限退避重试，耗尽后保持 DSH 存活。维护时可向监督进程发送 `SIGUSR2` 只重新启动 daemon，现有连接仍会短暂中断，待决审批仍可能取消；它不是零中断部署。DSH 退出则停止依赖它的 daemon，由 systemd 恢复整组。
- **显式托管范围排空。** `--daemon` 先构建独立暂存产物，再获取持久 `/maintenance` 租约并等待已接纳操作、托管根会话/后代/队列全部已知空闲。未知不放行。随后仅替换 daemon，确认监督进程/DSH 身份不变、daemon 代数推进且运行时就绪，才释放租约。失败保留私有恢复日志和租约，只有仍确认拥有关闭入口时才回滚；不猜测丢失响应后能否重开。它不能阻止其他 DSH 客户端直接提交，也不重启 DSH。
- **经认证的就绪检测。** stdout 只用于发现固定版本启动凭据；真正就绪要求 cookie 握手及认证的 `session/list` RPC 成功，并持续更新私有 `run/host-readiness.json`（不含令牌）。查询失败或记录过期禁止部署。旧监督进程没有该记录时拒绝执行；首次安装新监督进程需另行确认维护窗口，不伪造记录或强制中断活动任务。

暂存 daemon 在获取维护租约前，以及排空后、安装前，各执行一次 `--check-storage`。兼容性检查失败时不安装、不发送信号，也不迁移数据库。daemon-only 更新还校验当前前端契约与新 daemon 匹配，替换后核对精确构建 ID；跨契约更新需要在维护窗口完成整套离线发布，不能用单侧发布强行切换。`--dry-run` 只构建，不读取活动数据库。

## 安全地切换主机

```bash
scripts/host-switch.sh
```

它停止发布版 unit 并启动开发版 unit，然后一个瞬态 systemd unit —— 位于主机 unit 的 cgroup 之外，因此重启无法杀死它 —— 会恢复发布版主机，除非开发主机在 `TURNWIRE_SWITCH_WINDOW`（默认 600s）内连上 Relay。Relay 链路只检查主机启动及存储 token 的认证，不依赖手机是否唤醒；它不证明设备登记、E2EE 连通性或数据兼容。看门狗会尝试恢复服务，但不保证旧发布版能读取所选状态，或远程操作者能重新连上。切换前应安排本地恢复手段。

`--no-watchdog` 会跳过这个防护。

## 这一步无法替你完成

手机**从 Relay 加载** PWA，所以手机运行的是 Relay 部署时带的那个 bundle。协议常量发生变化的主机，只能服务用同一份源码构建的手机。切换后重载手机；如果它报告认证失败，就重新部署 Relay，让手机拿到新的 bundle：

```bash
npm run turnwire -- deploy --config <private config>
```

配对携带协议版本，只有兼容的 v2 配对才能复用；两端源码相同不会转换 v1 凭据或旧状态。v1 配对被拒绝且没有升级路径，应配置新安装并从本地主机创建新的 v2 邀请。可达的 Relay 在 E2EE 失败时仍可能通过 HTTPS 提供 PWA，但重载页面既不修复不兼容凭据，也不保证恢复远程访问。见[首次升级](FIRST-UPGRADE.zh.md)。

## 手工回滚

```bash
systemctl --user stop turnwire-dev.service
systemctl --user start turnwire-host.service
```

这些开发脚本不修改发布版目录树，但只有配置、运行时和状态兼容时，才能安全启动该发布版。文件回滚不是数据库迁移或凭据恢复，也不保证会话不中断。切换前应保留独立可用的发布环境，安排维护窗口和本地访问手段。
