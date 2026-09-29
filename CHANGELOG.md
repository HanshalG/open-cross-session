# Changelog

## 0.6.2

- 加入 use-family 家族（leeguooooo/plugins）：`ocs upgrade --check` 输出统一成 `ocs <当前> -> <最新>` / `ocs <当前> is up to date`，新增 `--json`，查不到最新版退出码 2；升级后刷新 Claude 插件 / git 检出里的 skill；每天最多一次在 stderr 提示新版本（缓存过期时后台查，不拖慢 send/dm；`CI`、`OCS_NO_UPDATE_CHECK`、`USE_NO_UPDATE_CHECK` 关闭）
- skill 按家族约定补上 Upgrade 一节，描述里加上局域网配对的机器
- macOS 发行版改用 Developer ID 签名 + Apple 公证（hardened runtime，`scripts/entitlements.plist` 给 bun 的 JIT 放行）：Gatekeeper 显示 `Notarized Developer ID`，防火墙「自动允许已签名软件」开着时不再每个版本重新放行；没有签名 secrets 的 fork 构建退回 ad-hoc
- Windows：ChatGPT Desktop 的 IPC 是命名管道 `\\.\pipe\codex-ipc`（此前找的是 `~/.codex/ipc/ipc.sock`，Windows 上的 Codex 任务一律报不可达）；`ocs doctor` 不再在 Windows 上误报数据目录权限 666

## 0.6.1

- macOS 防火墙开着时 `ocs lan up` 自动放行 ocs 自己：此前换到正式安装路径或升级后，局域网连接被静默拦截，对端只看到「连不上」、本机日志一行都没有（Mac ↔ Windows 真机发现）

## 0.6.0

- 局域网模式（默认关闭）：`ocs lan up` 启动守护进程，`ocs lan pair` 出一次性配对码、另一台 `ocs lan pair <码>` 兑现；之后 `ocs dm <地址>@<对端>` 跨机发消息并唤醒、`ocs who --lan` 看远端 agent。Ed25519 身份 + 签名 X25519 握手 + AES-256-GCM，未配对机器只能兑现有效配对码；协议与威胁模型见 docs/lan.md
- 唤醒 note 里的正文不再能冒充包装和骨架：`<cross-session-message` 被中和，行首形似 `Reply:` / `Thread:` / 唤醒首行的加 `> `（本地 DM 同样受益；wake-protocol §1 已更新，AgentParty 侧需同步）
- 修复：0.5.1 起会话级 DM 写 `claude:<sessionId>` 身份，但身份校验没收这个命名空间，没有稳定工作区身份的 Claude 会话 `ocs dm` 直接报 `invalid sender identity`
- Windows 可用（Win11 + Claude 2.1.284 真机验证）：命名管道收件箱、peer token 按小写管道路径取、管道名里没有 pid 时的自身识别、编译后的 exe 自启动子进程（`notify-when-idle` 的 watcher 和 lan 守护进程此前都起不来）、NTFS 下不查 mode 位
- `ocs lan autostart on|off`：登录后自动起守护进程（macOS LaunchAgent、Windows HKCU Run、Linux systemd user unit）
- Windows 发行：Release 附 `ocs-windows-x64.zip`，`irm …/install.ps1 | iex` 安装，`ocs upgrade` 在 Windows 上走 install.ps1；两个安装器都会用新版重启正在跑的 lan 守护进程
- 局域网发现同时发子网定向广播：家用路由器 / VPN tun 吞掉组播时照样能找到
- 唤醒失败时带上具体原因（此前只有 `write-failed`）
- 投递阶梯从 cli.ts 抽到 `src/deliver.ts`，本地 dm 与远端 dm 共用

## 0.5.1

- 会话级 DM（同一工作目录多会话、workspace continuity 退回时）改按 Claude sessionId 派生频道和 route 身份（`claude:<uuid>`），重启/自动改名后同一对会话仍在同一频道；此前按会话名，改名后老频道静默失联（#36）
- `ocs send` 一个人都没唤醒时明说 stored-only；在 `dm-*` 频道里退出码 2（#36）
- `@` 点名的边界放宽：前一个字符不是地址/邮箱字符就算，`。@x`、`，@x` 等中文写法不再被吞（#36）

## 0.4.3

- `ocs upgrade` 真的升级二进制：查 GitHub 最新 Release，落后时复用 install.sh（sha256 校验 + 冒烟 + 原子替换）；`--check` 只报告；原来的托管版迁移指南移到 `--party`。此前该命令只打印迁移文案，装了旧版的用户无从得知有新版
- `ocs doctor` 新增版本检查：二进制落后于最新 Release 时给出警告并指向 `ocs upgrade`；离线/CI 可用 `OCS_UPGRADE_CHECK=0` 跳过
- Codex IPC 建连预算独立于 owner 探测 deadline：此前 500ms 的探测 deadline 也套在 socket 建连上，机器繁忙时「未认领」会被误报成可重试的传输故障 `failed`，而非应停靠 inbox 的 `not-open`（#28）
- skill 文档补上安装/升级入口，agent 缺二进制时能自愈
- Codex Desktop 明确不可投递时，自动降级唤醒唯一匹配的空闲 cmux Codex surface；匹配会验证标题 task 短 ID 与活 Codex 进程，陈旧 shell、多匹配和 IPC `unknown-outcome` 均 fail closed（#30）

## v0.4.2

