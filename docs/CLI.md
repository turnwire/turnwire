# 命令行参考

开发时用 `npm run turnwire -- ...`；构建后可直接 `node apps/cli/dist/main.js ...`，或把相应 workspace 的 `turnwire` / `turnwire-host` 可执行文件加入自己的 PATH。

| 命令 | 用途 |
| --- | --- |
| `turnwire status` | 查看设备和 runtime 状态 |
| `turnwire ls --search 关键词` / `--archived` / `--all` | 搜索会话与工作目录，查看归档 |
| `turnwire rename SESSION_ID 标题` | 重命名共享会话 |
| `turnwire archive SESSION_ID` / `turnwire unarchive SESSION_ID` | 归档与取消归档，保留历史 |
| `turnwire history SESSION_ID` | 查看消息和完整工具输入、输出 |
| `turnwire export SESSION_ID --output 会话.md` | 导出 Markdown 记录 |
| `turnwire new [prompt] --cwd /absolute/path --title 标题` | 创建会话，默认 DSH |
| `turnwire models` | 列出当前 runtime 注册的模型、默认模型与可选思考强度 |
| `turnwire model SESSION_ID provider/model [--effort EFFORT]` | 选择会话运行的模型与思考强度；只接受 runtime 目录里的模型 |
| `turnwire attach SESSION_ID` | 读取历史并跟随实时输出；TTY 下可继续输入 |
| `turnwire send SESSION_ID '消息'` | 发送后续消息 |
| `turnwire send SESSION_ID '消息' --steer` | 插话引导正在运行的回合；默认是排队等它结束 |
| `turnwire resume SESSION_ID` | 恢复中断的会话 |
| `turnwire stop SESSION_ID` | 取消当前 Agent turn |
| `turnwire approvals` | 列出待审批操作 |
| `turnwire approve APPROVAL_ID` / `turnwire reject APPROVAL_ID` | 一次性审批 |
| `turnwire inbox` / `turnwire inbox --all` | 待审批收件箱；`--all` 含已处理和已过期记录 |
| `turnwire result REQUEST_ID` | 查询结果不确定的请求最终是否已提交 |
| `turnwire notifications status` / `on` / `off` | 查看或切换主机的 Web Push 投递 |
| `turnwire devices pair --name 我的手机` | 生成远程设备配对码 |
| `turnwire devices list` / `turnwire devices revoke DEVICE_ID` | 查看或撤销设备 |
| `turnwire devices upgrade DEVICE_ID --qr` | 用一次性 v2 登记二维码替换已有配对 |
| `turnwire connect` | 查看本机连接信息 |
| `turnwire connection` | 检测与 Mac 的实际往返连接，远程配对同样可用 |
| `turnwire devices list --watch` | 查看已配对设备是否已确认连通、最近确认时间和延迟 |
| `turnwire tui` | 进入复用 CLI 命令的交互终端 |
| `turnwire remote` | 交互式远程设置，包括模式选择、配对和撤销 |
| `turnwire remote status --watch` | 持续查看连接进度，Ctrl+C 退出查看 |
| `turnwire deploy` / `turnwire deploy --config 私有配置.json` | 表单或一条命令部署 / 更新 Relay，自动配置 HTTPS 和常驻服务 |
| `turnwire deploy --status` | 查看所有本机客户端共享的部署进度 |
| `turnwire devices pair --qr` | 在终端显示手机配对二维码 |
| `turnwire devices pair --qr-file phone.png` | 保存权限为 0600 的 PNG 二维码，不覆盖现有文件 |

`--json` 输出结构化数据，`--url` / `--token` 覆盖本地连接，`--pairing FILE` 使用文件中的远程配对码。`attach` 的 Ctrl+C 只断开客户端；`stop` 才会停止 Agent。客户端退出不会关闭 daemon 或 DSH。

## 发送消息的两种方式

会话运行中再发一条消息，主机给你两种语义：

- **排队（默认）**：等当前回合结束后作为下一条指令执行，不打断 Agent。消息会标上「排队发送」。
- **插话**：直接进入正在运行的回合，用来中途纠正方向。消息会标上「插话」。

只有 `turnwire stop` 会取消回合；它不注入文本。模型选择同理，永远以 runtime 的模型目录为准（见 [多端功能对等](CLIENTS.md)）。
