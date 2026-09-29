// `ocs lan …`、`ocs dm <地址>@<对端>`、`ocs who --lan` 的命令实现。
// cli.ts 只负责参数解析和分派；这里的输出一律走 i18n-lan 目录。

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Lang } from "./i18n.ts";
import { lanMessages } from "./i18n-lan.ts";
import { encodePairingCode, fingerprintDigest, shortFingerprint, type LanIdentity } from "./lan-crypto.ts";
import { lanChannel, LAN_DAEMON_COMMAND, LAN_DAEMON_ENV_STRIP } from "./lan-daemon.ts";
import { autostartPlan, autostartState, disableAutostart, enableAutostart } from "./lan-autostart.ts";
import { localIpv4Addresses, scanLan } from "./lan-discovery.ts";
import { LanClientError, pairWithCode, remoteWho, sendRemoteDm } from "./lan-client.ts";
import {
  clearDaemonState,
  createPairOffer,
  daemonLogPath,
  closePairOffer,
  findPeer,
  liveDaemonState,
  listPeers,
  loadLanConfig,
  loadOrCreateIdentity,
  loadPairOffer,
  openPairOffers,
  PAIR_OFFER_TTL_MS,
  PEER_LABEL_RE,
  removePeer,
  saveLanConfig,
  LanStateError,
  type LanPeer,
} from "./lan-store.ts";
import { appendMessage, NAME_RE } from "./store.ts";

export interface LanCliContext {
  lang: Lang;
  version: string;
  positional: string[];
  flags: Map<string, string | true>;
  fail(message: string): never;
  /** 已落盘但唤醒失败（2）/ 结果未知（3）。 */
  markStored(outcome: "failed" | "unknown"): void;
  /** 本机发起命令（cli.ts 的 selfCommand 同款）：[bun, cli.ts] 或 [编译后的二进制]。 */
  selfCommand: string[];
}

function flagString(ctx: LanCliContext, name: string): string | undefined {
  const value = ctx.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function guarded<T>(ctx: LanCliContext, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof LanStateError) ctx.fail(lanMessages(ctx.lang).stateError(error.message));
    throw error;
  }
}

function identity(ctx: LanCliContext): LanIdentity {
  return guarded(ctx, () => loadOrCreateIdentity());
}

function requirePeer(ctx: LanCliContext, query: string): LanPeer {
  const peer = guarded(ctx, () => findPeer(query));
  if (peer === null) ctx.fail(lanMessages(ctx.lang).peerNotFound(query));
  return peer;
}

function describeClientError(ctx: LanCliContext, peer: string, error: unknown): string {
  const L = lanMessages(ctx.lang);
  if (error instanceof LanClientError && error.mismatches.length > 0) {
    return L.keyMismatch(peer, error.mismatches.join(", "));
  }
  return L.offline(peer, error instanceof Error ? error.message : String(error));
}

// ───────────────────────── 守护进程生命周期 ─────────────────────────

async function lanUp(ctx: LanCliContext): Promise<void> {
  const L = lanMessages(ctx.lang);
  const running = liveDaemonState();
  if (running !== null) {
    console.log(L.upAlready(running.pid, running.port));
    return;
  }
  const config = guarded(ctx, () => loadLanConfig());
  const port = flagString(ctx, "port");
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) ctx.fail(L.badPort(port));
    config.port = n;
  }
  const bind = flagString(ctx, "bind");
  if (bind !== undefined) config.bind = bind;
  const name = flagString(ctx, "name");
  if (name !== undefined) {
    if (!PEER_LABEL_RE.test(name)) ctx.fail(L.badLabel(name));
    config.name = name;
  }
  if (ctx.flags.has("no-discover")) config.discover = false;
  if (ctx.flags.has("discover")) config.discover = true;
  saveLanConfig(config);
  const id = identity(ctx); // 首次在前台生成身份：权限问题在这里报，而不是让守护进程静默退出
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of LAN_DAEMON_ENV_STRIP) delete env[key];
  const [cmd, ...args] = ctx.selfCommand;
  const child = spawn(cmd!, [...args, LAN_DAEMON_COMMAND], { detached: true, stdio: "ignore", env, windowsHide: true });
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = liveDaemonState();
    if (state !== null && state.pid === child.pid) {
      console.log(L.upStarted(state.name, state.port, shortFingerprint(id.fingerprint), state.discover));
      if (process.platform === "darwin" && state.bind !== "127.0.0.1") console.log(L.upFirewallHint);
      return;
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let tail = "";
  try {
    tail = readFileSync(daemonLogPath(), "utf8").trim().split("\n").slice(-3).join("\n");
  } catch {
    // 没日志
  }
  ctx.fail(L.upFailed(tail === "" ? "no state written within 5s" : tail));
}

