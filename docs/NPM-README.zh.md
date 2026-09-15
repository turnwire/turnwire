[English](NPM-README.md) · 中文

# Turnwire

在终端、浏览器和手机间继续同一个自托管 Agent 会话。任务由主机上的 DeepSeek Harness（DSH）执行，模型凭据只留在主机。

## 安装预览版

支持 Linux/macOS，需要 **Node.js 22.13+** 和 npm：

```sh
npx turnwire@next
# 或长期安装：
npm install -g turnwire@next
turnwire --open
```

这是预览版，不是稳定版或已签名的原生桌面发行版。无需源码仓库权限。npm 安装本身不会启动服务或安装 DSH；运行启动器后以前台运行，请保持终端打开，Ctrl-C 仅停止它拥有的进程。

## 连接 DSH

明确配置了外部 DSH 时优先复用：提供 `TURNWIRE_DSH_URL` 和 `TURNWIRE_DSH_TOKEN`，或在 Turnwire 配置目录创建仅本人可读的 `dsh-connection.json`（0600，包含 `url`、`token`）。Turnwire 不会停止外部 DSH。

否则启动器会询问安装 registry `latest`，解析为精确版本，安装到独立目录并在隔离 HOME 中验证后才选择。模型密钥通过隐藏输入或 `TURNWIRE_HARNESS_DEEPSEEK_API_KEY` 提供，不要把凭据发到 issue 或聊天。

## 常用命令

```sh
turnwire --help
turnwire doctor --json
turnwire start --no-open --port 9898
# 先停止自己的前台实例，再检查更新：
turnwire start --update-dsh
```

DSH 更新需要明确执行：不自动降级、不热替换、不更新外部或自定义入口。验证失败保留旧安装。私有 `managed-dsh.json` 选择文件只由 npm 启动器使用，不影响旧版系统服务安装器。普通启动不会悄悄升级已有 DSH。

本机使用不需要 Relay。手机访问需另外配置配对和远程连接；手机上的 localhost 指手机自己。长期远程访问优先使用自托管 Relay，不要直接把 daemon 端口暴露到公网。

## 兼容性与边界

连接时验证 DSH 核心认证响应结构，无法确认的可选能力保持未知。Linux/macOS × 基准/latest/next 的 CI 测试真实启动、模型目录、空会话、重启和进程所有权，不发送模型推理请求，也不保证未来任意 DSH 改动永久兼容。真实推理流、审批、图片和 steer 等仍需要更多端到端验证。

源码仓库当前为私有；从 npm 安装不需要仓库权限。仓库内文档链接需要访问权限，包内提供本独立说明及英文版。

- npm：https://www.npmjs.com/package/turnwire
- 源码和 issue（需要权限）：https://github.com/turnwire/turnwire

许可证 Apache-2.0，依赖许可证随包放在 `licenses/`。
