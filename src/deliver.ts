// 投递阶梯（消息此前已落盘，这里只负责唤醒）。
//
// 本来内联在 cli.ts 里、直接 console.log + 改退出码；局域网守护进程收到远端 DM 后要走
// 同一条阶梯，但它的「输出」是回给发送方的应答，不是自己的 stdout。所以阶梯只认一个
// sink：CLI 的 sink 打印并设退出码，守护进程的 sink 收集行、算出总体结果回传。
// 分支和措辞与原来逐字一致——两个入口共用一份，免得一边修了另一边漂。

import type { NativeClaudeSession } from "./claude-inject.ts";
import { codexHosts, codexThreadLivePid, psTable, queueCodexThread } from "./codex-queue.ts";
import type { messages } from "./i18n.ts";
import { wakePiSession } from "./pi-sessions.ts";
import {
  CODEX_THREAD_ID_ENV,
  findCodexCmuxSurface,
  wakeCmuxSurface,
  type ResolvedDmTarget,
} from "./roster.ts";
import { wakeCodexTask, wakeNote, wakeSessions, type WakeNoteInput } from "./wake.ts";

export type Catalog = ReturnType<typeof messages>;
export type StoredDeliveryFailure = "failed" | "unknown";

export interface DeliverySink {
  log(line: string): void;
  /** 已落盘但唤醒失败 / 结果未知。调用方据此设退出码或回传 outcome。 */
  fail(outcome: StoredDeliveryFailure): void;
}

/** 守护进程用：把阶梯输出收集起来，最后给出一个总体结果（unknown > failed > ok）。 */
export function collectingSink(): DeliverySink & { lines: string[]; outcome(): "ok" | StoredDeliveryFailure } {
  const lines: string[] = [];
  let worst: "ok" | StoredDeliveryFailure = "ok";
  return {
    lines,
    log: (line) => lines.push(line),
    fail: (outcome) => {
      if (outcome === "unknown" || worst === "ok") worst = outcome;
    },
    outcome: () => worst,
  };
}

/**
 * #30：Desktop 明确没有投递时，若同一个 task 仍运行在唯一可验证的 cmux Codex surface，
 * 用同一条已落盘消息的 channel/seq 唤醒它。unknown-outcome 绝不能走这里，避免重复投递。
 */
function tryCodexCmuxFallback(
  targetThreadId: string,
  reason: string,
  wakeInput: Omit<WakeNoteInput, "receiver">,
  M: Catalog,
  sink: DeliverySink,
): boolean {
  if (reason !== "unavailable" && reason !== "not-open" && reason !== "no-source") return false;
  const surface = findCodexCmuxSurface(targetThreadId);
  if (surface === null) return false;
  const result = wakeCmuxSurface(
    surface.ref,
    wakeNote({
      ...wakeInput,
      receiver: `codex-${targetThreadId.slice(0, 8)}`,
      implicitReceiver: true,
    }),
  );
  if (!result.ok) return false;
  sink.log(M.codexCmuxFallback(targetThreadId, reason, surface.ref));
  return true;
}

/**
 * codex 目标的统一投递阶梯:
 *   1. `codex queue --thread` —— 官方 CLI 表面，按 thread 精确寻址，终端 TUI / Desktop 通吃，
 *      不需要 cmux，也不需要目标被 renderer 认领。先用 rollout fd 证明目标活着才发
 *      （queue 对死会话照样 exit=0，见 codex-queue.ts 的送达语义）。
 *   2. ChatGPT Desktop IPC —— 私有协议（铁律 5），保留作降级。
 *   3. cmux 按键注入 —— 最后兜底。
 * unknown-outcome 在任一层都立即停止：帧可能已写出，绝不重放（铁律 5）。
 * 返回 false 表示三层都没投出去，调用方按「仅落盘」处理。
 */
