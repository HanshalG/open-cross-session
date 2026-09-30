// `ocs _claude-wake <job-id>`：脱离终端的 Claude 唤醒 helper（内部命令，不进 help）。
//
// 一个 helper 只管一条消息对一个目标的一次唤醒（docs/wake-protocol.md §6）：
//   建回执监听 → 写帧（带 from + msg_id）→ 等第一条回执（≈400 ms）→ 往 stdout 报一行 →
//   - 没有回执：accepted，退出；
//   - held：继续等终态，最长「hold TTL + 余量」；
//   - 其它（refused / dropped / denied / expired / delivered）：退出。
// held 的终态：delivered 只记录；没送达（expired / refused / dropped / denied / 到点没回执
// = unknown）记录后**通知发送方一次**，然后退出——和 notify-when-idle 同一条一次性纪律
// （铁律 8）。通知本身走不带回执的注入，不会再派 helper。
//
// 写帧的进程必须就是监听回执 socket 的进程（接收端按写入方 pid 回发），所以这两件事都在这里做，
// CLI 只读结果。任何一步建不起回执 → 退回不带 `from` 的旧注入，报 plain。

import { injectChannelMessage, resolveSessionSocketByPid } from "./claude-inject.ts";
import {
  openReceiptListener,
  receiptFirstWindowMs,
  receiptTerminalWaitMs,
  type PeerReceipt,
  type ReceiptListener,
} from "./claude-receipt.ts";
import { collectingSink, deliverNotice } from "./deliver.ts";
import { messages } from "./i18n.ts";
import { appendReceipt, type OcsReceiptStatus } from "./store.ts";
import { neutralizeWakeBody } from "./wake.ts";
import { loadWakeJob, removeWakeJob, saveWakeJob, type FirstPhase, type WakeJob } from "./wake-receipt.ts";

/** 等终态期间多久看一眼目标还在不在。 */
export const RECEIPT_TARGET_POLL_MS = 2000;
export const RECEIPT_TARGET_POLL_MS_ENV = "OCS_RECEIPT_TARGET_POLL_MS";
/** 连续这么多次看不到目标会话才认定它没了（同 IDLE_GONE_CONFIRMATIONS 的理由：文件会瞬时读不到）。 */
const TARGET_GONE_CONFIRMATIONS = 3;

export interface WakeHelperResult {
  first: FirstPhase;
  /** held 之后的终态；没进第二阶段为 null。 */
  terminal: { status: OcsReceiptStatus; reason?: string } | null;
  notified: boolean;
}

export interface WakeHelperOptions {
  env?: NodeJS.ProcessEnv;
  /** 第一阶段结果的去向；默认写 stdout（CLI 在读）。 */
  report?: (line: string) => void;
}

function record(job: WakeJob, status: OcsReceiptStatus, detail: string | undefined, env: NodeJS.ProcessEnv): void {
  try {
    appendReceipt({
      channel: job.channel,
      seq: job.seq,
      to: job.target.name,
      status,
      ...(detail === undefined ? {} : { detail }),
      env,
    });
  } catch {
    // 旁车帧只是展示信息：写不进去（锁超时、磁盘满）不许影响唤醒本身和对发送方的报告。
  }
}

