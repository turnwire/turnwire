[English](IMPLEMENTATION.md) · 中文

# Turnwire 实现

## 目标

按最初设计对话中描述的 Turnwire 骨架进行构建，并按要求于 2026-09-09 使用 TypeScript。

- `turnwire`：TypeScript monorepo，包含 core、protocol、runtime 接口、DSH 适配器、SDK、daemon、CLI、Relay 和手机 PWA。
- `turnwire-desktop`：独立的原生 Swift/SwiftUI macOS 客户端，依据用户的明确说明。TypeScript 仅适用于主 monorepo。
- 单个 daemon 拥有会话、runtime 映射、权限与持久化。所有客户端共享同一套 API 和事件流。
- DSH 是第一个 runtime，位于能力驱动的接口之后。不要改动 DSH 的存储。
- 远程设备通过 Relay 建立出站连接；Relay 不运行 agent。对设备进行认证，并加密远程应用负载。

## 交付清单

- [x] 严格的 TypeScript workspace、脚本与可复现依赖
- [x] 带版本且经过校验的 protocol 与 runtime 契约
- [x] 可持久化的会话/事件/审批状态，并支持重放
- [x] 基于官方上游源码的 DSH 适配器
- [x] daemon、经过认证的本地 API 与流式传输
- [x] 用于会话生命周期、prompt、attach 和审批的 CLI
- [x] Relay、配对与可重连的加密远程传输
- [x] 响应式 React PWA，支持会话、prompt 和审批控件
- [x] 位于同级 `turnwire-desktop` 的原生 Swift/SwiftUI 客户端
- [x] 集成测试、构建、用户文档与视觉校验
- [x] 原生与 CLI 均可选用受管临时隧道或自托管 Relay，支持实时配置、配对二维码与清理
- [x] 共享的管理契约/SDK、provider 注入、CLI/TUI 命令复用与跨客户端对等校验

- [x] 共享的重命名/归档/恢复与记录导出、更丰富的工具记录、原生工作区导航、执行/结果视图与 Markdown 呈现

## 调研

DSH 源码参照：`deepseek-ai/deepseek-harness` 的 `fb2c4b9e698e30edb738bca4cf0618587db7d203`（2026-09-09），版本 `0.1.5-rc.2`。其 API Gateway 使用 `POST /api/<namespace>/<method>`，并携带 Connection `client-request` 信封，其中包含 `payload: { args }`。精确签名与实机校验见 `docs/DSH.zh.md`。

## 进展

两个最初为空的工作区现在都包含可运行的实现。使用 Node 22.22.1、npm workspaces、严格 TypeScript、React/Vite 与 Swift 6。校验包括 31 项 TypeScript 集成/契约测试、11 项 Swift 测试（含实机 daemon 与 Relay 配置）、一次真实的交互式终端工作流、桌面/移动浏览器交互检查，以及一次对官方 DSH Host 的实机冒烟测试（认证、创建、列出、恢复、跟随）。原生开发用 `.app` 已打包、以 ad-hoc 方式签名，并带着远程控制设置重新打开。行式 TUI 复用 CLI 命令注册表；行为与持久化状态由共享服务拥有。能力矩阵与代码归属见 `CLIENTS.zh.md`。

DSH 正以用户要求的环境变量配置运行。自动化校验未发送真实模型 prompt。已开通一条临时公网隧道，并用它验证对既有 DSH 会话的加密远程访问。受管临时访问与固定自托管端点现在都可在不重启会话的情况下配置。公网检查及其局限见 `VALIDATION.zh.md`。尚未进行固定服务器部署、公证或仓库发布；额外的 runtime 适配器与其他发布扩展不在本次交付范围内。
