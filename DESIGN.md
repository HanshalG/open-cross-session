# Open Cross-session — 设计文档

状态：草案 v0.1（2026-09-01）

## 一、定位

**跨 agent（Claude Code ↔ Codex ↔ Pi）、跨 session 的本地协作层，零服务器；v0.6 起延伸到局域网内配对的电脑。**
多方频道语义（N 个 agent + 人同频道），真唤醒（不是文件轮询），
与托管版 Agent Party 共享协议——单机玩顺后一条命令升级到跨机器/跨组织。

## 二、竞争格局（2026-09-01 实查）

### 直接同赛道

| 项目 | star | 机制 | 弱点 |
|---|---|---|---|
| [agent-bridge](https://github.com/raysonmeng/agent-bridge) | 316 | MCP bridge + daemon 代理 codex app-server，本地 WS，push 唤醒 | **1:1 管道**，无频道/多方语义，默认 `--dangerously-skip-permissions`，无托管路径 |
| [codex-claude-bridge](https://github.com/abhishekgahlot2/codex-claude-bridge) | 54 | 基于 Claude Code Channels（需开发通道 flag） | 依赖 preview flag，小众 |
| bohdanpodvirnyi/agent-session-bridge | 103 | — | 2026-04 起停更 |

「第一个做」的窗口已关（agent-bridge 占了），但最强者才 316 star，
**「做得完整」的窗口开着**，细分赛道认知度还很低。

### 平台层（最大风险）

- **Anthropic 官方**：Agent Teams + 跨 session messaging（ListAgents/SendMessage，
  本机+跨机）+ Claude Code Channels。**claude↔claude 官方已内置**，
  这半边随时被吃干净——但官方永远不会替用户管 Codex。
- **OpenAI 官方**：Codex app 已支持多 task 并行 + task 间 @ 提及，
  即 codex↔codex 官方已成型（这正是我们 #1012 接入的 IPC）。官方没做跨厂商。

→ 结论：**卖点必须压在「跨厂商 + 频道 + 托管引流」上**，
不能建在任一官方下个版本就能覆盖的功能上。

### 邻近赛道（不同物种）

- **multica**（48.4k star，周更）：Go server + daemon 的单组织 Managed Agents 平台，重部署。
- **Gas Town**（17.9k）：tmux + beads 工单队列驱动 20-30 个 agent，Claude 为主，工单语义非对话唤醒。
- **claude-squad**（8.4k）：tmux + worktree 并行管理器，agent 间不互通。
- **conductor.build**：闭源 Mac app，人管多 agent，agent 不互通。
- **happy**（23.6k）：人远程遥控自己会话的加密 relay，非 agent↔agent。
- **vibe-kanban**（28k）：4 个月停更。terragon：2026-01 已关停——
  纯远程包壳赛道在死，**「本地优先 + 可选托管」是被验证的活路**。
- **A2A 协议**（v1.0，Linux Foundation）：Claude Code / Codex 均无原生实现，暂无实质威胁；
  谁先原生 A2A 谁占互操作叙事，留意。

### 差异化窗口（无人在做）

1. **多方频道**：N agent + 人同频道；本地竞品全是 1:1 或 hub-spoke。
2. **Codex 原生跨任务通信**：#1012 直接进官方 ChatGPT task 流（IPC + linked reply），
   无竞品做到——README 头牌卖点。
3. **托管升级通道**：同一协议从本机零服务器平滑升到跨机跨组织，独此一家。
4. **权限与身份做正**：对比 agent-bridge 的权限裸奔，安全叙事差异点。
5. **多载体真唤醒**：Claude socket、Codex 原生 IPC、Pi 扩展 socket，比文件轮询或终端按键注入可靠。

## 三、可抽取组件地图（来自 agentparty 主仓盘点）

> 完整盘点（带 file:line 引用与三档标注）见
> [docs/agentparty-extraction-map.md](./docs/agentparty-extraction-map.md)。以下是结论。

**主仓已存在两条纯本地零网络传输**，本地版另外实现 Pi 扩展传输：

1. **Claude 侧**：`claude-inbox-inject.ts` — cc-socks Unix socket
   （`/tmp/cc-socks/<pid>.sock`）按 PID 寻址注入活会话，JSONL 帧，
   载荷按 docs/wake-protocol.md：正文 ≤4096B 逐字内联（超过带前 512B），Reply:/Thread: 命令填好。
2. **Codex 侧（按宿主选载体）**：Desktop 托管的 task 先走 Desktop IPC，其它宿主
   （终端 TUI）走 `codex queue`。2026-09-07 实测两条路都能送达并触发新 turn，但
   rollout 记录形态不同：IPC 留下 `send_message_to_thread` + `<codex_delegation>
   <source_thread_id>` 原生来源信封，queue 留下的是普通 `UserMessage`——会把别的
   agent 发来的消息呈现成「用户自己敲的」。跨会话内容必须看得出是数据而不是用户
   指令（Claude 侧用原生 "Message from X" 包装是同一个理由），所以 Desktop 上不拿
   来源换便利；IPC 投不进时 queue 仍是最后一级兜底。

2a. **`codex-queue.ts`** — 官方 CLI 表面 `codex queue --thread <id>
   --message <text>`。按 thread UUID 精确寻址（thread id 就是 rollout 文件名里的 UUID），
   **终端里裸跑的 codex TUI 和 Desktop 任务通吃**，不需要 cmux，也不需要目标被 Desktop
   renderer 认领，更不需要 `codex app-server daemon start`（那条另外要求官方 standalone 安装）。
   2026-09-07 实测 v0.153.4：往 tmux 里一个纯终端 TUI queue 一条唤醒载荷，TUI 真的跑了那一轮
   并用 `ocs send` 回了话。
   **活性必须自己判**：`queue` 是往 thread store 写待处理输入，不是投递——目标已退出时它
   照样 exit=0 并打印 "Queued message …"。判据取 rollout 文件的 fd 持有者（`lsof`，只认
   REG 类型的这条文件本身），查不到就不发（fail closed），欠账留给 inbox。
   **持有 rollout 只是必要条件**：索引/监控 `~/.codex/sessions` 的第三方进程一样会打开这些
   文件（issue #35 里的 `codex-issue-runner`），不校验身份会把几个月前退出的会话全标成可达。
   持有者还要么自己（或祖先）是 `codex` 二进制（basename 精确匹配，不用子串），要么挂在
   ChatGPT.app 进程树下（Desktop 托管）——对应铁律 10 的两种载体。
2b. **`codex-desktop-ipc.ts`**（#1012）— ChatGPT Desktop 自己的
   `~/.codex/ipc/ipc.sock`，用 `thread-follower-start-turn` + `codex_app`
   toolOutput 注入原生跨任务消息，UI 里保留原生来源链接。私有协议，宿主升级可能破，
   所以 Desktop 之外的目标一律不用它；它失败后依次是 cmux 按键注入、queue 兜底。
   **Windows（v0.7.1，issue #37）**：Desktop 的 IPC 是全局命名空间里的固定管道名
   `\\.\pipe\codex-ipc`，谁先建谁就是服务端（管道抢注），名字存在不证明任何事。Unix 上
   查 socket 的 uid 和 0600，Windows 上对应的检查做在**随后发帧的那个句柄上**
   （`src/codex-ipc-win.ts`，bun:ffi 调 kernel32 / advapi32，不要管理员权限）：
   - 管道对象的属主 SID == 本进程用户 SID（`GetKernelObjectSecurity`）。这是 uid 检查的
     对应物，也是挡别的账号的那一道：非管理员没法把属主设成别人，而且它不依赖 pid。
   - 管道服务端进程（`GetNamedPipeServerProcessId`）以同一用户 SID 运行。
   - 该进程带 ChatGPT Desktop 的包身份 `OpenAI.Codex_2p2nqsd0c76g0`（`GetPackageFamilyName`，
     内核从进程令牌读），且映像在该包的安装目录里（`…\WindowsApps\OpenAI.Codex_<版本>…\`，
     只有 TrustedInstaller 可写）。两条都要：Desktop 底下 agent 跑的命令会继承包身份，但映像
     在包目录外。不查 Authenticode：Store 包按包签名而不是按 exe，WinVerifyTrust 也慢。
   任何一条不过 → 关句柄、报 unavailable（走降级，消息留 inbox），**一个字节都不写**。
   为什么必须逐连接查：真机上 Desktop 的管道是默认 DACL（SYSTEM / Administrators / 属主
   全权，Everyone 只读），别的非管理员账号加不了实例也写不进去，但同一用户的进程可以在
   真服务端旁边再加实例——`FILE_FLAG_FIRST_PIPE_INSTANCE` 只保护创建那一刻。所以「探测
   过关再用 net.connect 另连一次」不成立；Bun/Node 的 net.Socket 又不给句柄，于是 Windows
   上整条传输都跑在校验过的句柄上（`PeekNamedPipe` 轮询，2ms 起、空闲退到 50ms；句柄设成
   `PIPE_NOWAIT`，写不进去的字节排队，服务端不读也不会把事件循环卡死在 `WriteFile` 里）。句柄用
   `SECURITY_IDENTIFICATION` 打开（流氓服务端不能冒充我们），只接受 `\\.\pipe\…`
   （`\\host\pipe\…` 会把凭据送上 SMB）。`OCS_CODEX_IPC_PIPE` 只换名字不换规则。
   `codexDesktopIpcAvailable` 是一次「开、查、关」的探测，不发帧；不缓存任何服务端身份。
   **挡不住的**：已经以同一用户运行的恶意进程（它可以直接注入 Desktop），以及理论上的
   pid 复用（第 2、3 条依赖 pid，第 1 条不依赖）。**已知会误拒**：非 Store 安装的
   Desktop（没有包身份）、以管理员身份运行的 Desktop（属主变成 Administrators）——都按
   fail closed 处理，`ocs doctor` 会写出拒绝原因。
3. **补充**：Codex Stop hook 的 `{"decision":"block","reason":…}` —
   `reason` 即注入 prompt（≤512B），机制全本地，只有「有没有新消息」一问走服务端。
4. **Pi 侧**：全局扩展在 `session_start` 登记会话并监听 0600 Unix socket；收到 note 后用
   `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` 注入，`session_shutdown` 关闭并清理。

**可几乎原样复用**（零服务端依赖）：两个 session registry、
`serve-wake-proxy` 全套、`codex-sessions` / `codex-session-kind` /
`codex-stop-wake`（决策纯函数）、`codex-turn-arbiter`（transport 本来就是注入的）、
hook 信任闸修复器、`runtime-topology`（本地 locality 判定的隐藏宝石，只需换盐）、
`join-binding` / `instance-lock` / cursor+stuck / `continuation` /
`atomic-json` / `mention-wake-claim`、`MsgFrame` 数据形状及其两条铁律
（只按 seq 定序绝不按 ts；`isMessageFrame` 校验必须逐字镜像字段表，#622）。

**只需重写两个收敛点**：`rest.ts`（全部 HTTP 汇聚于单个 fetch——保签名、
换成本地存储实现）和 `client.ts` 的 `connect()`（唯一 WS 收敛点——换成本地日志 tail）。
**25 个 MCP handler 一行不用改。**

**服务端绑死可直接删**：OIDC/token、lease epoch/token 的分布式 CAS 协议、
presence 心跳（本地读 registry 即可）、`worker_upgrade_required` 等纯服务端 blocker。

## 四、架构

```
┌─ Claude 会话 ─┐  ┌─ Codex task/TUI ─────┐  ┌─ Pi TUI ─────┐  ┌─ headless ─────┐
│ cc-socks UDS  │  │ Desktop:IPC 终端:queue│  │ extension UDS│  │ claude / codex │
│ 注入          │  │ 兜底 cmux / queue    │  │ followUp     │  │ resume         │
└──────┬────────┘  └────────┬─────────────┘  └─────┬────────┘  └──────┬─────────┘
       │                    │                      │                  │
       └────────────── 按目标 harness 选载体 ─────────────────────────┘
                         ▲
              本机 append-only 消息日志
        （SQLite/JSONL，per-channel 单调 seq）
              + UDS/文件 watch 新消息通知
```

- 投递 = 写日志 → 通知 → 选载体注入；正文永远由被唤醒方回日志重读（指针模式）。
- 身份：沿用「每身份一进程 MCP，绝不共享 daemon」硬约束（权限放大教训 #865/#862）；
  身份 key 从 `server+name` 换成本地 config path。
- 验收：直接抄 `verify-agentparty-claude-cross-session.ts` 的 21 条证据链，
  删掉 worker/runtime_peer 两类纯服务端 blocker。

**两个必须正面解决的坑**（都静默失败、不回错）：

1. Claude 跨会话收件箱默认 **hold**，5 分钟无人 Deliver 即丢弃——本地版要么改默认
   放行策略，要么设计带确认的回路，不能沿用「发了就不管」。两样都做了：`ocs doctor --fix`
   设 accept；v0.7.0 起订阅原生回执，被扣 / 被拒当场说出来（下面「投递回执」）。
2. Codex ≥0.149 的 **hook 信任闸**——`hooks.json` 里的 hook 未在 `config.toml`
   批准就静默跳过。修复器可复用；绝不用 `--dangerously-bypass-hook-trust`。

**风险**：Desktop IPC 依赖 ChatGPT.app 私有协议，宿主升级会破——需要版本探测 + 降级路径
（headless spawn 兜底）。自 `codex queue` 接入后这条风险降级：私有 IPC 不再是 codex 的
唯一入口，只是 `codex queue` 之后的第二顺位。

**载体审计结论（2026-09-07）**：另外两条腿**不是绕路**，各自都已经在官方表面上——
Claude 走的 cc-socks 收件箱就是 Claude Code 自己的跨会话消息通道（原生「Message from X」
UX + `crossSessionInbound` 权限闸），`claude` CLI 没有等价的发送子命令；Pi 走的是 Pi 官方
扩展 API，`pi` CLI 根本没有跨会话命令。两条已知的可改进项，都不需要换载体：
- Claude 侧的「ok ≠ 送达」靠订阅 `peer_message_status` 回执收敛——v0.7.0 已做，见下面「投递回执」。
- `claude agents --json` 能列出**后台会话**（`kind: "background"`），那是 ocs 今天完全没
  寻址的一类本机 agent；但 `claude` 也没给后台会话提供发送口，所以是发现有、投递无。

**投递回执（v0.7.0，2026-09-30；协议在 docs/wake-protocol.md §6）**：user 帧带 `from: uds:<sock>` +
`msg_id` 时，Claude Code 会把 held / delivered / expired / refused / dropped / denied 写回那个 socket；
accept 策略下一条都不回。几个取舍：

- **每次 Claude 唤醒一个脱离终端的 helper**（`ocs _claude-wake`，照抄 idle watcher 的模型）。接收端按
  写帧进程的 pid 回发，所以写帧和监听必须是同一个进程，而被扣的消息 5 分钟才有终态，CLI 不能陪着等。
  CLI 只读 helper 的第一行结果（≈0.5 秒），helper 留下等终态。
- **回执 socket 建在 Claude 的 socket 目录里**（接收端要求同目录）。这是「Claude 的目录只读」的唯一
  例外：一个 0600 临时文件，退出必删，SIGKILL 的残留按 `$OCS_HOME/wake-jobs/` 的登记清理。
- **没有回执只叫 accepted**，不叫 delivered：accept 策略不发回执，所以「没消息」只能读作「没报告被扣 /
  被拒」，不是已读。铁律 4 不变——记账仍以对方回话为准。
- **被扣的消息最终没送达才通知发送方**，一次，通知帧不带 `from`（不递归）。第一阶段就失败的 CLI
  已经当面报了；delivered 不打扰。
- **落盘走旁车帧**（`type:"receipt"`，铁律 9 的同一先例），写在消息之后；`ocs read` 在自己发的消息下显示。
- **帧只由 helper 写**：CLI 等不到结果就是 unknown（退出码 3），绝不自己补写一遍（铁律 5 的精神）。
  只有 helper 根本没派出去才在本进程走旧路径。
- **Windows 不做**：回执地址得是命名管道并带认证材料，行为与措辞保持 0.6。
- **局域网只回传第一阶段**：终态跨机通知要接收端守护进程主动连回发送方再发一条请求，
  新增一个「对端可以主动唤醒我」的 op，和「请求发出后没应答绝不重发」放在一起并不简单，先不做。

**已知限制（codex-ping 审查 #11）**：Desktop IPC 的 delegation envelope 需要一个
source thread id，自动选择时它只是**运输载体**（同 renderer 的任一开着任务），不代表
消息真实来源——UI 里的「来自任务 X」链接会指向载体任务。真实来源恒在指针正文里
（`New message from <sender> in #<channel>`）。归因敏感场景用 `--codex-source` 显式指定。

**唤醒载体分层原则（硬约束）**：核心功能零外部依赖（频道日志 + read/send 任何会话可用）；
每个唤醒载体（Claude socket、Desktop IPC、Pi extension socket、cmux surface…）都是**运行时探测、失败降级、
绝不必装**。cmux 只是探测到就用的可选加速器（2026-09-01 真机验证过 `send --surface`
可唤醒终端 TUI），任何代码不得把它写成硬依赖。

## 四½、局域网模式（v0.6.0，2026-09-29）

owner 要求「局域网内可发现的 ocs，安全也要考虑」。这推翻了此前 README 里「OCS 刻意不提供监听」
的立场，所以做成**默认关闭、配对才授权**：`ocs lan up` 起一个脱离终端的守护进程，`ocs lan pair`
用一次性配对码互信，之后 `ocs dm <地址>@<对端>`。协议、威胁模型、文件布局全在
[docs/lan.md](./docs/lan.md)。几个取舍：

- **自研握手而不是 TLS**：node:crypto 生成不了 X.509，依赖外部 openssl 违反「核心零外部依赖」。
  握手是 SIGMA-I 形状（临时 X25519 + 双方 Ed25519 签名覆盖 transcript），只用 Bun 自带原语；
  Bun 没有 ChaCha20-Poly1305，记录层用 AES-256-GCM。
- **配对码而不是 TOFU / SAS 比对**：码里放发码方指纹前 64 位 + 56 位令牌，只需一边抄码、
  另一边什么都不用确认，而且令牌只在已认证通道里发出，被动窃听拿不到；单纯 HMAC(短码) 的方案
  会被中间人拿到一次 MAC 后离线爆破。
- **自己的 UDP 组播而不是 mDNS**：不和系统 mDNSResponder / avahi 抢 5353，也不依赖它们；
  应答不认证，只当地址提示。
- **只做跨机 DM，不复制频道**：两边各自落盘、seq 各自为政（铁律 1 不动），频道名按
  （对端指纹, 本机短 id, 远端短 id）对称派生，一来一回落在同一频道。多方共享频道仍是托管版的事。
- **投递阶梯共用**：`src/deliver.ts` 从 cli.ts 抽出，本地 dm 和守护进程收到的远端 dm 走同一份代码，
  输出经 sink 回传给发送方。

## 五、共享维护策略（两个项目一处维护）

目标（owner 拍板方向）：跑通之后抽公共组件，**canonical 只有一处**，两个项目都从它维护。

分两阶段：

**阶段 1（MVP 期，现在）**：open-cross-session 独立仓开发，需要的模块从主仓
vendor 副本进来，先跑通再谈抽象。过早抽包会拖慢验证。

**阶段 2（跑通之后）**：采用主仓已被验证的「单向 sync 镜像」模式
（先例：`skills/` → `plugins/` 由 `sync-agentparty-plugin.ts` 生成镜像）：

- 在 AgentParty monorepo 新增 workspace 包 `packages/cross-session-core`（MIT 许可，
  与主仓 BUSL-1.1 并存——公共层单独授权，即经典 open-core 结构），
  沉淀：协议数据结构、claude-inbox-inject、codex-desktop-ipc、唤醒适配器、总线接口。
- open-cross-session 仓成为**发行镜像**：主仓 CI 单向 sync 代码 + 随 v* tag
  发 GitHub Release 二进制（沿用 install.sh 模式，不进 npm registry）。
- 开源仓 CONTRIBUTING 注明 PR 路由：镜像仓收 issue 和讨论，代码 PR 引导到主仓
  （或收下后由维护者 backport），避免双头改动。

两个注意点：
1. **许可**：主仓是 BUSL-1.1，抽出的公共层要改 MIT。代码基本是 owner 主导产出、
   版权归属清晰，但抽取时逐文件过一遍是否含外部贡献者的实质提交。
2. **镜像不是 canonical**：主仓 skills/plugins 镜像已有「手改镜像无效」绊倒人的教训，
   开源仓 README 顶部要放显眼的 sync 说明。

## 六、里程碑（草案）

- M0 脚手架 + 设计定稿（本文档）
- M1 本地总线 + claude↔claude 双会话互发（吃透默认 hold 问题）
- M2 codex 接入（原生 IPC 路径）
- M3 频道语义（N 方 + 人）、`upgrade` 引流通道
- M4 开源发布（README 头牌：Codex 原生 task 流接入）
