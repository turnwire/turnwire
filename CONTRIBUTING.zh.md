[English](CONTRIBUTING.md) · 中文

# 参与贡献

面向要改这个仓库的人。只想装上用，看 [README](README.zh.md)；想先跑起来看 [从源码开发](docs/DEVELOPING.zh.md)。

## 先读这两份

- [AGENTS.md](AGENTS.md) —— 工程约束：代码归属、能力对等、模型与凭据边界。它同时是自动化代理会读的规则，所以动手前先看。
- [docs/CLIENTS.md](docs/CLIENTS.zh.md) —— 每项能力在各客户端的覆盖，以及"新增行为该放哪一层"。

## 开发环境

把两个仓库克隆到同一父目录（原生客户端与跨仓库验证都假设这个布局）：

```bash
git clone https://github.com/turnwire/turnwire.git
git clone https://github.com/turnwire/turnwire-desktop.git
cd turnwire && npm ci && npm run build
```

接真实模型需要 DSH 与凭据，步骤见 [从源码开发](docs/DEVELOPING.zh.md#接真实-dsh)；离线开发用 `TURNWIRE_RUNTIME=demo npm run dev` 就够了。

## 提交前必须通过

```bash
npm run check          # strict TypeScript + 集成测试 + 生产构建
```

原生客户端在兄弟仓库里：`cd ../turnwire-desktop && swift test`；或在 `turnwire` 里跑 `node --import tsx scripts/native-live-check.mjs`，让原生测试打到隔离服务上。

CI 会跑同样的东西并且**必须绿**，两个仓库都会跑。JSX/CSS 之类的交互改动另有浏览器检查（`scripts/ui-check.mjs`、`scripts/ui-model-check.mjs`、`scripts/history-ui-check.mjs`、`scripts/markdown-ui-check.mjs`），CI 里已经接了。

## 硬约束

这几条不是风格偏好，违反的改动会被要求重做：

1. **能力对等**：一个行为只在一个客户端存在，等于没做完。共享规则放 `packages/protocol`（契约与校验）、`packages/core`（会话与权限）、daemon（主机服务与持久化）；客户端只负责交互与呈现。平台差异（文件选择器、剪贴板、终端渲染）可以不同。
2. **模型归 runtime 所有**：任何一层都不许新增、硬编码、别名化或"猜"模型 id。客户端只显示 runtime 模型目录返回的内容；runtime 没注册的模型必须保持不可选。
3. **凭据边界**：`TURNWIRE_HARNESS_DEEPSEEK_API_KEY` 只由主机上的 DSH 读取。不要把它拷进客户端、Relay、隧道进程、日志或源文件；`config/dsh.env.json` 是未跟踪的私密文件，不要提交。
4. **管理只在本机**：不要给已配对的远程设备开放主机管理权限 —— 能力对等不等于远程可以改主机设置。
5. **不要绕过 SDK**：TypeScript 客户端统一用 `packages/sdk`；CLI 与 TUI 复用 `apps/cli/src/program.ts`，不要新增第二个命令分发器。
6. **provider 集成**放在 `apps/daemon/src/providers` 且位于主机侧接口之后，在 `main.ts` 接线；Cloudflare 只是可选的临时访问 provider，不是 Relay 或本地运行的前提。

## 改动流程

- 一个 PR 一个主题。行为变更要写清**跨客户端的影响**，以及你是怎么验证的。
- 行为变更请同时更新 [docs/CLIENTS.md](docs/CLIENTS.zh.md)。文档里的脚本名、仓库路径、CLI 命令、DSH 版本与凭据变量名由 [tests/docs.test.ts](tests/docs.test.ts) 机械核对，说明过时会直接让 CI 失败。
- 新行为要带测试：请求去重、审批竞态、恢复、加密与 runtime 合约这类**效果**用集成测试；纯呈现的用浏览器检查脚本。
- 报告覆盖要精确：哪些是真实端到端、哪些只是合约夹具或模拟，分开讲，不要含混。

## 提交信息

- 说明**为什么**改，而不只是改了什么；影响面（哪个客户端、哪个边界）写在正文里。
- 不要把任何密钥、token、配对凭据或私人路径写进提交信息、代码或测试夹具。

## 安全

发现安全问题不要开公开 issue，走 [SECURITY.md](SECURITY.zh.md)。
