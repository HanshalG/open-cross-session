// Claude Code 原生投递回执（peer_message_status）的接收端。ocs 自有模块，不是 vendored 文件。
//
// 协议（Claude Code 2.1.285 真机实测，未文档化私有面，可能随版本变）：
// user 帧带 `from: "uds:<path>"` 和 `msg_id` 时，接收端会把这条消息的归宿作为 JSONL 控制帧
// 连到 <path> 写回来：
//   {"type":"control","action":"peer_message_status","status":<s>,"reason":"…",
//    "from":"uds:<接收端 sock>","orig_msg_id":"<我们的 msg_id>","msgV":1,"msg_id":"…"}
// - `held`：crossSessionInbound 闸门把它扣下了（实测写入后 30–50 ms 到）；之后还会有一条终态：
//   `delivered`（有人点了投递）或 `expired`（5 分钟超时 / 待审队列被挤 / 会话退出）。
// - 拒绝在线上是 `status:"expired", status_detail:"refused"`；队列满是 `dropped`（带 drop_reason）；
//   另有 `denied`。
// - 策略是 accept 时**一条回执都不发**，消息直接进对话。所以「窗口内没有回执」只能读作
//   「协议没报告被扣 / 被拒」，不是「对方读了」。
//
// 接收端对回执地址的校验决定了这里的形状：
// - 地址必须是 `uds:` + 匹配 /^\/\S*\.sock$/ 的路径，并且和接收端自己的 socket **同目录**
//   （我们走这一条：/tmp/cc-socks/<16 hex>.sock 挨着 /tmp/cc-socks/<pid>.sock）。
// - 回执按「写入那条消息的进程 pid」发（socket 对端凭据），所以**写帧的进程必须就是监听这个
//   socket 的进程**，而且要活到终态回执到来——这就是唤醒要放进独立 helper 进程的原因
//   （src/wake-helper.ts）。
//
// 「Claude 的目录只读消费」的唯一例外在这里：我们在 Claude 的 socket 目录里建**一个**临时
// socket 文件（0600），用完必删（close() + 进程退出钩子；SIGKILL 留下的由
// src/wake-receipt.ts 的 sweepWakeJobs 按登记清理）。除此之外不建、不改、不删那个目录里的任何东西。
// Windows 上回执地址得是命名管道，还要带我们不该发布的认证材料——不做，调用方保持旧行为。

import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";

/** 写帧后等第一条回执的窗口。实测 held 在 30–50 ms 内到；给一个数量级的余量。 */
export const RECEIPT_FIRST_WINDOW_MS = 400;
export const RECEIPT_FIRST_WINDOW_MS_ENV = "OCS_RECEIPT_FIRST_WINDOW_MS";
/** Claude 待审队列的保留时长：5 分钟无人 Deliver 即丢。 */
export const CLAUDE_HOLD_TTL_MS = 5 * 60 * 1000;
/** 等终态回执的额外余量（接收端定时器抖动、事件循环忙）。 */
export const RECEIPT_TERMINAL_MARGIN_MS = 60 * 1000;
/** 覆盖「hold TTL + 余量」的总等待时长（测试用）。 */
export const RECEIPT_TERMINAL_WAIT_MS_ENV = "OCS_RECEIPT_TERMINAL_WAIT_MS";

/** 单条回执连接最多缓冲这么多字节；回执帧只有几百字节。 */
const RECEIPT_MAX_BYTES = 64 * 1024;
const RECEIPT_REASON_MAX = 200;
/** 接收端对回执路径的形状要求。 */
const REPLY_PATH_RE = /^\/\S*\.sock$/;
/** vendored wrapCrossSessionMessage 的 from 属性字符集（`uds:` + path 整体要过）。 */
const FROM_ATTR_RE = /^[A-Za-z0-9%:_/.\-]+$/;

export type PeerReceiptStatus = "held" | "delivered" | "expired" | "refused" | "dropped" | "denied";

export interface PeerReceipt {
  status: PeerReceiptStatus;
  /** 接收端给的原因，压成一行、限长。对方可控文本，只当数据。 */
  reason?: string;
}

function oneLine(text: string): string {
    return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, RECEIPT_REASON_MAX);
}

/**
 * 解析一行回执。不是回执 / 不是给这条消息的 / 状态不认识 → null。
 * `orig_msg_id` 必须逐字等于我们写出去的 msg_id：那个 socket 同 uid 的进程都能连，
 * 而且同一个 helper 只关心自己那一条——对不上的一律丢。
 */
export function parsePeerReceipt(line: string, msgId: string): PeerReceipt | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (frame.type !== "control" || frame.action !== "peer_message_status") return null;
  if (frame.orig_msg_id !== msgId) return null;
  const raw = frame.status;
  let status: PeerReceiptStatus;
  if (raw === "expired" && frame.status_detail === "refused") status = "refused"; // 线上形态
  else if (
    raw === "held" || raw === "delivered" || raw === "expired" ||
    raw === "refused" || raw === "dropped" || raw === "denied"
  ) status = raw;
  else return null;
  const parts = [frame.reason, frame.drop_reason]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .map(oneLine);
  const reason = oneLine([...new Set(parts)].join(" — "));
  return reason === "" ? { status } : { status, reason };
}

export interface ReceiptListener {
  /** 回执 socket 的路径（填进帧的 `from`，不带 `uds:` 前缀）。 */
  path: string;
  /** 取下一条匹配的回执；超时返回 null。已到未取的先出。 */
  next(timeoutMs: number): Promise<PeerReceipt | null>;
  /** 关监听、断开所有连接、删 socket 文件。可重复调用。 */
  close(): void;
}

