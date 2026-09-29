import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV } from "../src/claude-inject.ts";
import { OCS_HOME_ENV } from "../src/store.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();

// 真 CLI + 真脱离终端的守护进程 + 真 TCP/UDP，两台「机器」= 两个 OCS_HOME + 两个会话目录。
// 两边的「当前会话」都登记成本测试进程（CLI 的祖先，自身识别命中），各自一个收帧 socket。
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const T = 60_000;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

interface Box {
  env: Record<string, string>;
  frames: string[];
  server: Server;
}

function box(name: string, sessionName: string, sessionId: string, discoveryPort: number): Box {
  const dir = tempDir(`ocs-lancli-${name}-`);
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { mode: 0o700 });
  const sockPath = join(dir, "inbox.sock");
  const frames: string[] = [];
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
    });
    socket.on("end", () => {
      if (buf !== "") frames.push(buf);
    });
  });
  server.listen(sockPath);
  writeFileSync(
    join(sessionsDir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId, name: sessionName, cwd: "/work", status: "idle", messagingSocketPath: sockPath }),
    { mode: 0o600 },
  );
  const inherited = { ...process.env } as Record<string, string>;
  for (const key of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CODEX_THREAD_ID", "OCS_NAME", "OCS_PI_SESSION_ID"]) {
    delete inherited[key];
  }
  return {
    env: {
      ...inherited,
      [OCS_HOME_ENV]: join(dir, "home"),
      [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: sessionsDir,
      OCS_LANG: "en",
      OCS_UPGRADE_CHECK: "0",
      OCS_LAN_DISCOVERY_PORT: String(discoveryPort),
      OCS_LAN_DISCOVERY_TARGETS: "127.0.0.1",
    },
    frames,
    server,
  };
}

async function run(b: Box, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { env: b.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

async function waitFor<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const note = (frame: string) =>
  (JSON.parse(frame.trim().split("\n").at(-1)!) as { message: { content: string } }).message.content;

describe("ocs lan 端到端（两台机器）", () => {
  test("up → 发现配对 → dm 唤醒 → 复制 Reply 行回信 → 两边落同一 lan 频道 → down", async () => {
    const discovery = await freePort();
    const a = box("a", "worker-a", "aaaaaaaa-1111-2222-3333-444455556666", discovery);
    const b = box("b", "tester", "bbbbbbbb-1111-2222-3333-444455556666", discovery);
    const portA = await freePort();
    const portB = await freePort();
    try {
      // 在 Codex 会话里启动：守护进程不许继承会话身份，否则它把这个 task 当「自己」永不唤醒
      const upA = await run(
        { ...a, env: { ...a.env, CODEX_THREAD_ID: "019a0000-0000-7000-8000-000000000001", OCS_NAME: "leaky" } },
        ["lan", "up", "--port", String(portA), "--bind", "127.0.0.1", "--name", "alpha"],
      );
      expect(upA.stdout).toContain(`lan: daemon up as alpha on port ${portA}`);
      const daemonPid = (JSON.parse(readFileSync(join(a.env[OCS_HOME_ENV]!, "lan", "daemon.json"), "utf8")) as { pid: number }).pid;
      const daemonEnv = process.platform === "linux"
        ? readFileSync(`/proc/${daemonPid}/environ`, "utf8")
        : Bun.spawnSync(["ps", "-E", "-ww", "-o", "command=", "-p", String(daemonPid)]).stdout.toString();
      expect(daemonEnv).toContain("OCS_LAN_DISCOVERY_PORT="); // 确认真读到了环境
      expect(daemonEnv).not.toContain("CODEX_THREAD_ID=");
      expect(daemonEnv).not.toContain("OCS_NAME=");
      const upB = await run(b, ["lan", "up", "--port", String(portB), "--bind", "127.0.0.1", "--name", "bravo", "--no-discover"]);
      expect(upB.stdout).toContain("discovery off");

      // 发现：B 能看到 A（只有 A 应答发现）
      const scan = await run(b, ["lan", "scan", "--json"]);
      const found = JSON.parse(scan.stdout) as Array<{ name: string; port: number; paired_as: string | null }>;
      expect(found).toContainEqual(expect.objectContaining({ name: "alpha", port: portA, paired_as: null }));

      // A 出码并等待；B 兑码（不给 --addr，走发现）
      const issuer = Bun.spawn([process.execPath, CLI, "lan", "pair", "--label", "bee"], { env: a.env, stdout: "pipe", stderr: "pipe" });
      const reader = issuer.stdout.getReader();
      let issued = "";
      const code = await (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`issuer exited: ${issued}`);
          issued += new TextDecoder().decode(value);
          const match = /([0-9A-Z]{4}(?:-[0-9A-Z]{4}){5})/.exec(issued);
          if (match !== null) return match[1]!;
        }
      })();
      const joined = await run(b, ["lan", "pair", code]);
      expect(joined.code).toBe(0);
      expect(joined.stdout).toContain("paired with alpha");
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        issued += new TextDecoder().decode(value);
      }
      await issuer.exited;
      expect(issuer.exitCode).toBe(0);
      expect(issued).toContain("paired with bee (bravo)");

      // B（tester 会话）→ A 的 worker-a
      const dm = await run(b, ["dm", "worker-a@alpha", "ping over the lan"]);
      expect(dm.code).toBe(0);
      expect(dm.stdout).toContain("dm stored on remote → claude-aaaaaaaa@alpha");
      expect(dm.stdout).toContain("[alpha] wake: delivered to inbox");
      const localCopy = /local copy #(lan-[0-9a-f]{32}) seq 1/.exec(dm.stdout);
      expect(localCopy).not.toBeNull();
      const wake = note(await waitFor(() => a.frames[0]));
      expect(wake).toContain('from-name="claude-bbbbbbbb@bee"');
      expect(wake).toContain("ping over the lan");
      const replyLine = /Reply: (ocs dm \S+) "<your reply>"/.exec(wake);
      expect(replyLine?.[1]).toBe("ocs dm claude-bbbbbbbb@bee");

      // A 照 Reply 行回信 → B 的 tester 会话被唤醒，落在 B 发信时的同一个频道
      const reply = await run(a, ["dm", "claude-bbbbbbbb@bee", "pong"]);
      expect(reply.code).toBe(0);
      const wakeB = note(await waitFor(() => b.frames[0]));
      expect(wakeB).toContain('from-name="claude-aaaaaaaa@alpha"');
      expect(wakeB).toContain(`#${localCopy![1]}`);
      const read = await run(b, ["read", localCopy![1]!, "--include-self"]);
      expect(read.stdout).toContain("ping over the lan");
      expect(read.stdout).toContain("<claude-aaaaaaaa.alpha> pong");

      // 远端花名册
      const who = await run(b, ["who", "--lan"]);
      expect(who.stdout).toContain("LAN alpha (alpha):");
      expect(who.stdout).toContain("claude-aaaaaaaa@alpha  claude  idle  worker-a");

      // 解除配对后 A 再也进不了 B
      expect((await run(b, ["lan", "unpair", "alpha"])).code).toBe(0);
      const refused = await run(a, ["dm", "claude-bbbbbbbb@bee", "still there?"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("no longer trusts this machine");
    } finally {
      await run(a, ["lan", "down"]);
      await run(b, ["lan", "down"]);
      a.server.close();
      b.server.close();
    }
  }, T);
});
