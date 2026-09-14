English · [中文](DSH-COMPATIBILITY.zh.md)

# DSH compatibility / DSH 兼容性

## What is tested

`.github/workflows/dsh-compatibility.yml` builds the standalone npm package and tests actual DSH on Linux and macOS, with three independent targets:

- Baseline: `0.1.5-rc.2`.
- npm `latest`, resolved to an exact version immediately before installation.
- npm `next`, independently resolved to an exact version. Dist-tags need not be ordered chronologically; neither tag is assumed newer than the baseline.

Runs are daily (04:23 UTC), manually dispatched, triggered by relevant main pushes/PRs, or reused with an exact source revision by release validation. The resolved runtime version, OS and architecture are logged. DSH is installed in a temporary prefix with `--ignore-scripts`, no lifecycle scripts, an isolated npm cache and explicit environment allowlist. HOME and every XDG path are isolated. Model credentials are a nonsecret dummy value; there are no inference requests. Runtime output and launch credentials are never published as CI artifacts.

Run locally after building the package:

```sh
node scripts/package-npm.mjs
node scripts/dsh-compatibility.mjs baseline artifacts/npm/turnwire
node scripts/dsh-compatibility.mjs latest artifacts/npm/turnwire
node scripts/dsh-compatibility.mjs next artifacts/npm/turnwire
```

The script starts actual managed and external DSH instances on separate free loopback ports. Authenticated Turnwire `/rpc` calls exercise Core and the real DSH adapter: online `system.snapshot`, runtime-owned `model.catalog`, empty `session.create`, managed restart and `session.resume` (adapter runtime-root lookup), plus session visibility. No model IDs are invented or selected. Shutdown checks require owned daemon/DSH PIDs to exit and an externally owned DSH to survive Turnwire shutdown; test cleanup then stops that external process explicitly. Each root has a dedicated process group for failure cleanup.

## Reporting and limits

A separate `.github/workflows/dsh-compatibility-report.yml` reads completed trusted default-branch scheduled/manual run metadata only. It never checks out source or downloads artifacts. Its only write permission is issues write; it updates one bot-owned failure issue, and closes it only after a complete successful matrix. PRs and reusable release jobs do not acquire issue-writing credentials. Older run results are ignored when a newer trusted run exists. Cancellation is not success.

Observed locally during implementation: the real baseline installed with lifecycle scripts disabled, authenticated snapshots/model catalog/empty sessions passed, and managed/external process ownership checks passed. New changes to the probe and other versions/platforms must be evaluated from their own execution results. A configured workflow is not evidence that its matrix passed.

This is a no-inference integration smoke, not a promise of perpetual compatibility. It does **not** verify token streaming, tool execution, approval interactions, steer/cancel during inference, image inference, optional context fields, provider availability, real credential validity, every CPU architecture, or runtime update races. Registry/network failures also fail CI and require investigation before being labelled an upstream incompatibility. A passing baseline does not certify `latest`; a passing `latest` does not certify `next`. Stable upstream protocol contracts and broader integration tests remain necessary.

## 中文说明

工作流每天 04:23 UTC、手动、相关 PR/main 推送及发布校验时，分别在 Linux/macOS 测试真实 DSH：固定基准 `0.1.5-rc.2`、registry `latest` 和 `next`。标签先解析成精确版本再安装，不假定 latest 一定比 next 或基准新。安装使用临时目录、独立 npm cache、显式环境白名单和隔离 HOME/XDG，禁用全部生命周期脚本；模型凭据只使用非秘密的假值，不发起模型请求。

验证范围是：托管/外部 DSH 真正启动、认证后的 Core 快照显示 runtime 在线、真实适配器读取模型目录、创建空会话、托管重启并恢复会话，以及停止 Turnwire 的进程所有权边界。模型 ID 完全取自 runtime，不自行编造。运行时输出中的启动凭据不写入 CI 日志或上传为产物；失败清理仅处理测试自己的进程组。

独立报告工作流只处理本仓库默认分支的定时/手动结果，不执行检出代码、不读取产物。失败更新机器人 issue，完整矩阵成功才关闭；PR 和复用发布流程没有 issue 写权限。取消、跳过和网络失败不能被当作兼容成功。

实施时本地已观察到固定基准的真实启动、认证、模型目录、空会话和进程所有权测试通过。其他版本、平台及后续探针改动必须以各自实际运行结果为准，不能仅因 YAML 已配置就宣称通过。

这不是“DSH 永远最新、Turnwire 永远兼容”的保证。没有付费模型请求，所以未验证真实推理流、工具调用、审批、运行中 steer/取消、图片推理、可选上下文统计、真实凭据、所有架构或更新竞争条件。上游稳定协议约定、更多端到端测试和及时修复仍然不可替代。