export async function deliverToCodexTask(
  targetThreadId: string,
  wakeInput: Omit<WakeNoteInput, "receiver">,
  M: Catalog,
  sink: DeliverySink,
  sourceThreadId?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  // 自我唤醒防回环：Claude（findSelfClaudePid）和 Pi（piWakeSelfSkipped）两条路都有，
  // codex 一直缺——以前 Desktop IPC 前置条件多不易触发，`codex queue` 又快又稳之后
  // 一个 @ 到自己的会话会把自己反复唤醒。
  const selfThreadId = env[CODEX_THREAD_ID_ENV];
  if (typeof selfThreadId === "string" && selfThreadId.toLowerCase() === targetThreadId.toLowerCase()) {
    sink.log(M.codexWakeSelfSkipped(targetThreadId));
    return true;
  }
  const ps = psTable(env);
  const livePid = codexThreadLivePid(targetThreadId, env, ps);
  // 载体按宿主选，不是一律 queue：
  //   * Desktop 托管的 task —— 先走 Desktop IPC。两条路都能送达并触发新 turn，但 IPC 在
  //     rollout 里留的是 `send_message_to_thread` + `<codex_delegation><source_thread_id>`
  //     原生来源信封，queue 留下的是普通 `UserMessage`——会把别的 agent 发来的消息呈现成
  //     「用户自己敲的」。跨会话内容必须看得出是数据而不是用户指令（Claude 侧用原生
  //     "Message from X" 包装是同一个理由），所以 Desktop 上不拿来源换便利。
  //   * 其它宿主（终端 TUI）—— IPC 根本够不着，queue 是唯一的路。
  const desktopHosted = livePid !== null && codexHosts([livePid], env, ps).get(livePid)?.app === "ChatGPT";
  if (livePid !== null && !desktopHosted) {
    const queued = queueCodexThread({
      threadId: targetThreadId,
      livePid,
      prompt: wakeNote({
        ...wakeInput,
        receiver: `codex-${targetThreadId.slice(0, 8)}`,
        implicitReceiver: true,
      }),
    });
    if (queued.ok) {
      sink.log(M.codexQueued(queued.threadId, queued.pid, queued.messageId));
      return true;
    }
    if (queued.reason === "unknown-outcome") {
      sink.log(M.codexUnknownOutcome(queued.detail ?? ""));
      sink.fail("unknown");
      return true; // 已上报，不再往下投，避免重复送达
    }
    sink.log(M.codexQueueSkipped(targetThreadId, queued.reason, queued.detail ?? ""));
  }
  const result = await wakeCodexTask({
    targetThreadId,
    ...(sourceThreadId !== undefined ? { sourceThreadId } : {}),
    ...wakeInput,
  });
  if (result.ok) {
    sink.log(M.codexAccepted(result.targetThreadId, result.turnId));
    return true;
  }
  if (result.reason === "unknown-outcome") {
    sink.log(M.codexUnknownOutcome(result.detail ?? ""));
    sink.fail("unknown");
    return true;
  }
  if (tryCodexCmuxFallback(targetThreadId, result.reason, wakeInput, M, sink)) {
    // cmux 只复用同一 channel/seq 做唤醒，没有再次落盘。
    return true;
  }
  // Desktop 托管但 IPC 投不进（没被 renderer 认领等）时，queue 仍是可用的最后一级：
  // 丢掉原生来源信封总好过完全投不到——正文里本来就带着 `[ocs wake] X mentioned you`。
  if (desktopHosted && livePid !== null) {
    const queued = queueCodexThread({
      threadId: targetThreadId,
      livePid,
      prompt: wakeNote({
        ...wakeInput,
        receiver: `codex-${targetThreadId.slice(0, 8)}`,
        implicitReceiver: true,
      }),
    });
    if (queued.ok) {
      sink.log(M.codexQueued(queued.threadId, queued.pid, queued.messageId));
      return true;
    }
    if (queued.reason === "unknown-outcome") {
      sink.log(M.codexUnknownOutcome(queued.detail ?? ""));
      sink.fail("unknown");
      return true;
    }
  }
  sink.log(M.codexFailed(result.reason, result.detail ?? ""));
  sink.fail("failed");
  return false;
}