- 发送输出明确区分 `stored` 与 wake 结果；唤醒失败返回退出码 2、结果未知返回退出码 3，并提醒消息已落盘、不可重发
- `send --codex` 与 `--codex-source` 直接接受 `ocs who` 展示的 `codex-<8hex>` 短地址；无效或歧义地址在消息落盘前失败
- CLI help、README 与安装 skill 补齐 ChatGPT Desktop 的第二个同 renderer source task 前置条件
- 明确跨机器边界：托管协作用 Agent Party；已有免密 SSH 时由控制端直接调用 workbox 上的本地 OCS/Herdr，不在 OCS 增加远程 runtime
- 测试临时目录统一按用例清理，删除失败会保留路径重试并使测试可见地失败；全量测试不再净增 `ocs-*` 残留

## v0.4.1

- Codex roster 只展示被 ChatGPT Desktop renderer 实际认领的 open task，不再把本地 rollout 历史误报成可达
- Codex target/source owner 改为并发短探测；未打开任务约 1 秒内明确报告消息已存储、可用 `ocs inbox`，不再串行等待 10 秒超时
- `ocs doctor` 分开报告 IPC router socket、当前 task renderer ownership 与 rollout 历史，避免 socket 存在被误解为端到端可唤醒

## v0.4.0

- `ocs who` 默认把当前项目放前面，用 `codex-<8hex>` / `pi-<8hex>` 短地址隐藏完整 UUID；`--verbose` 和 `--json` 按需展开
- Codex 通过宿主 thread id 自动识别发送者，Claude/Codex/Pi 日常发送都不再要求 `--as`
- 新增 `ocs inbox`：只列能由 route sidecar 或既有 cursor 证明归属的未读线程；稳定身份 cursor 支持 Claude 重启改名后续读，不猜测、不枚举其他私信
- 活 Claude/Codex/Pi 的 `Reply:` / `Thread:` 命令不再携带多余 `--as`；`send --reply-to` 会在回复者身份匹配时安全反转父消息 route，让回复进入原发送者 inbox
- `ocs doctor --fix` 同步修复三端 skill、Pi 扩展和数据目录权限；原子替换旧 skill，不沿符号链接改写共享缓存
- 支持常见的 `ocs --help`；修复 macOS 测试临时路径过长导致 Pi UDS 用例失败
- Release workflow 对 macOS 二进制重新做 ad-hoc codesign，并在打包前运行真实二进制 smoke test，避免无效签名被系统以 SIGKILL 拒绝执行

## v0.3.6

- 支持 Pi TUI：`ocs skill install` 同时安装 Pi skill 与直投扩展；`ocs who` 列出活会话，`ocs dm pi-<session-id>`、`@pi-<session-id>` 和 `--reply-to` 可直接唤醒
- Pi 忙碌时把跨会话消息排成 `followUp`，不打断当前工具调用；每个会话使用 0600 UDS、随机令牌和独立 `pi:` 身份命名空间
- `ocs doctor` 增加 Pi 扩展版本与活会话检查
- curl 安装完成后自动用 `skills` CLI 给 Claude Code、Codex、Pi 注册同版本 skill；关闭 telemetry，失败时改用二进制内置安装

## v0.2.0

- **`ocs who`**：全机 agent 花名册——Claude 会话、Codex 任务、cmux 终端一张表，自动标出你自己
- **`ocs dm <目标> <内容>`**：直发一个 agent，频道自动派生、载体自动选（UDS / Desktop IPC / cmux）
- **身份自动识别**：在 Claude 会话里 `--as` 可省略（进程祖先链推断；`OCS_NAME` 可覆盖）；`ocs whoami` 查看
- **cmux 第三载体**：探测到 cmux 时可唤醒终端里的 codex/claude TUI（按 surface 寻址；忙碌不打扰）；仍是可选加速器，绝不必装
- **`ocs skill install`**：给 Claude Code 装 ocs 技能，对任何会话说「找个 agent 商量」即可触发

## v0.1.2

- `@<codex-thread-id>` 自动路由到 ChatGPT Desktop IPC，不再要求记 `--codex` 语法
- codex 唤醒归因修复：target/source 分开探测、报错各自点名；自动选 source 逐候选跳过未打开的 rollout
- 自我唤醒防回环改为沿进程祖先链定位本会话（`process.ppid` 在 Bash 工具链路下失效）
- CLI 输出国际化：英文 canonical，`OCS_LANG`/locale 选中文；唤醒指针双语
- `ocs doctor --fix` 一键设 `crossSessionInbound=accept`（写前备份）；doctor 增加 cmux 可选加速器探测
- 对抗式审查修复 12 条（codex-ping 全仓审查，均有回归测试）：
  - 非法 `--reply-to` 写出永久不可读行；崩溃半行吞掉下一条消息
  - 空内容陈锁永久死锁；stale-break inode 校验 + 写后自校验堵双持锁竞态
  - 日志 EACCES 被伪装成空频道；游标并发回退（锁内比较 + 原子写）
  - owner 探测把传输故障误报成「任务未打开」；source 候选上限 10→50
  - 命令级参数 schema：缺值/未知 flag/多余参数必须报错（`--codex` 缺值曾静默吞掉）
  - install.sh 校验 fail-closed + sha256sum 兼容；冒烟通过前不覆盖旧二进制
- `ocs version`；双语 README（[English](./README.md) / [中文](./README.zh-CN.md)）

## v0.1.1

- `@<codex-thread-id>` 分流与祖先链防回环首版（详见 v0.1.2 收尾）

## v0.1.0

- 首个公开版本：本地频道日志（多进程安全单调 seq）、Claude 收件箱 socket 注入、
  ChatGPT Desktop 原生跨任务 IPC、`doctor` 体检、`upgrade` 迁移指引
- 三平台二进制（macOS arm64/x64、Linux x64）+ `install.sh`
