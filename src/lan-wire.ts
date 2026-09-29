// 局域网 ocs 的线路层：TCP 上的 4 字节大端长度前缀帧 + 握手 + AEAD 记录层。
//
// 一请求一连接：hello → hello-ack → auth → welcome → 请求 → 应答 → 关。没有长连接状态机，
// 也就没有「会话里第 N 个请求被重放」这一类问题；每次连接都是新的临时密钥。
// 资源上限在**分配之前**检查：握手阶段单帧 ≤ 1 KiB，加密阶段 ≤ 1 MiB，超限立即断开。

import { connect, type Socket } from "node:net";
import {
  AeadStream,
  fingerprintDigest,
  fingerprintOf,
  LanProtocolError,
  respondServerHandshake,
  startClientHandshake,
  type LanIdentity,
} from "./lan-crypto.ts";

export const HANDSHAKE_FRAME_MAX = 1024;
export const RECORD_FRAME_MAX = 1024 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 5_000;
export const CONNECT_TIMEOUT_MS = 2_500;

/**
 * 从 socket 上按长度前缀切帧；超限帧不分配、直接报错。
 * 协议严格一问一答，合法对端手里永远最多一帧没被取走——再来一帧就是流水线灌帧（一次写入
 * 几十万个零长帧能把事件循环卡住几秒），直接断开。解析用偏移量，不每帧复制整个缓冲。
 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private waiters: Array<{ resolve: (frame: Buffer) => void; reject: (error: Error) => void }> = [];
  private frames: Buffer[] = [];
  private failure: Error | null = null;
  maxFrame: number;

  constructor(private readonly socket: Socket, maxFrame: number) {
    this.maxFrame = maxFrame;
    socket.on("data", (chunk: Buffer) => this.push(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new LanProtocolError("closed", "connection closed")));
  }

  private push(chunk: Buffer): void {
    if (this.failure !== null) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    let offset = 0;
    while (this.buffer.length - offset >= 4) {
      const length = this.buffer.readUInt32BE(offset);
      if (length > this.maxFrame) {
        this.abort(new LanProtocolError("too-large", `frame of ${length} bytes exceeds ${this.maxFrame}`));
        return;
      }
      if (this.buffer.length - offset < 4 + length) break;
      const frame = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      offset += 4 + length;
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        waiter.resolve(frame);
      } else if (this.frames.length === 0) {
        this.frames.push(frame);
      } else {
        this.abort(new LanProtocolError("pipelined", "peer sent frames out of turn"));
        return;
      }
    }
    this.buffer = offset === 0 ? this.buffer : Buffer.from(this.buffer.subarray(offset));
    // 半帧也受上限约束：声明长度已检查过，这里防的是「声明合法但一直不发完」时缓冲超限。
    if (this.buffer.length > this.maxFrame + 4) {
      this.abort(new LanProtocolError("too-large", "buffered data exceeds frame limit"));
    }
  }

  private abort(error: Error): void {
    this.fail(error);
    this.buffer = Buffer.alloc(0);
    this.frames = [];
    this.socket.destroy();
  }

  private fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(timeoutMs: number): Promise<Buffer> {
    const ready = this.frames.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new LanProtocolError("timeout", "timed out waiting for frame"));
      }, timeoutMs);
      const done = (frame: Buffer) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.waiters.push({
        resolve: done,
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }
}

export function writeFrame(socket: Socket, payload: Buffer): void {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([head, payload]));
}

function parseJson(frame: Buffer): unknown {
  try {
    return JSON.parse(frame.toString("utf8")) as unknown;
  } catch {
    throw new LanProtocolError("bad-frame", "frame is not json");
  }
}

/** 握手完成后的双向加密通道。 */
export class SecureChannel {
  constructor(
    private readonly socket: Socket,
    private readonly reader: FrameReader,
    private readonly sendStream: AeadStream,
    private readonly recvStream: AeadStream,
  ) {}

  send(value: unknown): void {
    writeFrame(this.socket, this.sendStream.seal(Buffer.from(JSON.stringify(value), "utf8")));
  }

  async receive(timeoutMs: number): Promise<unknown> {
    return parseJson(this.recvStream.open(await this.reader.next(timeoutMs)));
  }

  close(): void {
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref?.();
  }

  destroy(): void {
    this.socket.destroy();
  }
}

// ───────────────────────── 客户端 ─────────────────────────

