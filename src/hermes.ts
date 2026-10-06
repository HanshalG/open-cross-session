// Hermes Desktop / `hermes serve` sessions: discovery and wake (issue #40).
//
// Hermes Agent's session host speaks JSON-RPC over a loopback WebSocket (`/api/ws?token=…`), the
// same channel the Desktop window uses. On start it publishes a rendezvous record for clients of
// the same OS user: `<lock dir>/host-<role>.json` ({pid, host, port, tokenFingerprint, …}, 0600)
// plus `host-<role>.token` (0600). We read both on every connect (the token changes with each
// backend restart) and refuse anything that is not owner-only, not ours, not loopback, or whose
// token does not match the published fingerprint.
//
// Address: `hermes-<session key>` with `_` written as `.` (`hermes-20261006.124023.6626fe`): ocs
// names and @mentions have no `_`, Hermes keys have no `.`, so the mapping is lossless. The key is
// the durable id that Hermes also exports to every terminal-tool command as HERMES_SESSION_ID — so
// `ocs` run by that Hermes session knows who it is. The 8-hex runtime id the RPCs take is resolved fresh before each send
// (`session.active_list`); it is never stored.
//
// Delivery: `prompt.submit {session_id, text, queued: true}`. `queued` is mandatory — without it
// Hermes' default busy mode interrupts the running turn. Replies: `streaming` = an idle session
// started a turn with the message, `queued` = persisted behind the running turn. The message shows
// as a user bubble (a JSON client cannot set another author), so the wake-protocol wrapper is what
// marks it as cross-session data. Once the submit frame is written, a missing or malformed reply
// is an unknown outcome and must not be retried (same rule as Codex IPC).
//
// This is Hermes' private protocol; every failure before the frame is written degrades to
// "unavailable" and the message stays in the channel log.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const HERMES_SESSION_ID_ENV = "HERMES_SESSION_ID";
export const HERMES_SESSION_SOURCE_ENV = "HERMES_SESSION_SOURCE";
export const HERMES_LOCK_DIR_ENV = "HERMES_GATEWAY_LOCK_DIR";
/** Hermes roles that host interactive sessions over the WebSocket gateway. */
export const HERMES_HOST_ROLES = ["desktop-serve", "serve"] as const;
export const HERMES_CONNECT_TIMEOUT_MS = 3_000;
export const HERMES_RPC_TIMEOUT_MS = 10_000;
export const HERMES_WAKE_MAX_BYTES = 16 * 1024;

// Desktop keys look like 20261006_124023_6626fe; cron and older sessions use other shapes. Keep
// the charset tight enough for a channel name and short enough that `hermes-<id>` fits NAME_RE.
const SESSION_KEY_RE = /^[a-z0-9][a-z0-9_]{5,56}$/;
const RUNTIME_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isHermesSessionKey(value: string): boolean {
  return SESSION_KEY_RE.test(value);
}

export function hermesTargetName(sessionKey: string): string {
  if (!isHermesSessionKey(sessionKey)) throw new Error(`invalid Hermes session id: ${sessionKey}`);
  return `hermes-${sessionKey.replaceAll("_", ".")}`;
}

/** Channel-derivation identity; same dotted spelling as the address. */
export function hermesIdentity(sessionKey: string): string {
  return `hermes:${hermesTargetName(sessionKey).slice("hermes-".length)}`;
}

export function hermesSessionKeyFromTarget(target: string): string | null {
  if (!target.startsWith("hermes-")) return null;
  const dotted = target.slice("hermes-".length);
  if (dotted.includes("_")) return null; // one spelling only
  const key = dotted.replaceAll(".", "_");
  return isHermesSessionKey(key) ? key : null;
}

/** The Hermes session this process runs inside (a terminal-tool command), or null. */
export function selfHermesSessionKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env[HERMES_SESSION_ID_ENV];
  const source = env[HERMES_SESSION_SOURCE_ENV];
  // HERMES_SESSION_SOURCE marks a per-command session binding; a stray HERMES_SESSION_ID alone
  // (exported by hand, leaked into a login shell) is not proof we are inside that session.
  if (typeof key !== "string" || !isHermesSessionKey(key)) return null;
  if (typeof source !== "string" || source === "") return null;
  return key;
}

export function hermesLockDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env[HERMES_LOCK_DIR_ENV];
  if (typeof override === "string" && override !== "") return override;
  const state = env.XDG_STATE_HOME;
  const stateHome = typeof state === "string" && isAbsolute(state) ? state : join(home, ".local", "state");
  return join(stateHome, "hermes", "gateway-locks");
}

export interface HermesHost {
  role: string;
  pid: number;
  host: string;
  port: number;
  token: string;
}

export type HermesHostLookup =
  | { ok: true; host: HermesHost }
  | { ok: false; reason: string };

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Owner-only regular file of ours (mode bits are meaningless on Windows; the profile ACL guards it). */
function readPrivateFile(path: string, maxBytes: number, platform: NodeJS.Platform): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path} is not a regular file`);
  if (stat.size > maxBytes) throw new Error(`${path} is too large`);
  if (platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error(`${path} is readable by others`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${path} is not ours`);
  return readFileSync(path, "utf8");
}