export type OpenReceiptListenerResult =
  | { ok: true; listener: ReceiptListener }
  | { ok: false; reason: string };

/**
 * 在目标 socket 的同目录下选一个回执路径，并校验它过得了接收端和 vendored 注入模块的检查。
 * 返回 null 的理由走 reason。只做检查，不建文件。
 */
export function replySocketPathFor(
  targetSocketPath: string,
  platform: NodeJS.Platform = process.platform,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (platform === "win32") return { ok: false, reason: "receipts are not supported on Windows" };
  if (!isAbsolute(targetSocketPath)) return { ok: false, reason: "target socket path is not absolute" };
  const dir = dirname(targetSocketPath);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    return { ok: false, reason: `socket directory unreadable: ${String(error)}` };
  }
  // 和 vendored 模块别处同一套：真目录、非符号链接、属本 uid。别人的目录里不建文件。
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { ok: false, reason: "socket directory is not a real directory" };
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    return { ok: false, reason: `socket directory owned by uid ${stat.uid}` };
  }
  const path = join(dir, `${randomBytes(8).toString("hex")}.sock`);
  if (!REPLY_PATH_RE.test(path) || !FROM_ATTR_RE.test(`uds:${path}`)) {
    return { ok: false, reason: "reply socket path would be rejected by the receiver" };
  }
  return { ok: true, path };
}

/**
 * 建回执监听。任何一步失败都返回 { ok:false }——调用方回落到不带 `from` 的旧路径，绝不因为
 * 回执建不起来而不投消息。
 */
export function openReceiptListener(
  targetSocketPath: string,
  msgId: string,
  platform: NodeJS.Platform = process.platform,
): Promise<OpenReceiptListenerResult> {
  const chosen = replySocketPathFor(targetSocketPath, platform);
  if (!chosen.ok) return Promise.resolve(chosen);
  const path = chosen.path;
  const queue: PeerReceipt[] = [];
  const waiters: Array<(receipt: PeerReceipt | null) => void> = [];
  const connections = new Set<Socket>();
  let closed = false;

  const push = (receipt: PeerReceipt) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(receipt);
    else queue.push(receipt);
  };
  const consume = (line: string) => {
    if (line.trim() === "") return;
    const receipt = parsePeerReceipt(line, msgId);
    if (receipt !== null) push(receipt);
  };
  const server: Server = createServer((socket) => {
    connections.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > RECEIPT_MAX_BYTES) {
        socket.destroy();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    const flush = () => {
      connections.delete(socket);
      if (buffer !== "") consume(buffer); // 末行没带换行也认
      buffer = "";
    };
    socket.on("end", flush);
    socket.on("close", flush);
    socket.on("error", () => connections.delete(socket));
  });

  const removeFile = () => {
    try {
      // 只删我们自己建的那个 socket：是 socket 才删，别的东西占了这个名字就不碰。
      if (lstatSync(path).isSocket()) unlinkSync(path);
    } catch {
      // 已经没了
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    (process as NodeJS.EventEmitter).removeListener("exit", removeFile);
    for (const socket of connections) socket.destroy();
    connections.clear();
    try {
      server.close();
    } catch {
      // 没监听起来
    }
    removeFile();
    for (const waiter of waiters.splice(0)) waiter(null);
  };

  return new Promise((resolve) => {
    let settled = false;
    // bind 时文件就按 umask 建出来：先收紧再放回，别留一个 0755 的窗口。
    const previousUmask = process.umask(0o177);
    const restoreUmask = () => process.umask(previousUmask);
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      restoreUmask();
      close();
      resolve({ ok: false, reason });
    };
    server.once("error", (error) => fail(`listen failed: ${String(error)}`));
    try {
      server.listen(path, () => {
        if (settled) return;
        restoreUmask();
        try {
          chmodSync(path, 0o600);
          const stat = lstatSync(path);
          if (!stat.isSocket() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
            throw new Error("reply socket is not ours");
          }
        } catch (error) {
          fail(`reply socket setup failed: ${String(error)}`);
          return;
        }
        settled = true;
        process.once("exit", removeFile);
        resolve({
          ok: true,
          listener: {
            path,
            next: (timeoutMs) =>
              new Promise<PeerReceipt | null>((done) => {
                const ready = queue.shift();
                if (ready !== undefined) {
                  done(ready);
                  return;
                }
                if (closed || timeoutMs <= 0) {
                  done(null);
                  return;
                }
                let finished = false;
                const waiter = (receipt: PeerReceipt | null) => {
                  if (finished) return;
                  finished = true;
                  clearTimeout(timer);
                  done(receipt);
                };
                const timer = setTimeout(() => {
                  const index = waiters.indexOf(waiter);
                  if (index >= 0) waiters.splice(index, 1);
                  waiter(null);
                }, timeoutMs);
                waiters.push(waiter);
              }),
            close,
          },
        });
      });
    } catch (error) {
      fail(`listen failed: ${String(error)}`);
    }
  });
}

function msFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = Number(env[key]);
  return Number.isInteger(raw) && raw >= 1 ? raw : fallback;
}

export function receiptFirstWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  return msFromEnv(env, RECEIPT_FIRST_WINDOW_MS_ENV, RECEIPT_FIRST_WINDOW_MS);
}

export function receiptTerminalWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return msFromEnv(env, RECEIPT_TERMINAL_WAIT_MS_ENV, CLAUDE_HOLD_TTL_MS + RECEIPT_TERMINAL_MARGIN_MS);
}
