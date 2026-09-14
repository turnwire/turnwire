[English](XDG.md) · 中文

# XDG 目录

所有安装按照 XDG 基础目录规范，把外部应用文件与源码目录分离。XDG 环境变量必须是绝对路径；空值或相对路径使用标准 HOME 默认值。不识别旧布局，也不迁移。

| 用途 | 默认位置 | 显式覆盖 |
| --- | --- | --- |
| 私有配置、本机客户端连接描述 | `$XDG_CONFIG_HOME/turnwire`，未设置时 `~/.config/turnwire` | `TURNWIRE_CONFIG_HOME` |
| 会话数据库、主机状态、DSH 状态与附件 | `$XDG_STATE_HOME/turnwire`，未设置时 `~/.local/state/turnwire` | `TURNWIRE_STATE_HOME` |
| 安装的 Node/DSH 运行时依赖 | `$XDG_DATA_HOME/turnwire/runtime`，未设置时 `~/.local/share/turnwire/runtime` | `TURNWIRE_DATA_HOME`（runtime 是其子目录） |
| 下载暂存、可重新下载的工具 | `$XDG_CACHE_HOME/turnwire`，未设置时 `~/.cache/turnwire` | `TURNWIRE_CACHE_HOME` |

DSH 环境文件默认是 `配置目录/dsh.env.json`，DSH 状态是 `状态目录/dsh`。Linux 用户服务位于 `$XDG_CONFIG_HOME/systemd/user`，通常为 `~/.config/systemd/user`。版本控制中的 runtime patch、构建产物以及普通源码开发依赖仍在源码目录。

## 显式配置与不兼容安装

- 每项覆盖只控制对应目录类别；状态覆盖不改变配置、数据或缓存位置。安装器把解析后的路径写入服务和 CLI 包装脚本。daemon 与客户端应使用相同的配置路径。
- 已删除的统一 home 变量和旧 home/源码目录布局不参与解析。旧文件不会被复制、重命名、删除或自动接管。
- `TURNWIRE_DSH_HOME`、`TURNWIRE_DSH_ENV_FILE`、`TURNWIRE_DSH_ENTRY` 是显式 DSH 覆盖，不是旧布局探测。
- Store 只接受当前数据库 schema 或创建全新数据库；拒绝旧版/不兼容数据库，不进行迁移。不要把旧库复制进新的 XDG 目录来绕过拒绝。

配置和状态备份包含凭据及敏感对话，必须妥善保护。相关进程停止后，或使用受支持的 SQLite 在线备份，一致地备份配置、Turnwire 状态和 DSH 状态/附件。缓存只有在没有活动进程依赖时才适合清理。备份不代表本版可以恢复旧数据库。

维护和拒绝处理见[维护与不兼容状态拒绝指南](FIRST-UPGRADE.zh.md)。目录测试使用隔离文件系统夹具，不搬迁运行中的安装，也不等于生产实装验收。
