import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV } from "../src/claude-inject.ts";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  findHermesHost,
  hermesIdentity,
  hermesSessionKeyFromTarget,
  hermesTargetName,
  listHermesSessions,
  selfHermesSessionKey,
  wakeHermesSession,
} from "../src/hermes.ts";
import { localAddressOf, handleLanDm } from "../src/lan-daemon.ts";
import { isReservedOcsName } from "../src/names.ts";
import { buildRoster, resolveDmTarget, resolveSelfName, selfIdentity, selfNameOwner } from "../src/roster.ts";
import { NAME_RE, OCS_IDENTITY_RE, readMessages } from "../src/store.ts";
import { splitWakeMentions } from "../src/wake.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();

const KEY = "20261006_124023_6626fe";
const ADDRESS = "hermes-20261006.124023.6626fe";
const TOKEN = "tok-" + "x".repeat(39);

interface Call {
  method: string;
  params: Record<string, unknown>;
}

interface FakeHermes {
  dir: string;
  env: Record<string, string>;
  calls: Call[];
  stop(): void;
}

type Responder = (call: Call) => unknown | "drop";

const hosts: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.stop();
});

/** A Hermes session host speaking just enough of the gateway WebSocket protocol. */
function fakeHermes(options: {
  sessions?: Array<{ id: string; session_key: string; title?: string; status?: string }>;
  submit?: Responder;
  token?: string;
  record?: Record<string, unknown>;
} = {}): FakeHermes {
  const token = options.token ?? TOKEN;
  const calls: Call[] = [];
  const sessions = options.sessions ?? [{ id: "497375b4", session_key: KEY, title: "auth review", status: "idle" }];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== "/api/ws" || url.searchParams.get("token") !== token) return new Response("no", { status: 401 });
      return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } }));
      },
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as { id: number; method: string; params: Record<string, unknown> };
        const call = { method: frame.method, params: frame.params };
        calls.push(call);
        let result: unknown;
        if (frame.method === "session.active_list") result = { sessions };
        else if (frame.method === "prompt.submit") result = (options.submit ?? (() => ({ status: "streaming", user_row_id: 1 })))(call);
        else result = { error: { code: -32601, message: "unknown method" } };
        if (result === "drop") {
          ws.close();
          return;
        }
        const error = (result as { error?: unknown })?.error;
        ws.send(JSON.stringify(error !== undefined
          ? { jsonrpc: "2.0", id: frame.id, error }
          : { jsonrpc: "2.0", id: frame.id, result }));
      },
    },
  });
  hosts.push(server);
  const dir = tempDir("ocs-hermes-");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = {
    role: "desktop-serve",
    pid: process.pid,
    host: "127.0.0.1",
    port: server.port,
    protocolVersion: 1,
    tokenFingerprint: createHash("sha256").update(token).digest("hex").slice(0, 16),
    profiles: ["default"],
    ...options.record,
  };
  writeFileSync(join(dir, "host-desktop-serve.json"), JSON.stringify(record), { mode: 0o600 });
  writeFileSync(join(dir, "host-desktop-serve.token"), token, { mode: 0o600 });
  return {
    dir,
    env: { HERMES_GATEWAY_LOCK_DIR: dir, OCS_HOME: join(dir, "ocs-home") },
    calls,
    stop: () => server.stop(true),
  };
}

