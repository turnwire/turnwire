[English](XDG.md) · 中文

# 新安装的 XDG 目录

新安装按照 XDG 基础目录规范，把外部应用数据与源码目录分离。**不迁移已有安装。** XDG 环境变量必须是绝对路径；空值或相对路径使用标准 HOME 默认值。

| 用途 | 新安装默认位置 |
| --- | --- |
| 私有配置、本机客户端连接描述 | `$XDG_CONFIG_HOME/turnwire`，未设置时 `~/.config/turnwire` |
| 会话数据库、主机状态、DSH 状态与附件 | `$XDG_STATE_HOME/turnwire`，未设置时 `~/.local/state/turnwire` |
| 安装的 Node/DSH 运行时依赖 | `$XDG_DATA_HOME/turnwire/runtime`，未设置时 `~/.local/share/turnwire/runtime` |
| 下载暂存、可重新下载的工具 | `$XDG_CACHE_HOME/turnwire`，未设置时 `~/.cache/turnwire` |

DSH 环境文件默认是 `配置目录/dsh.env.json`，DSH 状态是 `状态目录/dsh`。Linux 用户服务位于 `$XDG_CONFIG_HOME/systemd/user`，通常为 `~/.config/systemd/user`。版本控制中的 runtime patch、构建产物以及普通源码开发依赖仍在源码目录，本次不是搬迁源码树。

## 兼容与显式覆盖

- 已存在 `~/.turnwire` 时，独立 daemon/CLI 继续使用它，不自动复制、重命名或删除数据。
- 已有源码目录内私有配置、状态或运行时的受管安装，保留原布局。启动已有匹配服务不会重写服务配置。
- 显式设置的 `TURNWIRE_HOME` 保留独立部署的旧语义；没有分类覆盖时，配置、数据、缓存仍沿用该布局。
- `TURNWIRE_CONFIG_HOME`、`TURNWIRE_DATA_HOME`、`TURNWIRE_CACHE_HOME` 可分别指定路径。新安装器把解析后的路径写入服务和 CLI 包装脚本，避免登录终端环境变化后客户端连接错主机。
- `TURNWIRE_DSH_HOME`、`TURNWIRE_DSH_ENV_FILE`、`TURNWIRE_DSH_ENTRY` 等已有显式覆盖继续有效。

不要无意中把新安装指向已有数据库。配置和状态包含密钥及敏感对话，备份需妥善保护；备份配置、Turnwire 状态和 DSH 状态/附件。缓存只有在没有活动进程依赖相关文件时才适合清理。

测试通过隔离目录验证新默认值、绝对/相对 XDG 输入、显式覆盖和旧布局识别。不搬迁当前开发安装，也不声称已在全新生产服务器完成实装验收。
