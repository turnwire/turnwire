[English](NPM.md) · 中文

# npm 安装包与发布

公开包名和可执行命令均为 **turnwire**，首个预览版本为 `0.1.0-next.0`。registry 返回 404 不代表名称已被保留，首次发布时仍由 npm 校验名称与权限。本说明描述发布流程；本地构建完成不等于已经发布。

## 用户使用

预览版发布后：

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

## 首次发布：维护者手动引导

1. 确认 `npm whoami`、名称权限及账号 2FA，不把 token 保存到仓库。
2. 审阅源码提交、CI 结果、tarball 文件列表与版本。首包应为 `turnwire@0.1.0-next.0`，如需变更版本应先明确修改再打标签。
3. 在可信本机终端交互登录 npm，发布**审阅过的 tarball**：

   ```sh
   npm publish ./artifacts/npm/tarballs/turnwire-0.1.0-next.0.tgz --access public --tag next
   ```

   这是需要维护者明确授权的步骤，不是在验证前立即发布的指令。不要省略 tarball 路径去发布工作区根目录；本地首次发布没有生成 provenance 时，不声称有来源证明。
4. 验证 `npm view turnwire@next name version dist.integrity`，并在干净环境安装 registry 版本。
5. 在已创建的 npm 包设置中配置 Trusted Publisher。

## GitHub 受信发布配置

npm 包设置中绑定 GitHub Actions：

- Organization/user：`turnwire`
- Repository：`turnwire`
- Workflow filename：**`npm-release.yml`**
- Environment：**`npm-release`**

在 GitHub 创建 `npm-release` 环境，支持时配置必要审批者；限制发布从受保护的 `main` 分支执行，保护 main 和版本标签，严格审阅 workflow 修改。仅在 YAML 写环境名称不会自动启用审批保护。使用 GitHub 托管 runner。发布 workflow 使用 Node 24 和 npm 11.6.2 进行 OIDC 发布，与应用最低 Node 版本分开。无需配置 `NPM_TOKEN`。

当前 GitHub 仓库为私有。即使 npm 包公开，npm 也不支持私有源码仓库的 provenance；workflow 对私有仓库明确禁用 provenance，但仍用 OIDC 认证，仓库公开时才启用来源证明。它不会改变仓库可见性。当前仓库套餐不支持必要环境审批者，不能声称已配置独立审批门禁。应将 `npm-release` 限制为 main，限制仓库写入及 workflow 手动运行权限；目前明确输入确认的手动触发是可用的人为授权边界。若要求独立审批，应先使用支持的套餐或保护机制。

参考：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) 与 [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)。升级 CI 版本时重新核对要求。

## 后续发布

1. 更新版本来源与发布说明，完成验证并合并到 main。
2. 为已审阅的 main 提交创建并推送版本标签，例如 `v0.1.0-next.1`。
3. 从 `main` 手动运行 **Publish npm**，填入已有标签并输入 `publish-turnwire`。
4. workflow 校验标签格式及 main 祖先关系，解析不可变提交，运行跨平台安装包测试和 baseline/latest/next 的真实 DSH 兼容测试，再进入发布环境（是否需要审批取决于实际配置）。
5. 发布经过 Linux 测试的同一个 tarball，校验包名和版本与标签一致，并使用 OIDC 认证（仅公开源码仓库请求 provenance）。`vX.Y.Z-next.N` 进入 `next`，`vX.Y.Z` 进入 `latest`，其他预发布格式拒绝。

PR 无法直接触发发布；标签验证之前不会检出任意用户输入的 ref。仅 publish 作业获得 `id-token: write`，不运行包生命周期脚本，也不重新构建待发布文件。OIDC 配置失败应停止，不应自动退回高权限 token。

npm 已发布版本不可覆盖。有问题应发布新版本；必要时审阅影响后把 dist-tag 指回已知正常版本。不要强推标签，不覆盖用户配置。稳定版发布前仍需真正完成 Linux／macOS 安装、启动与升级验证，不能把 CI 冒烟测试当作全部验收。
