// 局域网 ocs 的密码学核心（协议与威胁模型见 docs/lan.md）。
//
// 只用 node:crypto 原语，零依赖：Ed25519（长期身份、签名）、X25519（每连接临时密钥交换）、
// HKDF-SHA256（派生方向密钥）、AES-256-GCM（Bun 没有 chacha20-poly1305）。
//
// 握手是 SIGMA-I 形状，一请求一连接：
//   C → S  hello      {eph_c, nonce_c}                           明文
//   S → C  hello-ack  {eph_s, nonce_s, key_s, sig_s(th)}          明文，th 覆盖以上全部
//   C → S  auth       {key_c, sig_c(th ‖ key_s ‖ key_c), port}    密文（c2s #0）
//   S → C  welcome    {paired, name}                              密文（s2c #0）——密钥确认
//   C → S  请求 / S → C 应答                                       密文 #1
// 客户端在发出自己身份**之前**先核对服务端公钥（已配对的钉死指纹，或配对码里的指纹前缀），
// 对不上就断开：陌生服务端既拿不到客户端身份，也拿不到任何请求。
// 每连接临时 X25519 → 前向保密；签名覆盖双方临时公钥 → 中间人换不了钥；GCM 计数器
// 隐式递增、按方向分钥 → 篡改、重放、乱序都在解密时失败。

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";

export const LAN_PROTO = "ocs-lan/1";
const KEY_BYTES = 32;
const NONCE_BYTES = 16;
const SIG_BYTES = 64;
const TAG_BYTES = 16;

export class LanProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LanProtocolError";
  }
}

// ───────────────────────── 编码 ─────────────────────────

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32，小写、无填充。指纹用它：只含 [a-z2-7]，可直接进身份串与文件名。 */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Crockford base32：配对码给人抄，去掉 I L O U，大小写不敏感。 */
export function crockfordEncode(bytes: Uint8Array): string {
  return base32(bytes).split("").map((ch) => CROCKFORD[B32.indexOf(ch)]).join("");
}

export function crockfordDecode(text: string): Buffer | null {
  const cleaned = text.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  let buffer = 0;
  let bits = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const value = CROCKFORD.indexOf(ch);
    if (value === -1) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** 严格 base64 解码：长度必须恰好等于期望值，否则当协议错误。 */
export function fromB64(value: unknown, bytes: number, field: string): Buffer {
  if (typeof value !== "string" || value.length > 4 * Math.ceil(bytes / 3) + 4) {
    throw new LanProtocolError("bad-frame", `bad ${field}`);
  }
  const out = Buffer.from(value, "base64");
  if (out.length !== bytes || out.toString("base64") !== value) {
    throw new LanProtocolError("bad-frame", `bad ${field}`);
  }
  return out;
}

// ───────────────────────── 身份 ─────────────────────────

export interface LanIdentity {
  privateKey: KeyObject;
  /** Ed25519 原始公钥 32 字节。 */
  publicKey: Buffer;
  fingerprint: string;
}

export function rawEd25519Public(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  return Buffer.from(jwk.x ?? "", "base64url");
}

export function ed25519PublicFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== KEY_BYTES) throw new LanProtocolError("bad-frame", "bad ed25519 key length");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
}

function x25519PublicFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" });
}

/** 指纹 = base32(SHA-256(Ed25519 原始公钥))，52 字符。身份的唯一名字；地址和昵称都只是提示。 */
export function fingerprintOf(publicKey: Buffer): string {
  return base32(createHash("sha256").update(publicKey).digest());
}

export function fingerprintDigest(publicKey: Buffer): Buffer {
  return createHash("sha256").update(publicKey).digest();
}

/** 给人看的短指纹：前 16 字符四个一组。 */
export function shortFingerprint(fp: string): string {
  return fp.slice(0, 16).match(/.{4}/g)!.join("-");
}

export function generateIdentity(): { identity: LanIdentity; pkcs8: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = rawEd25519Public(publicKey);
  return {
    identity: { privateKey, publicKey: raw, fingerprint: fingerprintOf(raw) },
    pkcs8: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64"),
  };
}

export function identityFromPkcs8(pkcs8: string): LanIdentity {
  const privateKey = createPrivateKey({ key: Buffer.from(pkcs8, "base64"), format: "der", type: "pkcs8" });
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("identity key is not ed25519");
  const raw = rawEd25519Public(createPublicKey(privateKey));
  return { privateKey, publicKey: raw, fingerprint: fingerprintOf(raw) };
}

// ───────────────────────── 配对码 ─────────────────────────

/** 配对码 = 发码方公钥指纹前 8 字节（64 位，认证发码方）‖ 7 字节随机令牌（56 位，认证兑码方）。 */
export const PAIR_FP_PREFIX_BYTES = 8;
export const PAIR_TOKEN_BYTES = 7;

export function encodePairingCode(fpDigest: Buffer, token: Buffer): string {
  const raw = Buffer.concat([fpDigest.subarray(0, PAIR_FP_PREFIX_BYTES), token]);
  return crockfordEncode(raw).match(/.{1,4}/g)!.join("-");
}

