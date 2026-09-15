[English](NPM.md) · 中文

# npm 安装包与发布

公开包名和可执行命令均为 **turnwire**（[npm](https://www.npmjs.com/package/turnwire)）。预览版请明确使用 `@next`。当前策略是：每次推送到 `main`，由 GitHub Actions 将唯一测试版本发布到 npm `next`，不创建 GitHub Release。只有已发布的正式 GitHub Release，标签为稳定版 `vX.Y.Z` 且 `prerelease: false`，才走常规稳定发布路径，更新 npm `latest` 并上传 Release 附件。所有 npm 发布与 Release 附件上传都只能通过 Actions；禁止本地发布或本地上传兜底。以下策略说明不代表已经测试过一次新的工作流运行。

## 用户使用

安装已发布的预览版：

```sh
npx turnwire@next
# 或长期安装：
npm install -g turnwire@next
turnwire
```

目标平台为 Linux、macOS，应用要求 Node.js 22.13 或更新版本，建议使用受支持的新版本。不宣称支持原生 Windows。首版以前台运行，不暗中安装后台服务；运行期间不要删除安装文件或 npx 缓存。

启动器应优先连接已有、认证有效且兼容的 DSH；否则解析 npm `latest` 并提示安装该精确版本；兼容性依靠实际接口验证，不再要求与测试基准版本完全相同。安装和凭据配置必须明确取得用户同意。外部 DSH 归用户所有，停止 Turnwire 不得停止它。模型名称与能力由 runtime 提供，安装器不自行编造。本机使用无需 Relay，远程以自托管为主，可选配置 Relay／隧道。API Key、配对码和 npm token 不应出现在 issue、发布日志或源码里。

## 首次启动细节

- 已有 DSH：显式提供 `TURNWIRE_DSH_URL` 与 `TURNWIRE_DSH_TOKEN`，或在 Turnwire 配置目录创建仅本人可读的 `dsh-connection.json`（0600，包含 `url`、`token`）。不会扫描进程或读取其他工具的秘密；认证失败不会擅自安装替代实例。
- 没有配置外部实例时：检查 Turnwire 数据目录里的托管 DSH，缺失才询问安装。可用 `--yes` 明确允许安装，不能代替所需的模型凭据。
- 首次所需模型凭据：读取 `TURNWIRE_HARNESS_DEEPSEEK_API_KEY`，或交互式隐藏输入，私有配置不会被覆盖。
- 默认前台运行。`--open` 打开已认证本机 Web，`--no-open` 不打开浏览器。浏览器启动链接只允许同源 loopback，并在读取后清除片段凭据。
- `--port PORT` 选择 Turnwire Web 端口；`TURNWIRE_DSH_PORT` 选择新启动的托管 DSH 端口。占用时拒绝启动，不停止其他服务。
- `turnwire doctor --json` 离线检查环境，不下载运行时、不创建配置。

这不是任意 DSH 安装的自动发现器：首版复用需要明确的外部连接配置，或 Turnwire 已管理的安装位置。已有但不在这些位置的 DSH 不会被擅自接管。

## DSH 最新版与安全更新

运行 `turnwire start --update-dsh` 显式检查并更新托管 DSH；需要时可加 `--yes` 授权安装。先停止自己的 Turnwire 前台实例再运行，不在活跃会话中热替换。更新解析 npm `latest` 到精确版本，先安装到新的版本目录，在隔离 HOME 中用非真实密钥验证认证接口，通过后才原子切换私有选择文件。失败不切换，旧安装保留；不会自动降级，不更新外部 DSH 或自定义入口。

普通启动不会无限轮询 npm 或擅自更新。`latest` 是 npm 发布者维护的通道，不保证版本号大于 `next`。兼容性依据实际返回结构，不伪造上游协议版本或未提供的能力握手。完整边界和 CI 覆盖见 [DSH 兼容性](DSH-COMPATIBILITY.md)。

## 文档维护门禁

安装说明的共享内容在 `docs/install-snippets.json`，最低 Node 版本来自根 `package.json`。修改源内容后运行 `npm run docs:sync`，提交生成的中英文 README、快速开始和 npm 包内说明。`npm run docs:check` 只检查、不写文件，发现过时生成块就失败；它也纳入 `npm run check` 和打包前置检查。

发布矩阵会解包真实 tarball，对比包内两份 README 与本次提交的来源文件（仅转换语言互链）。源码 README 对应 main，npm 包内说明对应具体版本，不要求旧版本的文档随 main 变化。PR 模板要求说明文档影响；机器检查不能代替对行为解释完整性的人工评审。

## npm 包内文档

包内独立中英文安装说明来自 `docs/NPM-README.md` 和 `docs/NPM-README.zh.md`，打包时互链改写为 `README.md` / `README.zh.md`，阅读不需要私有源码仓库权限。仓库文档更新不会改变已发布 `0.1.0-next.0` 的 tarball 或 npm README；包内说明的改动应随新版本发布，不能重复发布同版本。

## 构建可审阅的安装包

在干净源码目录中执行：

```sh
npm ci
npm run check
node scripts/package-npm.mjs
mkdir -p artifacts/npm/tarballs
npm pack ./artifacts/npm/turnwire --pack-destination ./artifacts/npm/tarballs
npm pack ./artifacts/npm/turnwire --dry-run
```

启动器源码为 `apps/launcher/main.mjs`，打包脚本 `scripts/package-npm.mjs` 生成 `artifacts/npm/turnwire`。只发布审阅过的 tarball，不发布 monorepo 根目录。检查文件列表、包身份、许可证和 SHA-256，排除配置、状态、数据库、日志、私钥与凭据。安装后不能依赖工作区链接或源码路径。

既有 `.github/workflows/check.yml` 继续执行完整类型检查、测试和构建。新增 `npm-package.yml` 在 Linux／macOS 上从 tarball 安装到仓库外的隔离目录，禁用安装生命周期脚本，执行 `--help`、`--version` 和离线 `doctor --json`。还会从安装包启动 demo daemon，使用临时端口验证 health、认证的 `system.snapshot` RPC、Web 契约与静态资源。矩阵使用 GitHub 托管 runner 覆盖 Linux x64/arm64 与 macOS arm64/x64。这里只有经过运行的矩阵结果才算该平台验证。 这些检查不代表已经验证真实 DSH 安装、模型请求、手机连接、后台服务或所有 CPU 架构。macOS 验证由 Actions 执行，不能从本地 Linux 测试推断通过。

## 发布历史（不是当前操作指南）

`0.1.0-next.0` 在首次引导时手动发布；当时 registry 完整性与审阅过的 tarball 一致，全新 registry 安装、CLI/doctor 及安装包 demo/Web 启动检查通过。那次历史核验时，`next` 和 `latest` 都指向预览版。之后的 `0.1.0-next.1` 由 Actions 发布到 npm，但 Release 附件曾手动上传。这些是历史例外，不是当前发布策略或备用流程，不能据此声称新的 main 推送／稳定 Release 自动化已经验证、稳定版已就绪或已有签名原生发行版。

旧的本地首次发布操作指南已废止。今后的 npm 发布及 Release 附件上传必须使用下述 Actions 工作流；授权失败应在自动化配置中修复，不能在本地绕过。

## GitHub 受信发布配置

npm 包设置中绑定 GitHub Actions：

- Organization/user：`turnwire`
- Repository：`turnwire`
- Workflow filename：**`npm-release.yml`**
- Environment：**`npm-release`**

保持现有 npm Trusted Publisher 绑定不变。在 GitHub 配置 `npm-release` 环境，允许 `main` 分支（推送预览及手动触发）和 `v*` 标签（已发布的稳定 Release 事件）。Release 作业使用标签 ref，因此只允许 main 会阻止自动发布。`v*` 只是环境准入规则，不代替严格版本校验；工作流另行校验支持的版本格式及 main 祖先关系。保护 main 和版本标签，限制谁可以发布 Release，严格审阅 workflow 修改。套餐支持时可配置必要审批者，仅在 YAML 写环境名称不会自动启用审批。使用 GitHub 托管 runner。发布 workflow 使用 Node 24 和 npm 11.6.2 进行 OIDC 发布，与应用最低 Node 版本分开。无需 `NPM_TOKEN`，但上述 npm Trusted Publisher 绑定是必要前提；工作流文件存在不等于已获得 npm 发布授权。

当前 GitHub 仓库为私有。即使 npm 包公开，npm 也不支持私有源码仓库的 provenance；workflow 对私有仓库明确禁用 provenance，但仍用 OIDC 认证，仓库公开时才启用来源证明。它不会改变仓库可见性。当前仓库套餐不支持必要环境审批者，不能声称已配置独立审批门禁。应将 `npm-release` 限制为 main 和 `v*` 标签，并限制仓库和 Release 写权限。合并或推送到受保护的 main 授权自动预览发布；发布正式 GitHub Release 是常规稳定发布的授权动作。main 上输入确认文字的手动触发仅限于当前 main 的预览，或修复已有正式 Release。若要求独立审批，应先使用支持的套餐或保护机制。

参考：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) 与 [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)。升级 CI 版本时重新核对要求。

