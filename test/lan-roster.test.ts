import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { join } from "node:path";
import { remoteWho } from "../src/lan-client.ts";
import type { LanWhoEntry } from "../src/lan-daemon.ts";
import { loadOrCreateIdentity, trustPeer } from "../src/lan-store.ts";
import { acceptSecure } from "../src/lan-wire.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();

async function rosterReply(entries: unknown[]): Promise<Awaited<ReturnType<typeof remoteWho>>> {
  const root = tempDir("ocs-lan-roster-");
  const env = { OCS_HOME: join(root, "client") };
  const client = loadOrCreateIdentity(env);
  const identity = loadOrCreateIdentity({ OCS_HOME: join(root, "server") });
  let handlerError: unknown;
  const server = createServer((socket) => {
    void (async () => {
      const conn = await acceptSecure(socket, identity, (fingerprint) => ({
        paired: fingerprint === client.fingerprint, name: "test-peer",
      }));
      try {
        expect(await conn.channel.receive(5000)).toEqual({ op: "who" });
        conn.channel.send({ ok: true, name: "test-peer", entries });
      } finally {
        conn.channel.close();
      }
    })().catch((error: unknown) => {
      handlerError = error;
      socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing server address");
  const peer = trustPeer({ key: identity.publicKey, name: "test-peer", addr: `127.0.0.1:${address.port}` }, env);
  try {
    return await remoteWho(peer, client, env);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (handlerError !== undefined) throw handlerError;
  }
}

test("malformed peer roster entries do not hide valid agents", async () => {
  const valid: LanWhoEntry = { address: "dataset-audit", kind: "codex", label: "Mega dataset audit" };
  const result = await rosterReply([null, false, 42, "invalid", [], {}, valid]);
  expect(result).toEqual({ name: "test-peer", entries: [valid] });
});

test("peer roster addresses are validated without rewriting their identity", async () => {
  const longest = "a".repeat(64);
  const result = await rosterReply([
    { address: `${longest}b`, kind: "codex" },
    { address: "dataset\naudit", kind: "codex" },
    { address: "dataset\u001baudit", kind: "codex" },
    { address: "dataset audit", kind: "codex" },
    { address: "", kind: "codex" },
    { address: longest, kind: "codex" },
    { address: "dataset-audit", kind: "codex", label: "Mega\naudit\u001b", status: "idle\n" },
  ]);
  expect(result.entries).toEqual([
    { address: longest, kind: "codex" },
    { address: "dataset-audit", kind: "codex", label: "Megaaudit", status: "idle" },
  ]);
});