export function decodePairingCode(code: string): { fpPrefix: Buffer; token: Buffer } | null {
  const raw = crockfordDecode(code);
  if (raw === null || raw.length !== PAIR_FP_PREFIX_BYTES + PAIR_TOKEN_BYTES) return null;
  // 24 个字符正好 120 位，没有填充位；多敲少敲一个字符都会让长度对不上。
  if (code.replace(/[\s-]/g, "").length !== 24) return null;
  return { fpPrefix: raw.subarray(0, PAIR_FP_PREFIX_BYTES), token: raw.subarray(PAIR_FP_PREFIX_BYTES) };
}

/**
 * 6-digit check code (SAS), computed independently by both ends from this handshake's
 * transcript hash, the c2s session key and both long-term keys. The requester pins the
 * server's key prefix, so nobody in the middle can pose as the server; the code guards the
 * other direction — someone else slipping in a request as the requester. If the number on
 * the server's screen differs from the requester's, the human must not approve.
 */
export function sasCode(keys: { transcript: Buffer; c2s: Buffer }, serverKey: Buffer, clientKey: Buffer): string {
  const digest = createHash("sha256")
    .update(`${LAN_PROTO}\0sas\0`)
    .update(keys.transcript).update(keys.c2s).update(serverKey).update(clientKey)
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export function formatSas(sas: string): string {
  return `${sas.slice(0, 3)} ${sas.slice(3)}`;
}

export function tokenDigest(token: Buffer): string {
  return createHash("sha256").update("ocs-lan/1 pair token\0").update(token).digest("hex");
}

export function constantTimeHexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

// ───────────────────────── 握手 ─────────────────────────

export interface ClientHello {
  t: "hello";
  proto: string;
  eph: string;
  nonce: string;
}

export interface ServerHello {
  t: "hello-ack";
  proto: string;
  eph: string;
  nonce: string;
  key: string;
  sig: string;
}

export interface SessionKeys {
  /** 客户端 → 服务端。 */
  c2s: Buffer;
  s2c: Buffer;
  transcript: Buffer;
}

function newEphemeral(): { priv: KeyObject; pub: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  return { priv: privateKey, pub: Buffer.from(jwk.x ?? "", "base64url") };
}

/** 定长字段拼接，不需要分隔符也不会有歧义。 */
function transcriptHash(ephC: Buffer, nonceC: Buffer, ephS: Buffer, nonceS: Buffer, keyS: Buffer): Buffer {
  return createHash("sha256")
    .update(`${LAN_PROTO}\0transcript\0`)
    .update(ephC).update(nonceC).update(ephS).update(nonceS).update(keyS)
    .digest();
}

function deriveKeys(ownEph: KeyObject, peerEph: Buffer, transcript: Buffer): SessionKeys {
  const shared = diffieHellman({ privateKey: ownEph, publicKey: x25519PublicFromRaw(peerEph) });
  // 小阶点会把共享秘密压成全零；RFC 7748 §6.1 要求拒绝。
  if (shared.every((byte) => byte === 0)) throw new LanProtocolError("bad-key", "degenerate x25519 shared secret");
  const okm = Buffer.from(hkdfSync("sha256", shared, transcript, `${LAN_PROTO}\0keys`, 64));
  return { c2s: okm.subarray(0, 32), s2c: okm.subarray(32, 64), transcript };
}

function serverSigPayload(transcript: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${LAN_PROTO}\0server\0`), transcript]);
}

function clientSigPayload(transcript: Buffer, keyS: Buffer, keyC: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${LAN_PROTO}\0client\0`), transcript, keyS, keyC]);
}

export interface ClientHandshake {
  hello: ClientHello;
  /** 收到 hello-ack：验签、派生密钥，返回服务端公钥（调用方先核对它，再决定是否发 auth）。 */
  receive(ack: unknown): { serverKey: Buffer; keys: SessionKeys };
  /** 构造 auth 明文（由调用方加密成 c2s #0 发出）。 */
  auth(identity: LanIdentity, port: number | null): Record<string, unknown>;
}

export function startClientHandshake(): ClientHandshake {
  const eph = newEphemeral();
  const nonce = randomBytes(NONCE_BYTES);
  let state: { serverKey: Buffer; keys: SessionKeys } | null = null;
  return {
    hello: { t: "hello", proto: LAN_PROTO, eph: b64(eph.pub), nonce: b64(nonce) },
    receive(ack) {
      if (typeof ack !== "object" || ack === null || (ack as ServerHello).t !== "hello-ack") {
        throw new LanProtocolError("bad-frame", "expected hello-ack");
      }
      const rec = ack as ServerHello;
      if (rec.proto !== LAN_PROTO) throw new LanProtocolError("proto", `unsupported protocol ${String(rec.proto)}`);
      const ephS = fromB64(rec.eph, KEY_BYTES, "eph");
      const nonceS = fromB64(rec.nonce, NONCE_BYTES, "nonce");
      const keyS = fromB64(rec.key, KEY_BYTES, "key");
      const sig = fromB64(rec.sig, SIG_BYTES, "sig");
      const transcript = transcriptHash(eph.pub, nonce, ephS, nonceS, keyS);
      if (!verify(null, serverSigPayload(transcript), ed25519PublicFromRaw(keyS), sig)) {
        throw new LanProtocolError("bad-signature", "server signature does not verify");
      }
      state = { serverKey: keyS, keys: deriveKeys(eph.priv, ephS, transcript) };
      return state;
    },
    auth(identity, port) {
      if (state === null) throw new Error("auth before hello-ack");
      return {
        t: "auth",
        key: b64(identity.publicKey),
        sig: b64(sign(null, clientSigPayload(state.keys.transcript, state.serverKey, identity.publicKey), identity.privateKey)),
        port,
      };
    },
  };
}