/** 目标 pid 的命令行里要有 `_lan-daemon`：pid 复用时绝不能把别的进程杀掉。 */
function isLanDaemonPid(pid: number): boolean {
  if (process.platform === "win32") {
    // tasklist 只给映像名：要求它就是当前这个 ocs 可执行文件（守护进程由它自己拉起）。
    const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8", windowsHide: true });
    const image = process.execPath.split(/[\\/]/).pop()!.toLowerCase();
    return typeof out.stdout === "string" && out.stdout.toLowerCase().includes(`"${image}"`);
  }
  const out = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return typeof out.stdout === "string" && out.stdout.includes(LAN_DAEMON_COMMAND);
}

async function lanDown(ctx: LanCliContext): Promise<void> {
  const L = lanMessages(ctx.lang);
  const state = liveDaemonState();
  if (state === null) {
    console.log(L.downNotRunning);
    return;
  }
  if (!isLanDaemonPid(state.pid)) {
    clearDaemonState(state.pid);
    console.log(L.downNotOurs(state.pid));
    return;
  }
  process.kill(state.pid, "SIGTERM");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && liveDaemonState() !== null) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(L.downDone(state.pid));
}

function lanStatus(ctx: LanCliContext): void {
  const L = lanMessages(ctx.lang);
  const state = liveDaemonState();
  const id = identity(ctx);
  const peers = guarded(ctx, () => listPeers());
  const offers = openPairOffers();
  if (ctx.flags.has("json")) {
    console.log(JSON.stringify({
      running: state !== null,
      daemon: state,
      fingerprint: id.fingerprint,
      peers: peers.map((p) => ({ label: p.label, name: p.name, fingerprint: p.fingerprint, addrs: p.addrs, last_seen: p.last_seen ?? null })),
      open_pairing_codes: offers.length,
    }, null, 2));
    return;
  }
  console.log(state === null
    ? L.statusStopped
    : L.statusRunning({ pid: state.pid, name: state.name, bind: state.bind, port: state.port, discover: state.discover, version: state.version, started: state.started_at }));
  console.log(L.statusIdentity(id.fingerprint));
  console.log(L.statusPeers(peers.length));
  if (offers.length > 0) console.log(L.statusOffers(offers.length));
  const plan = autostartPlan(process.platform, ctx.selfCommand);
  if (plan !== null) console.log(L.statusAutostart(autostartState(plan)));
}

function lanPeers(ctx: LanCliContext): void {
  const L = lanMessages(ctx.lang);
  const peers = guarded(ctx, () => listPeers());
  if (ctx.flags.has("json")) {
    console.log(JSON.stringify(peers.map(({ key: _key, ...rest }) => rest), null, 2));
    return;
  }
  if (peers.length === 0) {
    console.log(L.peersNone);
    return;
  }
  for (const p of peers) {
    console.log(L.peerLine(p.label, p.name, shortFingerprint(p.fingerprint), p.addrs[0] ?? "?", p.last_seen ?? "?"));
  }
}

// ───────────────────────── 配对 ─────────────────────────