## Main 预览与稳定发布

### Main 推送 → npm `next`，不创建 GitHub Release

每次推送到 `main`，都会启动 `.github/workflows/npm-release.yml` 中的 **Publish npm**。工作流读取 `scripts/package-npm.mjs` 的版本，去掉预发布后缀取得稳定基础版本，再根据不可变源码提交生成唯一测试版本 `<base>-next.<github.run_number>.<shortsha>`。例如基础版本 `0.1.0` 会生成形如 `0.1.0-next.123.abcdef0` 的版本。打包、测试和发布均使用生成版本，不在本地修改源码版本。新的运行具有新的 run number；重新运行同一次运行则保持原版本。

安装包与 DSH 门禁通过后，Actions 将同一个经过测试的 tarball 发布到 npm `next`。该路径不创建 GitHub Release，也不上传 Release 附件。预览发布不会更新 `latest`，无需预发布标签或 GitHub pre-release。

### 已发布的正式 Release → npm `latest` 与附件

1. 将 `scripts/package-npm.mjs` 中的 `packageVersion` 设为稳定版本，更新发布说明，完成验证并合并到 main。稳定标签必须与该提交的包版本一致；创建 Release 不会改写源码版本。
2. 为 main 上已审阅的提交创建严格的稳定标签 `vX.Y.Z`。创建对应 GitHub Release 并点击 **Publish release**，不勾选 **pre-release**（`prerelease: false`）。草稿、编辑 Release 或仅推送标签不会发布稳定包。预发布标签和 GitHub pre-release 都不是发布入口。
3. `release: published` 事件启动 **Publish npm**。工作流验证稳定标签、main 祖先关系及正式 Release 元数据，解析不可变提交，再运行四个平台的安装包测试（Linux/macOS × x64/arm64）和 Linux/macOS × 基准/latest/next 的真实 DSH 检查。仅实际配置审批规则时才有环境审批。
4. 全部门禁通过后，Actions 校验包名和版本，通过 OIDC 将经过 Ubuntu 测试的同一个 tarball 发布到 npm `latest`，不重新构建。仅公开源码仓库请求 provenance。
5. npm 发布成功后，Actions 将同一个 `.tgz` 和 `SHA256SUMS` 附加到该已有正式 Release，不悄悄覆盖附件。当前私有仓库的 Release 下载仍需仓库权限；npm 包则是公开的。