/** 客户端对服务端公钥的期望：已配对 → 钉死完整指纹；配对中 → 配对码里的指纹前缀。 */
export type ServerExpectation =
  | { kind: "fingerprint"; fingerprint: string }
  | { kind: "prefix"; prefix: Buffer };

export interface ClientConnection {
  channel: SecureChannel;
  serverKey: Buffer;
  serverFingerprint: string;
  paired: boolean;
  serverName: string;
}

export function parseHostPort(addr: string): { host: string; port: number } | null {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^\s:]+):(\d{1,5})$/.exec(addr);
  if (match === null) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1]!.replace(/^\[|\]$/g, ""), port };
}

function openSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new LanProtocolError("unreachable", `connect to ${host}:${port} timed out`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(new LanProtocolError("unreachable", `connect to ${host}:${port}: ${error.message}`));
    });
  });
}

/**
 * 连上对端并完成双向认证。服务端公钥不符合期望时**在发出本机身份之前**断开，抛
 * `peer-key-mismatch`——那是换了机器、重装丢钥、或者有人冒名，三种都不该继续。
 */
export async function connectSecure(
  addr: { host: string; port: number },
  identity: LanIdentity,
  expect: ServerExpectation,
  options: { listenPort: number | null; connectTimeoutMs?: number },
): Promise<ClientConnection> {
  const socket = await openSocket(addr.host, addr.port, options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
  const reader = new FrameReader(socket, HANDSHAKE_FRAME_MAX);
  try {
    const hs = startClientHandshake();
    writeFrame(socket, Buffer.from(JSON.stringify(hs.hello)));
    const { serverKey, keys } = hs.receive(parseJson(await reader.next(HANDSHAKE_TIMEOUT_MS)));
    const serverFingerprint = fingerprintOf(serverKey);
    const matches = expect.kind === "fingerprint"
      ? serverFingerprint === expect.fingerprint
      : fingerprintDigest(serverKey).subarray(0, expect.prefix.length).equals(expect.prefix);
    if (!matches) {
      throw new LanProtocolError("peer-key-mismatch", `peer at ${addr.host}:${addr.port} presented key ${serverFingerprint}`);
    }
    reader.maxFrame = RECORD_FRAME_MAX;
    const channel = new SecureChannel(socket, reader, new AeadStream(keys.c2s, "c2s"), new AeadStream(keys.s2c, "s2c"));
    channel.send(hs.auth(identity, options.listenPort));
    const welcome = await channel.receive(HANDSHAKE_TIMEOUT_MS) as { t?: unknown; paired?: unknown; name?: unknown };
    if (welcome?.t !== "welcome") throw new LanProtocolError("bad-frame", "expected welcome");
    return {
      channel,
      serverKey,
      serverFingerprint,
      paired: welcome.paired === true,
      serverName: typeof welcome.name === "string" ? welcome.name.slice(0, 64) : "?",
    };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

// ───────────────────────── 服务端 ─────────────────────────

export interface AcceptedConnection {
  channel: SecureChannel;
  clientKey: Buffer;
  clientFingerprint: string;
  clientPort: number | null;
}

/**
 * 服务端握手。`decide` 在客户端身份验签通过后调用，返回是否已配对和本机名——welcome 帧
 * 同时是密钥确认。未配对的连接照样拿到 welcome（paired:false），但之后只许发 pair 请求。
 */
export async function acceptSecure(
  socket: Socket,
  identity: LanIdentity,
  decide: (clientFingerprint: string) => { paired: boolean; name: string },
): Promise<AcceptedConnection> {
  const reader = new FrameReader(socket, HANDSHAKE_FRAME_MAX);
  const hs = respondServerHandshake(parseJson(await reader.next(HANDSHAKE_TIMEOUT_MS)), identity);
  writeFrame(socket, Buffer.from(JSON.stringify(hs.ack)));
  const channel = new SecureChannel(socket, reader, new AeadStream(hs.keys.s2c, "s2c"), new AeadStream(hs.keys.c2s, "c2s"));
  const { clientKey, port } = hs.verifyAuth(await channel.receive(HANDSHAKE_TIMEOUT_MS));
  const clientFingerprint = fingerprintOf(clientKey);
  const { paired, name } = decide(clientFingerprint);
  // 只有已配对的对端才放开到 1 MiB；未配对的只可能发一条很小的 pair 请求。
  reader.maxFrame = paired ? RECORD_FRAME_MAX : HANDSHAKE_FRAME_MAX;
  channel.send({ t: "welcome", paired, name });
  return { channel, clientKey, clientFingerprint, clientPort: port };
}
