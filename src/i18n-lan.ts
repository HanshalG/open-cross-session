// `ocs lan …` 与跨机 DM 的双语文案。独立成文件免得 i18n.ts 再膨胀；规则同 i18n.ts：
// 英文 canonical，两种语言同一个接口，漏一条 tsc 就报错。

import type { Lang } from "./i18n.ts";

export interface LanCatalog {
  help: string;
  usage: string;
  upStarted: (name: string, port: number, fp: string, discover: boolean) => string;
  upAlready: (pid: number, port: number) => string;
  upFailed: (detail: string) => string;
  upFirewallHint: string;
  upFirewallAllowed: string;
  downDone: (pid: number) => string;
  downNotRunning: string;
  downNotOurs: (pid: number) => string;
  statusRunning: (s: { pid: number; name: string; bind: string; port: number; discover: boolean; version: string; started: string }) => string;
  statusStopped: string;
  statusIdentity: (fp: string) => string;
  statusPeers: (count: number) => string;
  statusOffers: (count: number) => string;
  peersNone: string;
  peerLine: (label: string, name: string, fp: string, addr: string, lastSeen: string) => string;
  pairNeedsDaemon: string;
  pairIssued: (code: string, minutes: number) => string;
  pairAddrHint: (addrs: string) => string;
  pairWaiting: string;
  pairIssuerDone: (label: string, name: string, fp: string) => string;
  pairExpired: string;
  pairBurned: string;
  pairCancelled: string;
  pairJoined: (label: string, name: string, fp: string, addr: string) => string;
  pairFailed: (code: string, detail: string) => string;
  pairCheckFingerprint: string;
  scanNone: string;
  scanLine: (name: string, fp: string, host: string, port: number, label: string | null) => string;
  unpaired: (label: string) => string;
  peerNotFound: (query: string) => string;
  badLabel: (label: string) => string;
  badPort: (port: string) => string;
  dmAddressInvalid: (target: string) => string;
  dmFlagUnsupported: (flag: string) => string;
  dmSent: (target: string, channel: string, seq: number) => string;
  dmLocalCopy: (channel: string, seq: number) => string;
  dmLocalCopyFailed: (detail: string) => string;
  dmRemoteLine: (peer: string, line: string) => string;
  dmRefused: (target: string, error: string, detail: string) => string;
  dmUnknown: (peer: string, detail: string) => string;
  offline: (peer: string, detail: string) => string;
  keyMismatch: (peer: string, addrs: string) => string;
  whoHeader: (label: string, name: string) => string;
  whoOffline: (label: string, detail: string) => string;
  whoEntry: (address: string, kind: string, status: string, label: string) => string;
  whoEmpty: string;
  whoNoPeers: string;
  whoHint: (count: number) => string;
  stateError: (detail: string) => string;
  autostartOn: (where: string) => string;
  autostartOff: (removed: boolean) => string;
  autostartUnsupported: string;
  statusAutostart: (state: "on" | "stale" | "off") => string;
  doctorHeader: string;
  doctorOff: string;
  doctorRunning: (name: string, port: number, peers: number) => string;
  doctorNoPeers: string;
  doctorAutostartOff: string;
}