describe("Hermes addresses", () => {
  test("session keys map losslessly onto ocs names (no `_` in NAME_RE)", () => {
    expect(hermesTargetName(KEY)).toBe(ADDRESS);
    expect(NAME_RE.test(ADDRESS)).toBe(true);
    expect(hermesSessionKeyFromTarget(ADDRESS)).toBe(KEY);
    expect(hermesSessionKeyFromTarget(`hermes-${KEY}`)).toBeNull(); // one spelling only
    expect(hermesSessionKeyFromTarget("hermes-x")).toBeNull();
    expect(hermesIdentity(KEY)).toBe("hermes:20261006.124023.6626fe");
    expect(OCS_IDENTITY_RE.test(hermesIdentity(KEY))).toBe(true);
    expect(selfIdentity(ADDRESS)).toBe(hermesIdentity(KEY));
    expect(isReservedOcsName(ADDRESS)).toBe(true);
    const cron = "cron_a1b2c3d4e5f6_20261001_120000_000001";
    expect(hermesSessionKeyFromTarget(hermesTargetName(cron))).toBe(cron);
    expect(NAME_RE.test(hermesTargetName(cron))).toBe(true);
  });

  test("a Hermes terminal command knows its session; a stray HERMES_SESSION_ID alone does not count", () => {
    const env = {
      HERMES_SESSION_ID: KEY,
      HERMES_SESSION_SOURCE: "desktop",
      OCS_HOME: tempDir("ocs-hermes-self-"),
      // this test itself may run under Claude Code: no live Claude sessions here
      [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: tempDir("ocs-hermes-claude-"),
    };
    expect(selfHermesSessionKey(env)).toBe(KEY);
    expect(resolveSelfName(env)).toBe(ADDRESS);
    expect(selfNameOwner(env)).toEqual({ kind: "hermes", id: KEY });
    expect(selfHermesSessionKey({ HERMES_SESSION_ID: KEY })).toBeNull();
    // Claude/Codex started from a Hermes terminal inherit HERMES_SESSION_ID: their own identity wins.
    const codex = "019a0000-0000-7000-8000-000000000001";
    expect(resolveSelfName({ ...env, CODEX_THREAD_ID: codex })).toBe(codex);
  });

  test("dm targets and @mentions route to Hermes", () => {
    expect(resolveDmTarget(ADDRESS, { OCS_HOME: tempDir("ocs-hermes-dm-") })).toEqual({
      kind: "hermes",
      name: ADDRESS,
      identity: hermesIdentity(KEY),
      hermesSessionKey: KEY,
    });
    expect(splitWakeMentions([ADDRESS, "claude-worker"])).toEqual({
      claudeNames: ["claude-worker"],
      codexThreads: [],
      piTargets: [],
      hermesTargets: [ADDRESS],
    });
  });
});

describe("Hermes host discovery", () => {
  test("lists open sessions through the published loopback host", async () => {
    const hermes = fakeHermes();
    const listing = await listHermesSessions({ env: hermes.env });
    expect(listing).toEqual({
      available: true,
      host: { role: "desktop-serve", pid: process.pid },
      sessions: [{ key: KEY, runtimeId: "497375b4", title: "auth review", status: "idle" }],
    });
    const roster = buildRoster(hermes.env, listing.available ? listing.sessions : []);
    expect(roster.entries.filter((e) => e.kind === "hermes")).toEqual([
      { kind: "hermes", target: ADDRESS, sessionKey: KEY, title: "auth review", status: "idle", self: false },
    ]);
  });

  test("refuses a token that does not match the record's fingerprint", () => {
    const hermes = fakeHermes();
    writeFileSync(join(hermes.dir, "host-desktop-serve.token"), "someone-elses-token", { mode: 0o600 });
    const found = findHermesHost(hermes.env);
    expect(found.ok).toBe(false);
  });

  test("never sends the token to a non-loopback host", () => {
    const hermes = fakeHermes({ record: { host: "192.168.0.9" } });
    const found = findHermesHost(hermes.env);
    expect(found).toMatchObject({ ok: false });
    expect(found.ok ? "" : found.reason).toContain("not loopback");
  });

  test("refuses group/world-readable record or token files", () => {
    const hermes = fakeHermes();
    chmodSync(join(hermes.dir, "host-desktop-serve.token"), 0o644);
    expect(findHermesHost(hermes.env, "darwin").ok).toBe(false);
    chmodSync(join(hermes.dir, "host-desktop-serve.token"), 0o600);
    chmodSync(join(hermes.dir, "host-desktop-serve.json"), 0o640);
    expect(findHermesHost(hermes.env, "darwin").ok).toBe(false);
  });

  test("a record whose host process is gone is not a host", () => {
    const hermes = fakeHermes({ record: { pid: 2 ** 22 + 12345 } });
    expect(findHermesHost(hermes.env).ok).toBe(false);
  });

  test("no Hermes installed: unavailable, quickly, without throwing", async () => {
    const listing = await listHermesSessions({ env: { HERMES_GATEWAY_LOCK_DIR: tempDir("ocs-hermes-none-") } });
    expect(listing.available).toBe(false);
  });
});

describe("Hermes wake", () => {
  test("idle session: started, always submitted with queued:true and the runtime id", async () => {
    const hermes = fakeHermes();
    const result = await wakeHermesSession(KEY, "[ocs wake] hello", { env: hermes.env });
    expect(result).toEqual({ ok: true, delivery: "started", sessionKey: KEY });
    expect(hermes.calls.map((c) => c.method)).toEqual(["session.active_list", "prompt.submit"]);
    expect(hermes.calls[1]!.params).toEqual({ session_id: "497375b4", text: "[ocs wake] hello", queued: true });
  });

  test("busy session: queued behind the running turn", async () => {
    const hermes = fakeHermes({ submit: () => ({ status: "queued" }) });
    expect(await wakeHermesSession(KEY, "[ocs wake] hi", { env: hermes.env }))
      .toEqual({ ok: true, delivery: "queued", sessionKey: KEY });
  });

  test("a session that is not open is not-open; nothing submitted", async () => {
    const hermes = fakeHermes({ sessions: [] });
    expect(await wakeHermesSession(KEY, "[ocs wake] hi", { env: hermes.env })).toMatchObject({ ok: false, reason: "not-open" });
    expect(hermes.calls.map((c) => c.method)).toEqual(["session.active_list"]);
  });

  test("host refusal (JSON-RPC error) is failed, not unknown", async () => {
    const hermes = fakeHermes({ submit: () => ({ error: { code: 4090, message: "active session limit" } }) });
    expect(await wakeHermesSession(KEY, "[ocs wake] hi", { env: hermes.env }))
      .toMatchObject({ ok: false, reason: "failed", detail: "4090 active session limit" });
  });

  test("connection dropped after the submit frame left: unknown-outcome (never resend)", async () => {
    const hermes = fakeHermes({ submit: () => "drop" });
    expect(await wakeHermesSession(KEY, "[ocs wake] hi", { env: hermes.env })).toMatchObject({ ok: false, reason: "unknown-outcome" });
    expect(hermes.calls.filter((c) => c.method === "prompt.submit")).toHaveLength(1);
  });

  test("an unexpected success shape is unknown-outcome, not ok", async () => {
    const hermes = fakeHermes({ submit: () => ({ status: "something-new" }) });
    expect(await wakeHermesSession(KEY, "[ocs wake] hi", { env: hermes.env })).toMatchObject({ ok: false, reason: "unknown-outcome" });
  });

  test("host not running: unavailable before any frame", async () => {
    const result = await wakeHermesSession(KEY, "[ocs wake] hi", { env: { HERMES_GATEWAY_LOCK_DIR: tempDir("ocs-hermes-none-") } });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("Hermes over the LAN", () => {
  const peer = {
    fingerprint: "a".repeat(52),
    label: "mac",
    name: "mac",
    publicKey: "",
    pairedAt: new Date().toISOString(),
  } as unknown as Parameters<typeof handleLanDm>[1];

  test("remote DM to an open Hermes session is stored and queued into it", async () => {
    const hermes = fakeHermes();
    const resolved = resolveDmTarget(ADDRESS, hermes.env)!;
    expect(localAddressOf(resolved, ADDRESS, hermes.env)).toEqual({ key: ADDRESS, display: ADDRESS });
    const reply = await handleLanDm(
      { op: "dm", from: "claude-1234abcd", from_key: "claude-1234abcd", to: ADDRESS, body: "can you review?" },
      peer,
      "en",
      hermes.env,
    );
    expect(reply.ok).toBe(true);
    const submit = hermes.calls.find((c) => c.method === "prompt.submit")!;
    expect(submit.params.queued).toBe(true);
    expect(String(submit.params.text)).toContain("can you review?");
    expect(String(submit.params.text)).toContain("claude-1234abcd@mac");
    const channel = String(reply.channel ?? "");
    expect(readMessages(channel, { env: hermes.env }).map((m) => m.body)).toEqual(["can you review?"]);
  });

  test("remote DM to a Hermes session that is not open is refused without storing", async () => {
    const hermes = fakeHermes({ sessions: [] });
    const reply = await handleLanDm(
      { op: "dm", from: "claude-1234abcd", from_key: "claude-1234abcd", to: ADDRESS, body: "hello?" },
      peer,
      "en",
      hermes.env,
    );
    expect(reply).toMatchObject({ ok: false, error: "not-found" });
    expect(hermes.calls.some((c) => c.method === "prompt.submit")).toBe(false);
  });
});