export interface ServerHandshake {
  ack: ServerHello;
  keys: SessionKeys;
  /** 验证解密后的 auth，返回客户端公钥与它声明的监听端口。 */
  verifyAuth(auth: unknown): { clientKey: Buffer; port: number | null };
}

export function respondServerHandshake(hello: unknown, identity: LanIdentity): ServerHandshake {
  if (typeof hello !== "object" || hello === null || (hello as ClientHello).t !== "hello") {
    throw new LanProtocolError("bad-frame", "expected hello");
  }
  const rec = hello as ClientHello;
  if (rec.proto !== LAN_PROTO) throw new LanProtocolError("proto", `unsupported protocol ${String(rec.proto)}`);
  const ephC = fromB64(rec.eph, KEY_BYTES, "eph");
  const nonceC = fromB64(rec.nonce, NONCE_BYTES, "nonce");
  const eph = newEphemeral();
  const nonce = randomBytes(NONCE_BYTES);
  const transcript = transcriptHash(ephC, nonceC, eph.pub, nonce, identity.publicKey);
  const keys = deriveKeys(eph.priv, ephC, transcript);
  return {
    ack: {
      t: "hello-ack",
      proto: LAN_PROTO,
      eph: b64(eph.pub),
      nonce: b64(nonce),
      key: b64(identity.publicKey),
      sig: b64(sign(null, serverSigPayload(transcript), identity.privateKey)),
    },
    keys,
    verifyAuth(auth) {
      if (typeof auth !== "object" || auth === null || (auth as { t?: unknown }).t !== "auth") {
        throw new LanProtocolError("bad-frame", "expected auth");
      }
      const a = auth as { key?: unknown; sig?: unknown; port?: unknown };
      const keyC = fromB64(a.key, KEY_BYTES, "key");
      const sig = fromB64(a.sig, SIG_BYTES, "sig");
      if (!verify(null, clientSigPayload(transcript, identity.publicKey, keyC), ed25519PublicFromRaw(keyC), sig)) {
        throw new LanProtocolError("bad-signature", "client signature does not verify");
      }
      const port = a.port === null || a.port === undefined
        ? null
        : Number.isInteger(a.port) && (a.port as number) > 0 && (a.port as number) < 65536
          ? a.port as number
          : null;
      return { clientKey: keyC, port };
    },
  };
}

// ───────────────────────── 记录层 ─────────────────────────

/**
 * 单方向的 AEAD 流：AES-256-GCM，IV = 4 字节 0 ‖ 8 字节大端计数器，计数器不上线、双方各自
 * 递增。TCP 保序，所以收到的第 n 帧必须用第 n 个计数器解开——被重放、删帧、调序都会让
 * 认证标签对不上。方向写进 AAD，同时方向本身也分了钥，反射攻击两道都过不去。
 */
export class AeadStream {
  private counter = 0n;
  constructor(private readonly key: Buffer, private readonly direction: "c2s" | "s2c") {}

  private iv(): Buffer {
    if (this.counter >= 2n ** 63n) throw new LanProtocolError("exhausted", "nonce counter exhausted");
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(this.counter, 4);
    this.counter++;
    return iv;
  }

  private aad(): Buffer {
    return Buffer.from(`${LAN_PROTO}\0${this.direction}`);
  }

  seal(plaintext: Buffer): Buffer {
    const cipher = createCipheriv("aes-256-gcm", this.key, this.iv(), { authTagLength: TAG_BYTES });
    cipher.setAAD(this.aad());
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([body, cipher.getAuthTag()]);
  }

  open(frame: Buffer): Buffer {
    if (frame.length < TAG_BYTES) throw new LanProtocolError("bad-frame", "frame shorter than tag");
    const decipher = createDecipheriv("aes-256-gcm", this.key, this.iv(), { authTagLength: TAG_BYTES });
    decipher.setAAD(this.aad());
    decipher.setAuthTag(frame.subarray(frame.length - TAG_BYTES));
    try {
      return Buffer.concat([decipher.update(frame.subarray(0, frame.length - TAG_BYTES)), decipher.final()]);
    } catch {
      throw new LanProtocolError("bad-mac", "frame authentication failed");
    }
  }
}
