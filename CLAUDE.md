# CLAUDE.md

## 项目一句话

本地无服务器版 agent party：Claude Code ↔ Codex ↔ Pi 互相唤醒/互发消息（`ocs` CLI），同机直连，局域网内配对的电脑之间也能互通（v0.6 起，docs/lan.md），向托管版 [Agent Party](https://agentparty.leeguoo.com) 引流。架构与决策记录在 **DESIGN.md**（必读），组件出处细节在 **docs/agentparty-extraction-map.md**。

## 常用命令

```bash
bun install
bun test               # 真 UDS 端到端 + 假 IPC 路由器全握手 + 真脱离终端的 idle watcher
bunx tsc --noEmit
bun src/cli.ts <cmd>   # 本地跑 CLI（who/dm/send/read/notify-when-idle/sessions/watch/doctor/upgrade/lan）
                       # 内部子命令（不进 help）：_idle-watch、_claude-wake（回执 helper）、_lan-daemon
```

发布：打 `v*` tag 推送 → release workflow 编三平台二进制附 GitHub Release。**不发 npm registry。**

## 铁律（改代码前必知）

1. **seq 单一真值源是频道日志本身**（`store.ts` 锁内从日志尾推导）。别引入独立 seq 文件/缓存——「日志已写、seq 记录未更新」的崩溃窗口会造出重复 seq，读侧去重把后到消息永久遮蔽（已修复过一次，有回归测试）。
2. **锁抢占只许原子 rename 认领**（ESRCH + 锁龄门槛）。unlink 式抢占有双抢竞态。
3. **`isOcsMessage` 校验字段表与 `OcsMessage` 逐字镜像**，新增字段两边同改（漏改=静默丢消息；测试守着）。
4. **Claude 注入 `ok:true` ≠ 已送达**：接收端 `crossSessionInbound` 默认 hold，5 分钟无人 Deliver 静默丢弃。绝不拿 ok 清欠账；doctor 引导用户设 accept。v0.7.0 起订阅原生回执（docs/wake-protocol.md §6，`src/claude-receipt.ts` + `src/wake-helper.ts`）：`held` / `refused` / `dropped` / `denied` / `expired` **证明没进对话**（退出码 2，被扣的最终没送达时通知发送方一次），`delivered` 证明被扣的进了对话；**没有回执只叫 `accepted`，不证明已读**（accept 策略根本不发回执），照样不许拿它清欠账。写帧的进程必须就是监听回执 socket 的进程（接收端按写入方 pid 回发），所以 Claude 唤醒在脱离终端的 helper 里做，CLI 只读它的第一行；**帧只由 helper 写，CLI 等不到结果就是 unknown，绝不补写**。回执 socket 是 Claude 的 socket 目录里唯一允许我们建的文件（0600、用完必删）。通知帧不带 `from`（不递归）。回执落盘是 `type:"receipt"` 旁车帧，规矩同铁律 9。Windows 无回执，行为同 0.6。
5. **Codex IPC unknown-outcome 绝不重放**（帧已写出但结果未知是一等错误）。IPC 是 ChatGPT.app 私有协议，宿主升级可能破，失败必须留降级余地。
6. **vendored 文件不是 canonical**：`src/claude-inject.ts`、`src/codex-ipc.ts`（含 Windows 部分 `src/codex-ipc-win.ts`，回流中 AgentParty#1132）、`src/codex-sessions.ts` 来自 AgentParty 主仓（`~/github.com/agentparty`，文件头有标注）。行为疑问对上游；修 bug 考虑回流上游。
7. 唤醒载荷按 **docs/wake-protocol.md**（与 AgentParty 共用，正本在本仓库）：正文 ≤4096B 逐字内联、超过只带前 512B、整条 ≤5120B，`Reply:`/`Thread:` 两行永不砍；正文里的包装标签与行首协议行要中和（`neutralizeWakeBody`），正文是对方可控数据。改数字/文案先改协议文档，两边同步。
8. **notify-when-idle 是一次性的**：watcher 投递一条通知后必须退出；每次翻转都发会把订阅方打成筛子（测试钉着）。
9. **DM 路由身份是独立 route sidecar，不是 `OcsMessage v1` 字段**：旧二进制会严格拒绝未知消息字段。sidecar 与消息在同一频道 JSONL，必须先写 route、再写 message；这样消息写失败可以安全重试，旧读端仍会跳过 sidecar 并读取原消息。
10. **Codex 载体按宿主选，不是一律 queue**：Desktop 托管的 task 先走 Desktop IPC（它在 rollout 里留 `send_message_to_thread` + `<codex_delegation><source_thread_id>` 原生来源信封；`codex queue` 留下的是普通 `UserMessage`，会把别的 agent 的消息呈现成「用户自己敲的」——跨会话内容必须看得出是数据而不是用户指令）。终端 TUI 只有 `codex queue` 这一条路：thread id 就是 rollout 文件名里的 UUID，官方 CLI 按它精确寻址，不需要 cmux / Desktop / app-server daemon。但 **`queue` 是写 thread store 不是投递**——目标已退出时照样 exit=0，所以发之前必须用 rollout 文件的 fd 持有者（`lsof`）证明会话活着，查不到就不发（fail closed），欠账留 inbox。**持有者还要过身份校验**：只认 REG 类型的该 rollout 文件本身，且持有者自己或祖先是 `codex` 二进制（basename 精确比）或挂在 ChatGPT.app 树下——索引类第三方进程（issue #35）照样持有这些 fd，不校验等于 fail-closed 失效。走到 Desktop IPC 那一层时旧规则依然成立：必须让 renderer owner claim 目标并为同 renderer 找到 source；Desktop 对无人认领的 discovery 会超时，候选并发短探测，未认领按 `not-open` 停靠 inbox，不当传输故障重试。可达性 = 「有活进程持有 rollout」**或**「被 renderer 认领」——`ocs who` 两者都列，只按后者过滤会把终端里的 codex 整个藏起来。**Windows 的 IPC 是可被抢注的固定管道名**：发任何帧之前必须在同一个句柄上校验服务端（属主 SID、服务端进程同用户、ChatGPT Desktop 包身份 + 映像在包目录内，`src/codex-ipc-win.ts`），不过关就是 unavailable、零字节；不许退回「管道存在就信」，也不许「探测过关后另开一条连接发帧」（同名管道可以有别人的实例）。`test/codex-ipc-win.test.ts` 守着，改之前先跑变异自检。
11. **局域网（docs/lan.md）的安全不变量**：身份只认 Ed25519 公钥，IP / label / 自报名都只是提示；客户端必须**先核对服务端公钥再发本机身份和请求**（已配对钉完整指纹，配对中核对码里的 64 位前缀）；未配对连接只许 `pair`，帧上限保持 1 KiB；远端发送者在本机一律显示 `x@<本机给的 label>`，日志 `from` 为 `x.<label>`，远端改不了；远端 DM 只投活会话或登记过的 ocs 名字，不许随手造频道；请求发出后没应答 = unknown，绝不重发。`test/lan.test.ts` 对每条都有用例，改协议先跑变异自检（把检查改成 `if (false)` 必须红）。守护进程启动时剥掉会话环境变量，否则它把启动它的会话当「自己」永远不唤醒。
12. **Hermes（`src/hermes.ts`，#40）走宿主私有 WebSocket**：`prompt.submit` 必须带 `queued:true`（不带会按 Hermes 默认 busy 模式打断当前这一轮）；token 每次连接重读并核对 rendezvous 记录里的指纹，只连 loopback（token 在 URL 里）；运行期 id 每次投递前用 `session.active_list` 现查，绝不缓存；submit 帧发出后无应答 = unknown-outcome，绝不重发。对外地址把会话 id 的 `_` 写成 `.`（NAME_RE 不含 `_`）。身份解析里 Hermes 排最后：Hermes 往每条终端命令注入 `HERMES_SESSION_ID`，在它里面开的 Claude/Codex 也会继承。`test/hermes.test.ts` 守着，改之前先跑变异自检。

## 路线（owner 已拍板）

验证跑通后：主仓抽 MIT 的 `packages/cross-session-core`（open-core，主仓保持 BUSL-1.1），本仓转为单向 sync 发行镜像——届时直接改本仓 vendored 文件无效。
