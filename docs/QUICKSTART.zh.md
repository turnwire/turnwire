[English](QUICKSTART.md) · 中文

# Linux 主机一命令启动

## 第一次运行

使用有正常 systemd 用户服务的 Linux 普通专用账号，取得仓库并进入目录：

```bash
git clone https://github.com/turnwire/turnwire.git
cd turnwire
bash scripts/start-host.sh
```

已经安装 Node/npm 时，也可以运行 `npm start`，两者是同一入口。Bash 入口可以自行准备固定版本 Node。首次下载/构建耗时取决于网络和 CPU；「一命令」不代表无需前置条件或瞬间安装。

脚本检查环境、准备 Node 与依赖、构建 PWA/主机、隐藏输入模型密钥，并调用已有 Linux 安装器注册常驻服务。默认受管主机需要 `TURNWIRE_HARNESS_DEEPSEEK_API_KEY`，不因此新增或注册模型。已有私有 `config/dsh.env.json` 会保留。不要把密钥放进命令行参数、公开部署文件或截图。

需要 Bash、正常工作的 systemd 用户服务及下载/解压 Node 所需工具，不以 root 运行。安装路径使用不含空格的简单路径，与既有服务安装器限制一致。该入口仅支持 Linux；Mac 使用原生/源码安装说明，不会假装安装 Linux 服务。

## 后续启动

同一时间只运行一个启动脚本，首次构建未做并发串行化。上次运行结束后，再次执行同一命令：匹配的服务已运行时保持不动；匹配的已安装服务停止时直接启动，不重新构建。若服务属于其他安装目录，拒绝覆盖或重启。这个入口不是升级命令；替换版本应先等当前任务结束，再执行受控更新。

```bash
bash scripts/start-host.sh --check
systemctl --user status turnwire-host
journalctl --user -u turnwire-host -n 100
```

`--check` 只检查，不安装、不启动。服务开始运行不等于 DSH/模型已健康，应继续执行脚本提示的状态与连接检查。无人登录也需开机运行时，可能要管理员批准：`sudo loginctl enable-linger "$USER"`。

## 手机访问仍由用户明确选择

启动后：

```bash
bin/turnwire remote
bin/turnwire devices pair --name phone --qr
```

在远程表单里连接已有固定 Relay，或选择临时通道。稳定公网入口仍需要可达的服务器/域名和凭据；启动脚本不会擅自购买 VPS、配置 DNS、开放防火墙或部署公网服务。详见[Relay 部署](RELAY-INSTALL.zh.md)。

daemon 和 DSH 保持回环监听，不默认启用代审批。主机需要常醒，保护私有凭据，同时备份 Turnwire 状态和 DSH 状态/附件。

## 验证边界

启动脚本测试在隔离目录中替换系统命令和安装器，验证流程、重复启动、服务冲突及密钥处理，不重启当前开发主机。这不等于已完成全新虚拟机/真实网络/systemd 的端到端生产部署认证。