export interface DmDeliveryInput {
  resolved: ResolvedDmTarget;
  /** 用户敲的目标串（提示文案用）。 */
  target: string;
  channel: string;
  /** 本条消息在频道里是不是第一条（停靠文案区分新旧频道）。 */
  firstMessage: boolean;
  /** 有稳定工作区 pair 时停靠文案不同（重启后仍会被 inbox 认出来）。 */
  stableChannel: boolean;
  wakeInput: Omit<WakeNoteInput, "receiver">;
  /** Claude DM 的 Reply 行目标；null 时用频道 send --reply-to 形式。 */
  dmReplyTarget: string | null;
  /** Pi / cmux / codex 的 Reply 行目标（远端 DM 需要 `x@peer`，本地 DM 不传）。 */
  anyReplyTarget?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * 一条已落盘 DM 按目标种类唤醒。返回被唤醒的 Claude 会话（调用方据此挂 idle 订阅），
 * 其它种类返回 null。
 */
export async function deliverDm(
  input: DmDeliveryInput,
  M: Catalog,
  sink: DeliverySink,
): Promise<NativeClaudeSession | null> {
  const { resolved, target, channel } = input;
  const env = input.env ?? process.env;
  const anyReply = input.anyReplyTarget === undefined ? {} : { dmReplyTarget: input.anyReplyTarget };
  if (resolved.kind === "claude") {
    if (resolved.claude === undefined) {
      // 目标此刻不在线：一次性会话名重启后不会主动读这条频道，文案不许暗示会自动送达。
      sink.log(
        !input.stableChannel
          ? (input.firstMessage ? M.dmParkedNew(target, channel) : M.dmParked(target, channel))
          : M.dmParkedStable(target, channel),
      );
      return null;
    }
    const [outcome] = await wakeSessions([resolved.claude], {
      ...input.wakeInput,
      ...(input.dmReplyTarget !== null ? { dmReplyTarget: input.dmReplyTarget } : {}),
      env,
    });
    const label = `${resolved.claude.name ?? "?"}(pid ${resolved.claude.pid})`;
    if (outcome!.result.ok) sink.log(M.wakeDelivered(label));
    else {
      const failure = outcome!.result;
      sink.log(M.wakeFailed(label, failure.detail === undefined ? failure.reason : `${failure.reason} (${failure.detail})`));
      sink.fail("failed");
    }
    return resolved.claude;
  }
  if (resolved.kind === "codex-task" && resolved.threadId !== undefined) {
    await deliverToCodexTask(resolved.threadId, { ...input.wakeInput, ...anyReply }, M, sink, undefined, env);
    return null;
  }
  if (resolved.kind === "pi" && resolved.piSessionId !== undefined) {
    if (resolved.piSession === undefined) {
      sink.log(M.dmPiParked(target, channel));
      return null;
    }
    const result = await wakePiSession(
      resolved.piSession,
      wakeNote({ ...input.wakeInput, ...anyReply, receiver: resolved.name, implicitReceiver: true }),
    );
    if (result.ok) sink.log(M.piWakeAccepted(resolved.name));
    else if (result.reason === "unknown-outcome") {
      sink.log(M.piWakeUnknownOutcome(resolved.name, result.detail ?? ""));
      sink.fail("unknown");
    } else {
      sink.log(M.piWakeFailed(resolved.name, result.reason, result.detail ?? ""));
      sink.fail("failed");
    }
    return null;
  }
  if (resolved.kind === "cmux" && resolved.cmuxRef !== undefined) {
    // cmux surface 没有 ocs 名字：Reply:/Thread: 的 --as 用 dm 同款派生名 surface-N。
    const result = wakeCmuxSurface(
      resolved.cmuxRef,
      wakeNote({ ...input.wakeInput, ...anyReply, receiver: resolved.name }),
    );
    if (result.ok) sink.log(M.dmCmuxWoken(result.ref));
    else if (result.reason === "busy") {
      sink.log(M.dmCmuxBusy(resolved.cmuxRef));
      sink.fail("failed");
    } else {
      sink.log(M.dmCmuxFailed(resolved.cmuxRef, result.detail ?? result.reason));
      sink.fail("failed");
    }
  }
  return null;
}