const en: LanCatalog = {
  help: `  ocs lan up [--port <n>] [--bind <ip>] [--name <name>] [--no-discover | --discover]
      Start the LAN daemon (off by default). Only paired machines can reach your agents.
  ocs lan pair [--label <name>]            show a one-time code (10 min) and wait for it
  ocs lan pair <code> [--addr <host:port>] [--label <name>]   redeem a code from another machine
  ocs lan status | peers | scan | who [<peer>] | unpair <peer> | down | autostart on|off
      Then: ocs dm <address>@<peer> <text>; ocs who --lan lists remote agents.`,
  usage: "usage: ocs lan up|down|status|pair [<code>]|peers|scan|who [<peer>]|unpair <peer>|autostart on|off",
  upStarted: (name, port, fp, discover) =>
    `lan: daemon up as ${name} on port ${port} (key ${fp})${discover ? "" : " — discovery off"}`,
  upAlready: (pid, port) => `lan: daemon already running (pid ${pid}, port ${port}); \`ocs lan down\` first to change settings`,
  upFailed: (detail) => `lan: daemon did not start: ${detail}`,
  upFirewallHint: "  could not register ocs with the macOS firewall — allow incoming connections for ocs in System Settings › Network › Firewall, or peers cannot reach you.",
  upFirewallAllowed: "  macOS firewall: incoming connections allowed for this ocs binary",
  downDone: (pid) => `lan: daemon stopped (pid ${pid})`,
  downNotRunning: "lan: daemon is not running",
  downNotOurs: (pid) => `lan: pid ${pid} in daemon.json is not an ocs lan daemon; removed the stale state file`,
  statusRunning: (s) =>
    `lan: running — pid ${s.pid}, ${s.name} on ${s.bind}:${s.port}, discovery ${s.discover ? "on" : "off"}, ocs ${s.version}, since ${s.started}`,
  statusStopped: "lan: not running (start with `ocs lan up`)",
  statusIdentity: (fp) => `  this machine's key: ${fp}`,
  statusPeers: (count) => `  paired peers: ${count}`,
  statusOffers: (count) => `  open pairing codes: ${count}`,
  peersNone: "lan: no paired peers — `ocs lan pair` on one machine, `ocs lan pair <code>` on the other",
  peerLine: (label, name, fp, addr, lastSeen) => `  ${label}  (${name})  key ${fp}  ${addr}  last seen ${lastSeen}`,
  pairNeedsDaemon: "lan: the daemon must be running to accept a pairing — run `ocs lan up` first",
  pairIssued: (code, minutes) =>
    `Pairing code (one use, expires in ${minutes} min):\n\n    ${code}\n\nOn the other machine run:\n\n    ocs lan pair ${code}\n\nAnyone who types this code can message your agents. Share it only with the machine you mean to pair.`,
  pairAddrHint: (addrs) => `If discovery is blocked on this network, add: --addr <one of ${addrs}>`,
  pairWaiting: "waiting for the other machine… (Ctrl+C cancels the code)",
  pairIssuerDone: (label, name, fp) => `paired with ${label} (${name}), key ${fp}`,
  pairExpired: "the code expired unused",
  pairBurned: "the code was destroyed after too many wrong attempts — someone may be guessing; issue a new one",
  pairCancelled: "code cancelled",
  pairJoined: (label, name, fp, addr) => `paired with ${label} (${name}) at ${addr}, key ${fp}`,
  pairFailed: (code, detail) => `pairing failed (${code}): ${detail}`,
  pairCheckFingerprint: "Tip: compare the key above with `ocs lan status` on the other machine.",
  scanNone: "lan: no ocs instances answered (discovery may be blocked; pairing still works with --addr)",
  scanLine: (name, fp, host, port, label) =>
    `  ${name}  ${host}:${port}  key ${fp}  ${label === null ? "not paired" : `paired as ${label}`}`,
  unpaired: (label) => `lan: removed ${label}; it can no longer reach this machine (it still lists you until it unpairs too)`,
  peerNotFound: (query) => `lan: no paired peer named ${query} (see \`ocs lan peers\`)`,
  badLabel: (label) => `lan: bad name ${label} (lowercase letters, digits, dashes; ≤32)`,
  badPort: (port) => `lan: bad port ${port}`,
  dmAddressInvalid: (target) => `bad remote address ${target} (want <address>@<peer>)`,
  dmFlagUnsupported: (flag) => `--${flag} is not supported for LAN DMs yet`,
  dmSent: (target, channel, seq) => `dm stored on remote → ${target} (channel ${channel}, seq ${seq})`,
  dmLocalCopy: (channel, seq) => `local copy #${channel} seq ${seq}`,
  dmLocalCopyFailed: (detail) => `warning: delivered, but the local copy could not be written: ${detail}`,
  dmRemoteLine: (peer, line) => `  [${peer}] ${line}`,
  dmRefused: (target, error, detail) => `remote refused dm to ${target}: ${error}${detail === "" ? "" : ` (${detail})`}; nothing was stored`,
  dmUnknown: (peer, detail) =>
    `outcome unknown: the request reached ${peer} but no reply came back (${detail}). It may have been stored and delivered — do NOT resend; ask the peer or check \`ocs lan who ${peer}\`.`,
  offline: (peer, detail) => `lan: ${peer} is not reachable (${detail}); nothing was sent. Is \`ocs lan up\` running there?`,
  keyMismatch: (peer, addrs) =>
    `lan: SECURITY: ${addrs} answered with a different key than ${peer}. Its address changed, it was reinstalled, or someone is impersonating it. Nothing was sent. If it was reinstalled, \`ocs lan unpair ${peer}\` and pair again.`,
  whoHeader: (label, name) => `LAN ${label} (${name}):`,
  whoOffline: (label, detail) => `LAN ${label}: offline (${detail})`,
  whoEntry: (address, kind, status, label) => `  ${address}  ${kind}${status === "" ? "" : `  ${status}`}${label === "" ? "" : `  ${label}`}`,
  whoEmpty: "  (no reachable agents)",
  whoNoPeers: "LAN: no paired peers (see `ocs lan pair`)",
  whoHint: (count) => `LAN: ${count} paired peer${count === 1 ? "" : "s"} — \`ocs who --lan\` lists their agents`,
  stateError: (detail) => `lan: refusing to use local LAN state: ${detail}`,
  autostartOn: (where) => `lan: the daemon will start at login (${where}); \`ocs lan up\` starts it now`,
  autostartOff: (removed) => removed ? "lan: login autostart removed (a running daemon keeps running; `ocs lan down` stops it)" : "lan: login autostart was not set",
  autostartUnsupported: "lan: login autostart is not supported on this platform",
  doctorHeader: "LAN (other computers)",
  doctorOff: "LAN mode is off (optional): reach agents on your other computers with `ocs lan up` + `ocs lan pair` — see docs/lan.md",
  doctorRunning: (name, port, peers) => `LAN daemon running as ${name} on port ${port}, ${peers} paired peer${peers === 1 ? "" : "s"}`,
  doctorNoPeers: "no paired computers yet: `ocs lan pair` here, `ocs lan pair <code>` on the other one",
  doctorAutostartOff: "LAN daemon will not come back after a restart: `ocs lan autostart on`",
  statusAutostart: (state) => `  start at login: ${state === "on" ? "on" : state === "stale" ? "stale (points at another ocs install — run `ocs lan autostart on`)" : "off (`ocs lan autostart on`)"}`,
};

