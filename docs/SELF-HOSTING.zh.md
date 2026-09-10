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

加上 `--enable-watch` 会启用 `turnwire-dev-reload.path`，当 `apps/`、`packages/` 或 `scripts/` 变化时自动重载。它默认禁用。

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
scripts/host-reload.sh          # rebuild and restart at a safe point
scripts/host-reload.sh --force  # ignore the fingerprint
```

三个特性让重复运行无害：

- **指纹。** `git rev-parse HEAD` 加上 `git status --porcelain`。因为 `dist/` 被 gitignore，重建不会改变指纹，所以跟随一次构建的 watch 触发运行会立即退出，而不是循环。
- **安全点。** 它会等待（默认 900s）直到没有会话处于 `running` 或 `waiting_approval`，然后才重启，因此重载永远不会打断一个回合。但子代理不是会话：委派工具把活交给子代理后立刻返回，父会话可能已经空闲，而子代理还在跑。所以运行时会报告它仍在负责的子代理（快照里的 `busy`），等待同时覆盖这两者。这个计数是对主机的实时查询，因此连接断开期间启动的子代理也算在内；主机已经无法枚举的子代理（例如已经被上一次重启杀掉的）不在检查范围内，此时退回手工停掉计时器（`systemctl --user stop turnwire-dev-reload.timer`）。
- **重启是可存活的。** 一个回合在 DSH 内部运行，而 DSH 会持久化自己的会话日志，Turnwire 则通过跟随会话并从存储的游标重放来重连。重载后重新 attach 并继续。

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