### 手动 Actions 触发与故障恢复

在 `main` 上通过 `workflow_dispatch` 运行 **Publish npm**，在 `confirm` 中输入 `publish-turnwire`。`tag` 输入是**可选的**：

- `tag` 留空：将当前 main 的唯一预览版本发布到 npm `next`，不创建 GitHub Release，也不上传 Release 附件。
- 填入已有稳定标签 `vX.Y.Z`：仅用于修复该标签**已经发布的正式 Release**（`draft: false`、`prerelease: false`）。仍需通过相同源码、版本和测试门禁；工作流发布到 `latest` 并上传附件到已有 Release，不创建 Release。拒绝任意预发布标签，以及不存在、草稿或 pre-release 的 Release。

如果 npm 已成功但附件上传失败，不会回滚 npm。检查原运行及附件后，应在**同一次 Actions 运行**选择 **Re-run failed jobs**，复用原先测试过的制品与版本。不要在本地重新构建、重复发布不可变的 npm 版本或本地上传附件。重新发起一次 dispatch 不是该部分成功运行的恢复方式。所有发布和上传仍只能由 Actions 完成，不允许本地 npm publish 或 `gh release upload` 兜底。

PR 无法直接触发发布；标签输入先验证再检出其源码。只有 npm publish 作业获得 `id-token: write`，Release 上传作业只获得所需的仓库写权限。发布不运行包生命周期脚本，也不重新构建测试过的 tarball。OIDC 绑定失败必须停止，不自动退回高权限 token。这份文档说明所配置的自动化，不表示已创建新的 Release 或执行过一次新的自动 npm 发布。

npm 已发布版本不可覆盖。有问题应发布新版本；必要时审阅影响后把 dist-tag 指回已知正常版本。不要强推标签，不覆盖用户配置。稳定版发布前仍需真正完成 Linux／macOS 安装、启动与升级验证，不能把 CI 冒烟测试当作全部验收。