const zh: LanCatalog = {
  help: `  ocs lan up [--port <n>] [--bind <ip>] [--name <名字>] [--no-discover | --discover]
      启动局域网守护进程（默认关闭）。只有配对过的机器能找到你的 agent
  ocs lan pair [--label <名字>]            出一个一次性配对码（10 分钟有效）并等对方兑现
  ocs lan pair <配对码> [--addr <host:port>] [--label <名字>]   在另一台机器上兑现配对码
  ocs lan status | peers | scan | who [<对端>] | unpair <对端> | down | autostart on|off
      之后：ocs dm <地址>@<对端> <内容>；ocs who --lan 列出远端 agent`,
  usage: "用法: ocs lan up|down|status|pair [<配对码>]|peers|scan|who [<对端>]|unpair <对端>|autostart on|off",
  upStarted: (name, port, fp, discover) =>
    `lan: 守护进程已启动，实例名 ${name}，端口 ${port}（公钥 ${fp}）${discover ? "" : "，局域网发现已关闭"}`,
  upAlready: (pid, port) => `lan: 守护进程已在运行（pid ${pid}，端口 ${port}）；要改设置先 \`ocs lan down\``,
  upFailed: (detail) => `lan: 守护进程没起来：${detail}`,
  upFirewallHint: "  没能在 macOS 防火墙里放行 ocs——请到 系统设置 › 网络 › 防火墙 允许 ocs 的传入连接，否则对端连不进来。",
  upFirewallAllowed: "  macOS 防火墙：已放行这个 ocs 程序的传入连接",
  downDone: (pid) => `lan: 守护进程已停止（pid ${pid}）`,
  downNotRunning: "lan: 守护进程没在运行",
  downNotOurs: (pid) => `lan: daemon.json 里的 pid ${pid} 不是 ocs lan 守护进程；已删掉陈旧状态文件`,
  statusRunning: (s) =>
    `lan: 运行中 — pid ${s.pid}，${s.name} 监听 ${s.bind}:${s.port}，局域网发现${s.discover ? "开" : "关"}，ocs ${s.version}，启动于 ${s.started}`,
  statusStopped: "lan: 未运行（用 `ocs lan up` 启动）",
  statusIdentity: (fp) => `  本机公钥：${fp}`,
  statusPeers: (count) => `  已配对对端：${count}`,
  statusOffers: (count) => `  未兑现的配对码：${count}`,
  peersNone: "lan: 还没有配对的对端——一台机器 `ocs lan pair`，另一台 `ocs lan pair <配对码>`",
  peerLine: (label, name, fp, addr, lastSeen) => `  ${label}（${name}）  公钥 ${fp}  ${addr}  最近互通 ${lastSeen}`,
  pairNeedsDaemon: "lan: 接受配对需要守护进程在运行——先 `ocs lan up`",
  pairIssued: (code, minutes) =>
    `配对码（一次性，${minutes} 分钟内有效）：\n\n    ${code}\n\n在另一台机器上执行：\n\n    ocs lan pair ${code}\n\n拿到这个码的人就能给你的 agent 发消息。只发给你要配对的那台机器。`,
  pairAddrHint: (addrs) => `这个网络屏蔽了局域网发现的话，加上：--addr <${addrs} 之一>`,
  pairWaiting: "等待对方兑现…（Ctrl+C 作废这个码）",
  pairIssuerDone: (label, name, fp) => `已与 ${label}（${name}）配对，公钥 ${fp}`,
  pairExpired: "配对码过期，没人兑现",
  pairBurned: "错码次数太多，配对码已作废——可能有人在猜；重新出一个",
  pairCancelled: "配对码已作废",
  pairJoined: (label, name, fp, addr) => `已与 ${label}（${name}）配对，地址 ${addr}，公钥 ${fp}`,
  pairFailed: (code, detail) => `配对失败（${code}）：${detail}`,
  pairCheckFingerprint: "提示：可以和对方机器上 `ocs lan status` 显示的公钥核对一下。",
  scanNone: "lan: 没有 ocs 实例应答（可能网络屏蔽了发现；配对仍可用 --addr）",
  scanLine: (name, fp, host, port, label) =>
    `  ${name}  ${host}:${port}  公钥 ${fp}  ${label === null ? "未配对" : `已配对为 ${label}`}`,
  unpaired: (label) => `lan: 已移除 ${label}，它再也连不进本机（对方那边在它也 unpair 之前仍会列出你）`,
  peerNotFound: (query) => `lan: 没有叫 ${query} 的已配对对端（见 \`ocs lan peers\`）`,
  badLabel: (label) => `lan: 名字不合法：${label}（小写字母、数字、短横线，≤32）`,
  badPort: (port) => `lan: 端口不合法：${port}`,
  dmAddressInvalid: (target) => `远端地址不合法：${target}（格式 <地址>@<对端>）`,
  dmFlagUnsupported: (flag) => `局域网 DM 暂不支持 --${flag}`,
  dmSent: (target, channel, seq) => `dm 已在远端落盘 → ${target}（频道 ${channel}，seq ${seq}）`,
  dmLocalCopy: (channel, seq) => `本机副本 #${channel} seq ${seq}`,
  dmLocalCopyFailed: (detail) => `警告：已送达，但本机副本没写成：${detail}`,
  dmRemoteLine: (peer, line) => `  [${peer}] ${line}`,
  dmRefused: (target, error, detail) => `远端拒收发给 ${target} 的 dm：${error}${detail === "" ? "" : `（${detail}）`}；两边都没有落盘`,
  dmUnknown: (peer, detail) =>
    `结果未知：请求已到达 ${peer} 但没收到应答（${detail}）。可能已经落盘并唤醒——不要重发；问对方或查 \`ocs lan who ${peer}\`。`,
  offline: (peer, detail) => `lan: 连不上 ${peer}（${detail}），什么都没发。对方跑着 \`ocs lan up\` 吗？`,
  keyMismatch: (peer, addrs) =>
    `lan: 安全警告：${addrs} 应答的公钥和 ${peer} 的不一致。可能是地址换了、对方重装了，或者有人冒充。什么都没发。确认是重装的话：\`ocs lan unpair ${peer}\` 后重新配对。`,
  whoHeader: (label, name) => `局域网 ${label}（${name}）：`,
  whoOffline: (label, detail) => `局域网 ${label}：离线（${detail}）`,
  whoEntry: (address, kind, status, label) => `  ${address}  ${kind}${status === "" ? "" : `  ${status}`}${label === "" ? "" : `  ${label}`}`,
  whoEmpty: "  （没有可达的 agent）",
  whoNoPeers: "局域网：没有已配对的对端（见 `ocs lan pair`）",
  whoHint: (count) => `局域网：${count} 个已配对对端——\`ocs who --lan\` 列出它们的 agent`,
  stateError: (detail) => `lan: 本机局域网状态不可信，拒绝使用：${detail}`,
  autostartOn: (where) => `lan: 登录后会自动启动守护进程（${where}）；现在就要用请跑 \`ocs lan up\``,
  autostartOff: (removed) => removed ? "lan: 已取消登录自启（正在跑的守护进程不受影响，停它用 `ocs lan down`）" : "lan: 本来就没设登录自启",
  autostartUnsupported: "lan: 这个平台不支持登录自启",
  doctorHeader: "局域网（其他电脑）",
  doctorOff: "局域网模式未开启（可选）：`ocs lan up` + `ocs lan pair` 就能找到你其他电脑上的 agent，见 docs/lan.md",
  doctorRunning: (name, port, peers) => `局域网守护进程运行中：${name}，端口 ${port}，已配对 ${peers} 台电脑`,
  doctorNoPeers: "还没有配对的电脑：这台跑 `ocs lan pair`，另一台跑 `ocs lan pair <配对码>`",
  doctorAutostartOff: "重启后局域网守护进程不会自动回来：`ocs lan autostart on`",
  statusAutostart: (state) => `  登录自启：${state === "on" ? "开" : state === "stale" ? "失效（指向别处的 ocs，重跑 `ocs lan autostart on`）" : "关（`ocs lan autostart on`）"}`,
};

export function lanMessages(lang: Lang): LanCatalog {
  return lang === "zh" ? zh : en;
}