export async function runWakeHelper(id: string, options: WakeHelperOptions = {}): Promise<WakeHelperResult | null> {
  const env = options.env ?? process.env;
  const job = loadWakeJob(id, env);
  if (job === null) return null;
  let reported = false;
  // CLI 等不及（超时）会关掉管道读端：之后这一行写出去是 EPIPE。那只是「没人听了」，
  // 绝不能让它把一个还要等 5 分钟终态的 helper 带崩。
  if (options.report === undefined) process.stdout.on("error", () => {});
  const report = (first: FirstPhase) => {
    if (reported) return;
    reported = true;
    const line = `${JSON.stringify(first)}\n`;
    if (options.report !== undefined) options.report(line);
    else {
      try {
        process.stdout.write(line);
      } catch {
        // CLI 已经不读了（超时退出）；结果仍会进旁车帧
      }
    }
  };
  let listener: ReceiptListener | null = null;
  const stop = () => {
    listener?.close();
    removeWakeJob(id, env);
    process.exit(0);
  };
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const signal of signals) process.once(signal, stop);
  try {
    const inject = (extra: { fromSock?: string; msgId?: string }) =>
      injectChannelMessage({
        name: job.target.name,
        pid: job.target.pid,
        sessionId: job.target.sessionId,
        body: job.note,
        fromName: job.fromName,
        ...extra,
        env,
      });
    const failed = (result: { reason: string; detail?: string }): WakeHelperResult => {
      const first: FirstPhase = {
        kind: "failed",
        reason: result.reason,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      };
      report(first);
      return { first, terminal: null, notified: false };
    };

    const resolved = resolveSessionSocketByPid(job.target.pid, { expectSessionId: job.target.sessionId, env });
    if (!resolved.ok) return failed({ reason: resolved.reason });
    const opened = await openReceiptListener(resolved.session.messagingSocketPath, job.msgId);
    if (!opened.ok) {
      // 回执建不起来：旧路径，旧措辞。不带 from，接收端不会回任何东西。
      const result = await inject({});
      if (!result.ok) return failed(result);
      const first: FirstPhase = { kind: "plain" };
      report(first);
      return { first, terminal: null, notified: false };
    }
    listener = opened.listener;
    saveWakeJob({ ...job, helperPid: process.pid, replySock: listener.path }, env);

    const result = await inject({ fromSock: listener.path, msgId: job.msgId });
    if (!result.ok) return failed(result);

    const initial = await listener.next(receiptFirstWindowMs(env));
    if (initial === null) {
      record(job, "accepted", undefined, env);
      const first: FirstPhase = { kind: "receipt", status: "accepted" };
      report(first);
      return { first, terminal: null, notified: false };
    }
    record(job, initial.status, initial.reason, env);
    const first: FirstPhase = {
      kind: "receipt",
      status: initial.status,
      ...(initial.reason === undefined ? {} : { reason: initial.reason }),
    };
    report(first);
    if (initial.status !== "held") return { first, terminal: null, notified: false };

    const terminal = await waitForTerminal(job, listener, env);
    record(job, terminal.status, terminal.reason, env);
    // 回执监听到此为止：通知之前就关掉，通知失败/卡住也不会把 socket 文件留在 Claude 的目录里。
    listener.close();
    listener = null;
    let notified = false;
    if (terminal.status !== "delivered") notified = await notifySender(job, terminal, env);
    // 一次性：通知过就结束，后面再来什么回执都不管（监听已关）。
    return { first, terminal, notified };
  } finally {
    for (const signal of signals) (process as NodeJS.EventEmitter).removeListener(signal, stop);
    listener?.close();
    removeWakeJob(id, env);
  }
}

async function waitForTerminal(
  job: WakeJob,
  listener: ReceiptListener,
  env: NodeJS.ProcessEnv,
): Promise<{ status: OcsReceiptStatus; reason?: string }> {
  const deadline = Date.now() + receiptTerminalWaitMs(env);
  const rawPoll = Number(env[RECEIPT_TARGET_POLL_MS_ENV]);
  const pollMs = Number.isInteger(rawPoll) && rawPoll >= 10 ? rawPoll : RECEIPT_TARGET_POLL_MS;
  let gone = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { status: "unknown", reason: "no terminal receipt before the hold deadline" };
    }
    const receipt: PeerReceipt | null = await listener.next(Math.min(remaining, pollMs));
    if (receipt !== null) {
      if (receipt.status === "held") continue; // 重复的 held 不是终态
      return receipt;
    }
    // 会话正常退出会发 expired；被 kill -9 的什么都不发——不值得空等满 6 分钟。
    const alive = resolveSessionSocketByPid(job.target.pid, { expectSessionId: job.target.sessionId, env }).ok;
    gone = alive ? 0 : gone + 1;
    if (gone >= TARGET_GONE_CONFIRMATIONS) {
      return { status: "unknown", reason: "receiver session is gone and sent no terminal receipt" };
    }
  }
}

async function notifySender(
  job: WakeJob,
  terminal: { status: OcsReceiptStatus; reason?: string },
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const sender = job.sender;
  if (sender === null) return false;
  // 自我唤醒防回环：发送方就是被唤醒的那个会话时（正常路径到不了这里），不许给它再塞一条。
  if (sender.kind === "claude" && sender.pid === job.target.pid) return false;
  const M = messages(job.lang);
  const note = M.deliveryNotice({
    seq: job.seq,
    target: job.target.name,
    channel: job.channel,
    status: terminal.status,
    // reason 是接收端给的文本：当数据处理，不许冒充包装或协议行。
    reason: neutralizeWakeBody(terminal.reason ?? ""),
  });
  const sink = collectingSink();
  try {
    await deliverNotice(sender, note, { channel: job.channel, seq: job.seq, lang: job.lang }, M, sink, env);
  } catch {
    return false;
  }
  return sink.outcome() === "ok";
}