async function lanPairIssue(ctx: LanCliContext): Promise<void> {
  const L = lanMessages(ctx.lang);
  const state = liveDaemonState();
  if (state === null) ctx.fail(L.pairNeedsDaemon);
  const label = flagString(ctx, "label");
  if (label !== undefined && !PEER_LABEL_RE.test(label)) ctx.fail(L.badLabel(label));
  const id = identity(ctx);
  const { offer, token } = createPairOffer(label === undefined ? {} : { label });
  const code = encodePairingCode(fingerprintDigest(id.publicKey), token);
  console.log(L.pairIssued(code, Math.round(PAIR_OFFER_TTL_MS / 60000)));
  const addrs = localIpv4Addresses().map((ip) => `${ip}:${state.port}`);
  if (addrs.length > 0) console.log(L.pairAddrHint(addrs.join(", ")));
  console.log(L.pairWaiting);
  let cancelled = false;
  const cancel: NodeJS.SignalsListener = () => {
    cancelled = true;
  };
  // 关终端（SIGHUP）也得作废邀请，不然码一直有效到过期。
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.once(signal, cancel);
  let final: ReturnType<typeof closePairOffer> = null;
  let stop: "cancelled" | "expired" | "burned" | "paired" = "expired";
  try {
    for (;;) {
      const current = loadPairOffer(offer.id);
      if (current?.status === "paired") {
        stop = "paired";
        break;
      }
      if (cancelled) {
        stop = "cancelled";
        break;
      }
      if (current?.status === "burned") {
        stop = "burned";
        break;
      }
      if (current === null || Date.parse(current.expires_at) <= Date.now()) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    for (const signal of signals) (process as NodeJS.EventEmitter).removeListener(signal, cancel);
    // 锁内关闭并拿最终状态：兑码与关闭互斥，最后一刻兑现成功的也如实报成功。
    final = closePairOffer(offer.id);
  }
  if (final?.status === "paired" && final.peer !== undefined) {
    console.log(L.pairIssuerDone(final.peer.label, final.peer.name, shortFingerprint(final.peer.fingerprint)));
    return;
  }
  if (stop === "cancelled") {
    console.log(L.pairCancelled);
    process.exitCode = 130;
    return;
  }
  ctx.fail(stop === "burned" ? L.pairBurned : L.pairExpired);
}

async function lanPairJoin(ctx: LanCliContext, code: string): Promise<void> {
  const L = lanMessages(ctx.lang);
  const label = flagString(ctx, "label");
  if (label !== undefined && !PEER_LABEL_RE.test(label)) ctx.fail(L.badLabel(label));
  const addr = flagString(ctx, "addr");
  try {
    const { peer, addr: used } = await pairWithCode(code, identity(ctx), {
      ...(addr === undefined ? {} : { addr }),
      ...(label === undefined ? {} : { label }),
    });
    console.log(L.pairJoined(peer.label, peer.name, shortFingerprint(peer.fingerprint), used));
    console.log(L.pairCheckFingerprint);
  } catch (error) {
    if (error instanceof LanClientError) {
      ctx.fail(error.mismatches.length > 0
        ? L.pairFailed(error.code, L.keyMismatch("the code's issuer", error.mismatches.join(", ")))
        : L.pairFailed(error.code, error.message));
    }
    ctx.fail(L.pairFailed("error", error instanceof Error ? error.message : String(error)));
  }
}

// ───────────────────────── 发现 / 花名册 / 解除 ─────────────────────────

async function lanScan(ctx: LanCliContext): Promise<void> {
  const L = lanMessages(ctx.lang);
  const own = identity(ctx).fingerprint;
  const peers = guarded(ctx, () => listPeers());
  const found = (await scanLan({ timeoutMs: 2000 })).filter((i) => i.fingerprint !== own);
  if (ctx.flags.has("json")) {
    console.log(JSON.stringify(found.map((i) => ({
      ...i,
      paired_as: peers.find((p) => p.fingerprint === i.fingerprint)?.label ?? null,
    })), null, 2));
    return;
  }
  if (found.length === 0) {
    console.log(L.scanNone);
    return;
  }
  for (const i of found) {
    const label = peers.find((p) => p.fingerprint === i.fingerprint)?.label ?? null;
    console.log(L.scanLine(i.name, shortFingerprint(i.fingerprint), i.host, i.port, label));
  }
}

function lanUnpair(ctx: LanCliContext, query: string): void {
  const peer = requirePeer(ctx, query);
  removePeer(peer.fingerprint);
  console.log(lanMessages(ctx.lang).unpaired(peer.label));
}

/** `ocs lan who [peer]` 和 `ocs who --lan` 共用：并发查每个对端，离线的单独一行。 */
export async function printLanWho(ctx: Pick<LanCliContext, "lang" | "fail">, only?: LanPeer): Promise<void> {
  const L = lanMessages(ctx.lang);
  let peers: LanPeer[];
  try {
    peers = only === undefined ? listPeers() : [only];
  } catch (error) {
    ctx.fail(L.stateError(error instanceof Error ? error.message : String(error)));
  }
  if (peers.length === 0) {
    console.log(L.whoNoPeers);
    return;
  }
  const id = loadOrCreateIdentity();
  const results = await Promise.all(peers.map(async (peer) => {
    try {
      return { peer, who: await remoteWho(peer, id) };
    } catch (error) {
      return { peer, error };
    }
  }));
  for (const result of results) {
    if ("error" in result) {
      const e = result.error;
      console.log(e instanceof LanClientError && e.mismatches.length > 0
        ? L.keyMismatch(result.peer.label, e.mismatches.join(", "))
        : L.whoOffline(result.peer.label, e instanceof Error ? e.message : String(e)));
      continue;
    }
    console.log(L.whoHeader(result.peer.label, result.who.name));
    if (result.who.entries.length === 0) console.log(L.whoEmpty);
    for (const e of result.who.entries) {
      console.log(L.whoEntry(`${e.address}@${result.peer.label}`, e.kind, e.status ?? "", e.label ?? ""));
    }
  }
}

export function lanPeerCount(): number {
  try {
    return listPeers().length;
  } catch {
    return 0;
  }
}

// ───────────────────────── 跨机 DM ─────────────────────────

export interface LanDmSender {
  /** 对方回复用的地址（ocs 名字 > 短 id > 发送者名）。 */
  display: string;
  /** 频道派生用（短 id > 发送者名）。 */
  key: string;
  /** 本机副本的 from（频道日志里的名字）。 */
  logFrom: string;
  /** 本机副本的 from_identity（inbox 归属用）；null 时不写 route。 */
  identity: string | null;
}

export function splitRemoteAddress(target: string): { address: string; peer: string } | null {
  const at = target.lastIndexOf("@");
  if (at <= 0 || at === target.length - 1) return null;
  const address = target.slice(0, at);
  const peer = target.slice(at + 1).toLowerCase();
  if (!NAME_RE.test(address)) return null;
  if (!PEER_LABEL_RE.test(peer) && !/^[a-z2-7]{8,52}$/.test(peer)) return null;
  return { address, peer };
}

export async function lanDm(ctx: LanCliContext, target: string, body: string, sender: LanDmSender): Promise<void> {
  const L = lanMessages(ctx.lang);
  const parsed = splitRemoteAddress(target);
  if (parsed === null) ctx.fail(L.dmAddressInvalid(target));
  const peer = requirePeer(ctx, parsed.peer);
  let result: Awaited<ReturnType<typeof sendRemoteDm>>;
  try {
    result = await sendRemoteDm(peer, identity(ctx), {
      from: sender.display,
      from_key: sender.key,
      to: parsed.address,
      body,
      lang: ctx.lang,
    });
  } catch (error) {
    ctx.fail(describeClientError(ctx, peer.label, error));
  }
  if (result.delivered === "unknown") {
    console.log(L.dmUnknown(peer.label, result.detail));
    ctx.markStored("unknown");
    return;
  }
  const reply = result.reply;
  if (!reply.ok) {
    ctx.fail(L.dmRefused(target, reply.error, reply.detail ?? ""));
  }
  const remoteTarget = `${reply.to_display}@${peer.label}`;
  console.log(L.dmSent(remoteTarget, reply.channel, reply.seq));
  for (const line of reply.lines) console.log(L.dmRemoteLine(peer.label, line));
  if (reply.outcome !== "ok") ctx.markStored(reply.outcome);
  // 本机副本：远端确认落盘后才写，频道与对方回信落在同一个 lan-* 频道（两边同样的派生规则）。
  try {
    const channel = lanChannel(peer.fingerprint, sender.key, reply.to_key);
    const toIdentity = `lan:${peer.fingerprint}:${reply.to_key}`;
    const copy = appendMessage({
      channel,
      from: sender.logFrom,
      ...(sender.identity === null || !NAME_RE.test(reply.to_key) ? {} : { from_identity: sender.identity, to_identity: toIdentity }),
      body,
    });
    console.log(L.dmLocalCopy(channel, copy.seq));
  } catch (error) {
    console.log(L.dmLocalCopyFailed(error instanceof Error ? error.message : String(error)));
  }
}

// ───────────────────────── 分派 ─────────────────────────

export async function cmdLan(ctx: LanCliContext): Promise<void> {
  const L = lanMessages(ctx.lang);
  const [sub, arg, ...extra] = ctx.positional;
  if (extra.length > 0) ctx.fail(L.usage);
  switch (sub) {
    case "up":
      return lanUp(ctx);
    case "down":
      return lanDown(ctx);
    case "status":
    case undefined:
      return lanStatus(ctx);
    case "peers":
      return lanPeers(ctx);
    case "pair":
      return arg === undefined ? lanPairIssue(ctx) : lanPairJoin(ctx, arg);
    case "scan":
      return lanScan(ctx);
    case "unpair":
      if (arg === undefined) ctx.fail(L.usage);
      return lanUnpair(ctx, arg);
    case "who":
      return printLanWho(ctx, arg === undefined ? undefined : requirePeer(ctx, arg));
    case "autostart": {
      if (arg !== "on" && arg !== "off") ctx.fail(L.usage);
      const plan = autostartPlan(process.platform, ctx.selfCommand);
      if (plan === null) ctx.fail(L.autostartUnsupported);
      if (arg === "on") console.log(L.autostartOn(enableAutostart(plan)));
      else console.log(L.autostartOff(disableAutostart(plan)));
      return;
    }
    default:
      ctx.fail(L.usage);
  }
}