function lookupRole(role: string, dir: string, platform: NodeJS.Platform): HermesHostLookup {
  let record: Record<string, unknown>;
  try {
    const value = JSON.parse(readPrivateFile(join(dir, `host-${role}.json`), 16 * 1024, platform)) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "malformed record" };
    record = value as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? "not running" : String((error as Error).message ?? error) };
  }
  const { pid, host, port, tokenFingerprint } = record;
  if (record.role !== role) return { ok: false, reason: "record role mismatch" };
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return { ok: false, reason: "record has no pid" };
  if (!pidAlive(pid)) return { ok: false, reason: `host pid ${pid} is gone` };
  // The token goes in the URL: never hand it to anything but loopback.
  if (typeof host !== "string" || !LOOPBACK.has(host)) return { ok: false, reason: `host ${String(host)} is not loopback` };
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "record has no port" };
  let token: string;
  try {
    token = readPrivateFile(join(dir, `host-${role}.token`), 4 * 1024, platform).trim();
  } catch (error) {
    return { ok: false, reason: `token: ${String((error as Error).message ?? error)}` };
  }
  if (token === "") return { ok: false, reason: "empty token" };
  const fingerprint = createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16);
  if (typeof tokenFingerprint !== "string" || tokenFingerprint !== fingerprint) {
    return { ok: false, reason: "token does not match the published fingerprint (host restarting?)" };
  }
  return { ok: true, host: { role, pid, host, port, token } };
}

/** The live Hermes session host of this user, Desktop first. */
export function findHermesHost(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): HermesHostLookup {
  const dir = hermesLockDir(env);
  const reasons: string[] = [];
  for (const role of HERMES_HOST_ROLES) {
    const found = lookupRole(role, dir, platform);
    if (found.ok) return found;
    reasons.push(`${role}: ${found.reason}`);
  }
  return { ok: false, reason: reasons.join("; ") };
}

export interface HermesSession {
  /** Durable id: the address and identity. */
  key: string;
  /** Runtime id the RPCs take; only valid on this host process. */
  runtimeId: string;
  title: string | null;
  /** idle | working | starting | waiting (Hermes' own words). */
  status: string | null;
}

interface RpcError {
  code?: number;
  message?: string;
}

/** Minimal JSON-RPC 2.0 client over Hermes' gateway WebSocket. Injectable for tests. */
export interface HermesConnection {
  call(method: string, params: Record<string, unknown>, opts?: { onWritten?: () => void }): Promise<unknown>;
  close(): void;
}

export class HermesRpcError extends Error {
  constructor(readonly code: number | null, message: string) {
    super(message);
  }
}

/** Thrown when the connection dies or times out; `written` says whether our frame had left. */
export class HermesTransportError extends Error {
  constructor(message: string, readonly written: boolean) {
    super(message);
  }
}

export type HermesConnector = (host: HermesHost) => Promise<HermesConnection>;

