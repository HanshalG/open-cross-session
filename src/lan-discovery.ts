// 局域网发现：UDP 组播问答，不用 mDNS（不和系统 mDNSResponder / avahi 抢 5353，也不依赖它们）。
//
// 查询方往组播组发 `{"ocs":"lan-query","v":1,"n":<nonce>}`，守护进程单播回
// `{"ocs":"lan-here","v":1,"n":<nonce>,"name","port","fp"}`。应答不认证——它只是「这个地址上
// 自称有这把公钥」的提示；身份一律以后续握手里服务端签名的公钥为准（配对码/信任库核对指纹）。
// 所以应答只放实例名、端口、公钥指纹，不放会话、用户名、路径。
// 应答和查询一样小，没有放大；每个源地址限速，查询格式不对直接丢。

import { createSocket, type Socket } from "node:dgram";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { FINGERPRINT_RE, PEER_LABEL_RE } from "./lan-store.ts";

export const DISCOVERY_GROUP = "239.255.67.83";
export const DISCOVERY_PORT_DEFAULT = 47891;
export const DISCOVERY_PORT_ENV = "OCS_LAN_DISCOVERY_PORT";
/** 测试/特殊网络用：逗号分隔的查询目标地址（缺省是组播组）。 */
export const DISCOVERY_TARGETS_ENV = "OCS_LAN_DISCOVERY_TARGETS";
const MAX_DATAGRAM = 512;
/** 查询至少这么大（用 pad 字段补齐），应答恒比它小：伪造源地址也放大不了流量。 */
export const MIN_QUERY_BYTES = 256;
const MAX_SCAN_RESULTS = 32;
const RATE_TABLE_MAX = 1024;

export function discoveryPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[DISCOVERY_PORT_ENV]);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DISCOVERY_PORT_DEFAULT;
}

function discoveryTargets(env: NodeJS.ProcessEnv): string[] {
  const raw = env[DISCOVERY_TARGETS_ENV];
  if (typeof raw === "string" && raw.trim() !== "") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return [DISCOVERY_GROUP];
}

function ipv4Interfaces(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === "IPv4" && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

/** 每张 IPv4 网卡的子网定向广播地址（192.168.1.0/24 → 192.168.1.255）。 */
function ipv4Broadcasts(): Array<{ iface: string; broadcast: string }> {
  const out: Array<{ iface: string; broadcast: string }> = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const ip = addr.address.split(".").map(Number);
      const mask = addr.netmask.split(".").map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      // /31、/32（点对点，VPN tun 常见）没有广播地址
      if (mask[3]! >= 254 && mask[0] === 255 && mask[1] === 255 && mask[2] === 255) continue;
      out.push({ iface: addr.address, broadcast: ip.map((octet, i) => (octet | (~mask[i]! & 255))).join(".") });
    }
  }
  return out;
}

/** 本机可供对方直连的 IPv4 地址（打印 `--addr` 兜底提示用）。 */
export function localIpv4Addresses(): string[] {
  return ipv4Interfaces();
}

export interface DiscoveredInstance {
  name: string;
  fingerprint: string;
  host: string;
  port: number;
}

