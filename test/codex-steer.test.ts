import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { steerCodexTurn, trustedDaemonSocket } from "../src/codex-steer.ts";

const THREAD = "01a11176-9a71-71c1-94df-c9a134c96a1b";
const TURN = "01a11176-ad63-7962-892a-2efc9cb0e0ad";

// UDS 路径有 104 字节上限，$TMPDIR 在 macOS 上太长：直接用 /tmp。
const dirs: string[] = [];
function shortDir(): string {
  const dir = mkdtempSync("/tmp/ocs-steer-");
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Reply = (request: { id: number; method: string; params: any }) => unknown | undefined;

/** 假守护进程：UDS 上的 WebSocket，按 reply 回 JSON-RPC；reply 返回 undefined 就不回。 */
function fakeDaemon(reply: Reply): { sock: string; seen: Array<{ method: string; params: any }> } {
  const dir = shortDir();
  const sock = join(dir, "d.sock");
  const seen: Array<{ method: string; params: any }> = [];
  const server = Bun.serve({
    unix: sock,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw));
        if (message.id === undefined) return; // initialized 通知
        seen.push({ method: message.method, params: message.params });
        if (message.method === "initialize") {
          ws.send(JSON.stringify({ method: "configWarning", params: { summary: "noise" } }));
          ws.send(JSON.stringify({ id: message.id, result: { userAgent: "fake" } }));
          return;
        }
        const answer = reply(message);
        if (answer !== undefined) ws.send(JSON.stringify({ id: message.id, ...(answer as object) }));
      },
    },
  });
  servers.push(server);
  return { sock, seen };
}

describe("codex-steer：回合进行中插入（#41）", () => {
  test("成功：发 turn/steer，带 expectedTurnId 和文本输入", async () => {
    const daemon = fakeDaemon(() => ({ result: { turnId: TURN } }));
    const result = await steerCodexTurn({
      threadId: THREAD,
      expectedTurnId: TURN,
      prompt: "[ocs wake] hi",
      env: { OCS_CODEX_DAEMON_SOCK: daemon.sock },
    });
    expect(result).toEqual({ ok: true, turnId: TURN });
    const steer = daemon.seen.find((s) => s.method === "turn/steer")!;
    expect(steer.params).toEqual({
      threadId: THREAD,
      expectedTurnId: TURN,
      input: [{ type: "text", text: "[ocs wake] hi", text_elements: [] }],
    });
  });

  test("宿主明确拒绝（回合已换）= rejected，调用方可以走别的载体", async () => {
    const daemon = fakeDaemon(() => ({ error: { code: -32600, message: "expected turn mismatch" } }));
    const result = await steerCodexTurn({
      threadId: THREAD,
      expectedTurnId: TURN,
      prompt: "x",
      env: { OCS_CODEX_DAEMON_SOCK: daemon.sock },
    });
    expect(result).toEqual({ ok: false, reason: "rejected", detail: "expected turn mismatch" });
  });

  test("steer 帧发出后没有应答 = unknown-outcome（绝不重放）", async () => {
    const daemon = fakeDaemon(() => undefined);
    const result = await steerCodexTurn({
      threadId: THREAD,
      expectedTurnId: TURN,
      prompt: "x",
      env: { OCS_CODEX_DAEMON_SOCK: daemon.sock },
      responseTimeoutMs: 200,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown-outcome");
  });

  test("没有守护进程 socket = unavailable，什么都没发", async () => {
    const dir = shortDir();
    const result = await steerCodexTurn({
      threadId: THREAD,
      expectedTurnId: TURN,
      prompt: "x",
      env: { OCS_CODEX_DAEMON_SOCK: join(dir, "missing.sock") },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unavailable");
  });

  test("socket 所在目录别人可写 = 不信任", () => {
    const daemon = fakeDaemon(() => undefined);
    expect(trustedDaemonSocket(daemon.sock)).not.toBeNull();
    chmodSync(join(daemon.sock, ".."), 0o777);
    expect(trustedDaemonSocket(daemon.sock)).toBeNull();
    chmodSync(join(daemon.sock, ".."), 0o700);
  });

  test("符号链接解析到真实 socket；指向普通文件的不算", () => {
    const daemon = fakeDaemon(() => undefined);
    const dir = shortDir();
    const link = join(dir, "link.sock");
    symlinkSync(daemon.sock, link);
    expect(trustedDaemonSocket(link)).toBe(daemon.sock);
    const plain = join(dir, "plain");
    writeFileSync(plain, "");
    expect(trustedDaemonSocket(plain)).toBeNull();
  });
});