export const connectHermes: HermesConnector = (host) =>
  new Promise((resolve, reject) => {
    const hostPart = host.host.includes(":") ? `[${host.host}]` : host.host;
    const url = `ws://${hostPart}:${host.port}/api/ws?token=${encodeURIComponent(host.token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      reject(new HermesTransportError(String(error), false));
      return;
    }
    let nextId = 0;
    let opened = false;
    const pending = new Map<number, {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      written: boolean;
    }>();
    const failAll = (message: string) => {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new HermesTransportError(message, entry.written));
        pending.delete(id);
      }
    };
    const connectTimer = setTimeout(() => {
      if (opened) return;
      try { ws.close(); } catch {}
      reject(new HermesTransportError(`no connection after ${HERMES_CONNECT_TIMEOUT_MS}ms`, false));
    }, HERMES_CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      opened = true;
      clearTimeout(connectTimer);
      resolve({
        call(method, params, opts) {
          return new Promise((resolveCall, rejectCall) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
              const entry = pending.get(id);
              pending.delete(id);
              rejectCall(new HermesTransportError(`no reply to ${method} after ${HERMES_RPC_TIMEOUT_MS}ms`, entry?.written ?? true));
            }, HERMES_RPC_TIMEOUT_MS);
            const entry = { resolve: resolveCall, reject: rejectCall, timer, written: false };
            pending.set(id, entry);
            try {
              // From here on the frame may have reached the host: failures are unknown outcomes.
              entry.written = true;
              opts?.onWritten?.();
              ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            } catch (error) {
              clearTimeout(timer);
              pending.delete(id);
              rejectCall(new HermesTransportError(String(error), true));
            }
          });
        },
        close() {
          failAll("closed");
          try { ws.close(); } catch {}
        },
      });
    };
    ws.onmessage = (event) => {
      let frame: { id?: unknown; result?: unknown; error?: RpcError };
      try {
        frame = JSON.parse(String(event.data)) as typeof frame;
      } catch {
        return;
      }
      if (typeof frame.id !== "number") return; // events (gateway.ready, message.*) are not ours
      const entry = pending.get(frame.id);
      if (entry === undefined) return;
      pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.error !== undefined && frame.error !== null) {
        entry.reject(new HermesRpcError(
          typeof frame.error.code === "number" ? frame.error.code : null,
          typeof frame.error.message === "string" ? frame.error.message : "error",
        ));
      } else {
        entry.resolve(frame.result);
      }
    };
    ws.onerror = () => {
      if (!opened) {
        clearTimeout(connectTimer);
        reject(new HermesTransportError("connection refused", false));
      }
    };
    ws.onclose = () => {
      if (!opened) {
        clearTimeout(connectTimer);
        reject(new HermesTransportError("connection closed", false));
      }
      failAll("connection closed");
    };
  });

export interface HermesDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  connect?: HermesConnector;
  findHost?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => HermesHostLookup;
}

function parseActiveList(result: unknown): HermesSession[] {
  const sessions = (result as { sessions?: unknown })?.sessions;
  if (!Array.isArray(sessions)) throw new HermesRpcError(null, "session.active_list: unexpected reply");
  const out: HermesSession[] = [];
  for (const raw of sessions) {
    if (typeof raw !== "object" || raw === null) continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.session_key !== "string" || !isHermesSessionKey(s.session_key)) continue;
    if (typeof s.id !== "string" || !RUNTIME_ID_RE.test(s.id)) continue;
    out.push({
      key: s.session_key,
      runtimeId: s.id,
      title: typeof s.title === "string" && s.title.trim() !== ""
        ? s.title.replace(/[\r\n\t]+/g, " ").trim().slice(0, 96)
        : null,
      status: typeof s.status === "string" ? s.status : null,
    });
  }
  return out;
}

export type HermesListing =
  | { available: true; host: { role: string; pid: number }; sessions: HermesSession[] }
  | { available: false; reason: string };

/** Live sessions on this user's Hermes host. Never throws. */
export async function listHermesSessions(deps: HermesDeps = {}): Promise<HermesListing> {
  const env = deps.env ?? process.env;
  const found = (deps.findHost ?? findHermesHost)(env, deps.platform ?? process.platform);
  if (!found.ok) return { available: false, reason: found.reason };
  let connection: HermesConnection | null = null;
  try {
    connection = await (deps.connect ?? connectHermes)(found.host);
    const sessions = parseActiveList(await connection.call("session.active_list", {}));
    return { available: true, host: { role: found.host.role, pid: found.host.pid }, sessions };
  } catch (error) {
    return { available: false, reason: String((error as Error).message ?? error) };
  } finally {
    connection?.close();
  }
}

export type HermesWakeResult =
  | { ok: true; delivery: "started" | "queued"; sessionKey: string }
  | { ok: false; reason: "unavailable" | "not-open" | "failed" | "unknown-outcome"; detail?: string };

/**
 * Submit one formatted wake note into the live session `sessionKey`, queued behind any running
 * turn. A frame that left and got no valid reply is unknown-outcome: never resend it.
 */
export async function wakeHermesSession(
  sessionKey: string,
  note: string,
  deps: HermesDeps = {},
): Promise<HermesWakeResult> {
  const bytes = Buffer.byteLength(note, "utf8");
  if (bytes === 0 || bytes > HERMES_WAKE_MAX_BYTES) {
    return { ok: false, reason: "failed", detail: `wake note is ${bytes} bytes` };
  }
  const env = deps.env ?? process.env;
  const found = (deps.findHost ?? findHermesHost)(env, deps.platform ?? process.platform);
  if (!found.ok) return { ok: false, reason: "unavailable", detail: found.reason };
  let connection: HermesConnection | null = null;
  let submitted = false;
  try {
    connection = await (deps.connect ?? connectHermes)(found.host);
    const live = parseActiveList(await connection.call("session.active_list", {}))
      .find((session) => session.key === sessionKey);
    if (live === undefined) return { ok: false, reason: "not-open", detail: "no open Hermes session with that id" };
    const reply = await connection.call(
      "prompt.submit",
      { session_id: live.runtimeId, text: note, queued: true },
      { onWritten: () => { submitted = true; } },
    );
    const status = (reply as { status?: unknown })?.status;
    if (status === "streaming") return { ok: true, delivery: "started", sessionKey };
    if (status === "queued") return { ok: true, delivery: "queued", sessionKey };
    return { ok: false, reason: "unknown-outcome", detail: `unexpected prompt.submit reply: ${JSON.stringify(reply)?.slice(0, 200)}` };
  } catch (error) {
    if (error instanceof HermesRpcError) {
      // A JSON-RPC error reply is an answer: the host refused, nothing was enqueued.
      return { ok: false, reason: "failed", detail: `${error.code ?? "?"} ${error.message}` };
    }
    const written = submitted && (!(error instanceof HermesTransportError) || error.written);
    return {
      ok: false,
      reason: written ? "unknown-outcome" : "unavailable",
      detail: String((error as Error).message ?? error),
    };
  } finally {
    connection?.close();
  }
}
