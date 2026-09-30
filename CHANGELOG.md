# Changelog

## 0.7.1

**Windows: ocs now checks who is serving ChatGPT Desktop's Codex pipe before sending anything (#37).** 0.6.2–0.7.0 trusted `\\.\pipe\codex-ipc` because a pipe with that name existed. Any local process that created the name first received the wake prompts and thread ids and could answer as the task owner. macOS and Linux were not affected (the socket's owner and mode were already checked).

- 在即将发帧的那条连接上核对管道服务端：管道属主 SID 是当前用户；服务端进程以当前用户运行；该进程带 ChatGPT Desktop 的包身份（`OpenAI.Codex_2p2nqsd0c76g0`）且映像在包安装目录内。不满足 → 不发任何字节，按 Desktop IPC 不可用处理（消息留在收件箱，退出码 2），原因写进 `wake(codex): stored-only (unavailable): …`
- `ocs doctor` 在 Windows 上报告管道是否通过身份校验，通过时列出服务端 pid 和映像路径，不通过时写明原因
- `OCS_CODEX_IPC_PIPE` 指向的管道走同一套校验；只接受 `\\.\pipe\…` 形式的本机管道名
- 会被拒的正常情形：不是 Store 包安装的 ChatGPT Desktop、以管理员身份运行的 ChatGPT Desktop
- start-turn 帧写到一半失败按结果未知处理（退出码 3，不重发）
- 真机验证（Windows 11，OpenAI.Codex 26.924）：真 Desktop 通过；同一用户、另一用户各起一个抢注管道，均被拒且抢注方收到 0 字节（0.6.5 对同一个抢注管道发出了 194 字节的握手帧）

## 0.7.0

**Claude wakes now say whether the message was held.** `ocs dm` / `ocs send` to a Claude Code session used to print `delivered to inbox` even when the receiver's `crossSessionInbound` gate (default `hold`) parked the message and dropped it 5 minutes later. ocs now subscribes to Claude Code's native delivery receipts and reports what happened. macOS and Linux; Windows behaves as before.

- 发给 Claude 会话的唤醒带上回执地址，接收端把归宿写回来（docs/wake-protocol.md §6）：没有扣留/拒绝回执 → `wake: accepted by inbox`（退出码 0，不是已读回执）；被闸门扣下 → `wake: HELD, not delivered yet`（退出码 2）；`refused` / `dropped` / `denied` / `expired` → `wake: NOT delivered`（退出码 2）。消息都已落盘，别重发
- 被扣下的消息最终没送达（过期、被拒、到点没有终态）时，发送方会话收到一条 `[ocs delivery notice]`，写明 seq、对象、原因和接收端该怎么改（`ocs doctor --fix`；仓库级设置仍可强制 hold）。只发一次；后来被批准了就不打扰
- 回执写进频道日志（`type:"receipt"` 旁车帧，旧版本跳过这一行照常读消息）；`ocs read` 在自己发的消息下显示 `[wake → <目标>: <状态>]`，`--json` 多一个 `delivery` 数组
- 局域网：接收端守护进程走同一条唤醒，`ocs dm x@peer` 也会报 accepted / HELD / NOT delivered（线上格式不变）；被扣消息的终态只记在接收端，不跨机通知
- 每次 Claude 唤醒由一个脱离终端的 helper 完成（内部命令 `_claude-wake`）：接收端只把回执发给写帧的那个进程。它在 Claude 的 socket 目录里建一个 0600 的临时 socket，退出前删除；被扣的消息最多等 6 分钟
- `OCS_NO_RECEIPTS=1` 关掉回执，回到 0.6 的行为和措辞；回执建不起来时自动回落
- 唤醒 note 的正文伪造不了 `[ocs delivery notice]` / `[ocs 投递通知]` 行（同 0.6.0 的中和规则）

## 0.6.6

- `ocs inbox` 新增 `--session <claude-session-id>`：与 `ocs whoami --json --session` 同一语义，不靠进程祖先链推断，直接按指定 Claude 会话解析身份（会话身份、稳定工作区身份、ocs 名字），`--json` 仍输出原来的数组。给状态栏这类不在 Claude 进程树里的调用方显示本会话未读数用；会话不存在或与 `--as` 同用时报错退出 1
- README 新增常见问题（中英），按大家实际搜索的问法回答：Claude Code 与 Codex 互通、两个 Claude 会话对话、跨电脑、Windows、与 subagent/MCP 的区别

## 0.6.5

- 让局域网能力看得见：README（中英）开头改成「同一台机器上 + 局域网里的几台电脑之间」，新增「0.6 新增」一节和两台机器上手示例；`ocs help`、`ocs upgrade` 的提示、skill 标题不再只说「本机」，跨网络/跨组织才指向托管版
- `ocs doctor` 新增「局域网（其他电脑）」一节：没开时给入口，开着时报已配对电脑数和登录自启
- GitHub Release 说明取自 CHANGELOG 对应一节并附安装命令（此前所有 release 页面都是空的）；CHANGELOG 缺这一节时发版直接失败

## 0.6.4

- 局域网：远端 `who --lan` 和远端 DM 判断 Codex 任务可达时，也认「被 ChatGPT Desktop 认领」（和本机 `ocs who` 同一判据）。此前只认 lsof 找到的活进程，Windows 上开着的 Desktop 任务对远端整个隐身、DM 被拒 not-found

## 0.6.3

- Windows：`ocs doctor` 把 `codex queue` 标成「Windows 上不走」而不是警告（没有 lsof 证明任务活着，Desktop 任务走 IPC）；`ocs upgrade` 打印实际运行的 `install.ps1` 命令
- 真机确认：Windows 上 `ocs who` 能列出 ChatGPT Desktop 认领的 Codex 任务（`\\.\pipe\codex-ipc`）

## 0.6.2

- 加入 use-family 家族（leeguooooo/plugins）：`ocs upgrade --check` 输出统一成 `ocs <当前> -> <最新>` / `ocs <当前> is up to date`，新增 `--json`，查不到最新版退出码 2；升级后刷新 Claude 插件 / git 检出里的 skill；每天最多一次在 stderr 提示新版本（缓存过期时后台查，不拖慢 send/dm；`CI`、`OCS_NO_UPDATE_CHECK`、`USE_NO_UPDATE_CHECK` 关闭）
- skill 按家族约定补上 Upgrade 一节，描述里加上局域网配对的机器
- macOS 发行版改用 Developer ID 签名 + Apple 公证（hardened runtime，`scripts/entitlements.plist` 给 bun 的 JIT 放行）：Gatekeeper 显示 `Notarized Developer ID`，防火墙「自动允许已签名软件」开着时不再每个版本重新放行；没有签名 secrets 的 fork 构建退回 ad-hoc
- Windows：ChatGPT Desktop 的 IPC 是命名管道 `\\.\pipe\codex-ipc`（此前找的是 `~/.codex/ipc/ipc.sock`，Windows 上的 Codex 任务一律报不可达）；`ocs doctor` 不再在 Windows 上误报数据目录权限 666

## 0.6.1

- macOS 防火墙开着时 `ocs lan up` 自动放行 ocs 自己：此前换到正式安装路径或升级后，局域网连接被静默拦截，对端只看到「连不上」、本机日志一行都没有（Mac ↔ Windows 真机发现）

## 0.6.0

**Agents across your LAN.** Pair two computers once (`ocs lan up`, `ocs lan pair`), then `ocs dm <address>@<peer>` wakes a Claude Code, Codex or Pi session on the other machine; `ocs who --lan` lists them. Mutually authenticated and encrypted, off by default. Windows supported. See docs/lan.md.


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
