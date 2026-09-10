[English](DEVELOPING.md) · 中文

# 从源码开发

面向要改代码、跑测试或接真实模型的读者。只想装上用，看 [README](../README.zh.md)。

## 环境与构建

需要 Node.js 22.13+ 和 npm。把两个仓库克隆到同一父目录，方便运行原生客户端和跨仓库验证：

```bash
git clone https://github.com/turnwire/turnwire.git
git clone https://github.com/turnwire/turnwire-desktop.git
cd turnwire
npm ci
npm run build
```

离线验证完整多端工作流（不需要模型凭据）：

```bash
TURNWIRE_RUNTIME=demo npm run dev
npm run turnwire -- connect
npm run turnwire -- new '检查这条会话的审批同步' --runtime demo --title '第一次接续'
npm run turnwire -- ls
```

`npm run dev` 运行 daemon，`npm run dev:web` 单独运行 Vite 开发服务器。生产构建的 PWA 由 daemon 同源提供。默认状态目录为 `~/.turnwire`；可用 `TURNWIRE_HOME` 指定独立目录。**不要同时用多个 daemon 操作同一状态目录。**

## 接真实 DSH

适配器依据官方源码版本 **0.1.5-rc.2** 实现，使用官方 API Gateway 和 Remote mux，不解析终端输出。固定的源码修订写在 [DSH 接口说明](DSH.zh.md) —— 换版本前先读那份契约，alpha 与稳定标签的接口可能不同。

```bash
# 终端 1：确保已 export TURNWIRE_HARNESS_DEEPSEEK_API_KEY（只检查是否存在，不输出密钥）
test -n "$TURNWIRE_HARNESS_DEEPSEEK_API_KEY" && npm run dev:dsh

# 终端 2：复制 DSH 输出的启动 URL，包含 ?token=...
TURNWIRE_DSH_URL='http://127.0.0.1:3080/?token=YOUR_DSH_LAUNCH_TOKEN' npm run dev

# 终端 3
npm run turnwire -- status
npm run turnwire -- new '说明当前项目的结构' --title '了解项目'
```

`npm run dev:dsh` 加载 [DeepSeek 配置](../config/dsh-deepseek.patch.yml)，让模型和网页搜索使用环境变量 `TURNWIRE_HARNESS_DEEPSEEK_API_KEY`。配置只保存变量名，DSH 在请求时读取凭据；密钥必须存在于启动 DSH 的终端环境里，只设置在 daemon 或桌面端进程中不会传给已经运行的 DSH。

DSH 独立运行并保留自己的数据目录、模型配置和凭据。Turnwire 不读取或修改 DSH 内部持久化文件。如果已有 DSH `settings.yaml` 显式设置了 `llm-deepseek.apiKeyEnv`，该用户设置优先，需要把引用名同步为 `TURNWIRE_HARNESS_DEEPSEEK_API_KEY`。`TURNWIRE_DSH_TOKEN` 是单独的本机连接令牌；token 缺失、版本不兼容或服务离线时会明确报错，不会自动降级为 Demo。

宿主机与 daemon 的部署、常驻服务与自动更新见 [用 Turnwire 开发 Turnwire](SELF-HOSTING.zh.md)；服务器侧部署见 [自托管 Relay + PWA](DEPLOYMENT.zh.md)。

## 验证

```bash
npm run check   # strict TypeScript + integration tests + production build
```

推送时只跑这一条。下面的浏览器场景每一个都要真实启动 Relay、daemon 或 DSH，并用 Chrome 走完一段完整故事，它们属于改动它们的那次提交，而不是每次提交；按需要跑其中一项，或在 Actions 里手动触发 `Scenarios` 工作流。

```bash
# 模型选择器（隔离的 DSH 主机；需要 Chrome 和 `npm ci --prefix config/dsh-runtime`）：
bash scripts/ui-model-check.sh

# 真实 DSH 回合、审批、排队提示与派发记录（需要模型凭据）：
node --import tsx scripts/dsh-live-check.mjs

# 历史分页与切标签页，各自带隔离的 Relay、daemon 和 Chrome：
node --import tsx scripts/history-ui-check.mjs
node --import tsx scripts/remote-resilience-check.mjs

# 手机 PWA 里的提问卡片与后台子代理，在 390 px 和 320 px 下各测一遍：
node --import tsx scripts/question-ui-check.mjs

# 完整 UI 走查需要先起一个隔离的 Demo：
TURNWIRE_HOME=/tmp/turnwire-preview-state TURNWIRE_RUNTIME=demo npm run dev   # 另开终端
TURNWIRE_HOME=/tmp/turnwire-preview-state node scripts/ui-check.mjs
```

测试覆盖请求去重、审批竞态、数据库恢复、事件补发、本机鉴权、DNS rebinding 防护、Relay 撤销、密文完整性、跨设备隔离、重放拒绝、模型目录与选择校验（未注册的模型会被拒绝）、DSH 合约和 UI 主要流程。文档里的脚本名、仓库路径、CLI 命令、DSH 版本与凭据变量名由 `tests/docs.test.ts` 机械核对，说明过时会直接让 CI 失败。

DSH 合约夹具用于校验具体协议，不能替代实际模型与工程的端到端验证；"哪些只在特定条件下验证过"以 [验证记录](VALIDATION.zh.md) 为准。

## 工程结构

```text
apps/cli             终端客户端
apps/daemon          turnwire-host、本机鉴权、事件流、Remote bridge
apps/relay           认证、在线连接、密文转发
apps/deployer        通用服务器安装器、SSH 传输、发布校验与回滚
apps/remote-web      React + Vite PWA
packages/protocol    版本化消息、类型和运行时校验
packages/runtime     AgentRuntime 接口和明确标注的 Demo
packages/runtime-dsh 官方 DSH HTTP / WebSocket 适配器
packages/core        会话、权限、SQLite、事件和请求去重
packages/sdk         本机 / Remote 客户端、加密、会话展示模型
```

代码归属、每项能力在各客户端的覆盖，以及"新增行为该放哪一层"，见 [多端功能对等](CLIENTS.zh.md) 与 [协议与状态边界](PROTOCOL.zh.md)。