function parseJsonDatagram(msg: Buffer): Record<string, unknown> | null {
  if (msg.length > MAX_DATAGRAM) return null;
  try {
    const value = JSON.parse(msg.toString("utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export interface DiscoveryResponder {
  close(): void;
}

/**
 * 守护进程侧：绑定发现端口、加入组播组，应答合法查询。每个源地址 10 秒内最多应答 10 次。
 * 绑定失败（端口被占、没有组播路由）不致命：返回 null，守护进程照常服务已配对对端。
 */
export function startDiscoveryResponder(
  info: { name: string; port: number; fingerprint: string; bind?: string },
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = () => {},
): Promise<DiscoveryResponder | null> {
  return new Promise((resolve) => {
    const socket: Socket = createSocket({ type: "udp4", reuseAddr: true });
    const recent = new Map<string, number[]>();
    let settled = false;
    socket.on("error", (error) => {
      log(`discovery socket error: ${error.message}`);
      if (!settled) {
        settled = true;
        socket.close();
        resolve(null);
      }
    });
    socket.on("message", (msg, rinfo) => {
      const query = parseJsonDatagram(msg);
      if (msg.length < MIN_QUERY_BYTES) return;
      if (query === null || query.ocs !== "lan-query" || query.v !== 1) return;
      if (typeof query.n !== "string" || !/^[0-9a-f]{16,32}$/.test(query.n)) return;
      const now = Date.now();
      if (!recent.has(rinfo.address) && recent.size >= RATE_TABLE_MAX) {
        for (const [addr, times] of recent) {
          if (times.every((t) => now - t >= 10_000)) recent.delete(addr);
        }
        // 表满且都在窗口内（有人伪造大量源地址）：新来源一律不应答，而不是清表放行。
        if (recent.size >= RATE_TABLE_MAX) return;
      }
      const hits = (recent.get(rinfo.address) ?? []).filter((t) => now - t < 10_000);
      if (hits.length >= 10) return;
      hits.push(now);
      recent.set(rinfo.address, hits);
      const reply = Buffer.from(JSON.stringify({
        ocs: "lan-here",
        v: 1,
        n: query.n,
        name: info.name,
        port: info.port,
        fp: info.fingerprint,
      }));
      socket.send(reply, rinfo.port, rinfo.address);
    });
    // 发现跟着 TCP 的监听地址走：只听回环的守护进程不该在局域网上应答（也不该触发防火墙
    // 询问）；绑了某张网卡的只在那张网卡上入组。
    const bind = info.bind ?? "0.0.0.0";
    const loopback = bind.startsWith("127.") || bind === "::1" || bind === "localhost";
    const wildcard = bind === "0.0.0.0" || bind === "::";
    socket.bind({ port: discoveryPort(env), address: loopback ? "127.0.0.1" : "0.0.0.0" }, () => {
      const ifaces = loopback ? [] : wildcard ? ipv4Interfaces() : [bind];
      for (const iface of ifaces) {
        try {
          socket.addMembership(DISCOVERY_GROUP, iface);
        } catch (error) {
          log(`discovery join ${iface} failed: ${(error as Error).message}`);
        }
      }
      settled = true;
      resolve({ close: () => socket.close() });
    });
  });
}

/**
 * 查询方：往每个 IPv4 接口各发一次组播查询（多网卡机器上默认接口不一定是局域网那张），
 * 收集 timeoutMs 内的应答。只收 nonce 对得上、字段合法的；同指纹同地址去重。
 */
export function scanLan(
  options: { timeoutMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscoveredInstance[]> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const nonce = randomBytes(8).toString("hex");
  const bare = JSON.stringify({ ocs: "lan-query", v: 1, n: nonce, pad: "" });
  const query = Buffer.from(JSON.stringify({ ocs: "lan-query", v: 1, n: nonce, pad: "0".repeat(MIN_QUERY_BYTES - bare.length) }));
  const port = discoveryPort(env);
  const found = new Map<string, DiscoveredInstance>();
  const onMessage = (msg: Buffer, rinfo: { address: string }) => {
    const reply = parseJsonDatagram(msg);
    if (reply === null || reply.ocs !== "lan-here" || reply.v !== 1 || reply.n !== nonce) return;
    if (typeof reply.name !== "string" || !PEER_LABEL_RE.test(reply.name)) return;
    if (typeof reply.fp !== "string" || !FINGERPRINT_RE.test(reply.fp)) return;
    const replyPort = reply.port;
    if (typeof replyPort !== "number" || !Number.isInteger(replyPort) || replyPort < 1 || replyPort > 65535) return;
    if (found.size >= MAX_SCAN_RESULTS) return;
    found.set(`${reply.fp}@${rinfo.address}:${replyPort}`, {
      name: reply.name,
      fingerprint: reply.fp,
      host: rinfo.address,
      port: replyPort,
    });
  };
  // 组播按接口各用一个 socket：共用一个 socket 轮流 setMulticastInterface 再 send，
  // send 是异步排队的，接口选项会在真正发出前被下一轮改掉。
  const plans: Array<{ bindAddr?: string; target: string; broadcast?: boolean }> = [];
  for (const target of discoveryTargets(env)) {
    if (target !== DISCOVERY_GROUP) {
      plans.push({ target });
      continue;
    }
    const ifaces = ipv4Interfaces();
    if (ifaces.length === 0) plans.push({ target });
    for (const iface of ifaces) plans.push({ bindAddr: iface, target });
    // 组播常被家用路由器（IGMP snooping、Wi-Fi 客户端间过滤）或 VPN 的 tun 路由吞掉；
    // 同时往子网定向广播发一份，应答照样按 nonce 和指纹筛，重复的去重。
    for (const { iface, broadcast } of ipv4Broadcasts()) plans.push({ bindAddr: iface, target: broadcast, broadcast: true });
  }
  const sockets: Socket[] = [];
  for (const plan of plans) {
    const socket = createSocket({ type: "udp4" });
    sockets.push(socket);
    socket.on("error", () => {
      try {
        socket.close();
      } catch {
        // 已关
      }
    });
    socket.on("message", onMessage);
    socket.bind({ port: 0, ...(plan.bindAddr === undefined ? {} : { address: plan.bindAddr }) }, () => {
      try {
        if (plan.broadcast === true) socket.setBroadcast(true);
        else if (plan.bindAddr !== undefined) socket.setMulticastInterface(plan.bindAddr);
        socket.send(query, port, plan.target);
      } catch {
        // 该接口不支持组播：跳过
      }
    });
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // 已关
        }
      }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}
