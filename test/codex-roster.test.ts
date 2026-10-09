import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexRosterName, listCodexRosterSessions } from "../src/codex-roster.ts";
import { listOcsNames, setOcsName } from "../src/names.ts";
import { resolveDmTarget } from "../src/roster.ts";
import { tempDir, autoCleanupTempDirs } from "./tmp";

autoCleanupTempDirs();

function fixture(): { root: string; env: NodeJS.ProcessEnv; db: Database } {
  const home = tempDir("ocs-readable-names-");
  const root = join(home, "sessions");
  mkdirSync(join(root, "2026", "10", "09"), { recursive: true });
  const db = new Database(join(home, "state_5.sqlite"));
  db.run(`CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, name TEXT, title TEXT,
    created_at INTEGER, archived INTEGER, thread_source TEXT, recency_at_ms INTEGER,
    updated_at_ms INTEGER, updated_at INTEGER)`);
  return { root, db, env: { CODEX_HOME: home, OCS_HOME: join(home, "ocs") } };
}

function add(f: ReturnType<typeof fixture>, id: string, name: string, kind = "user"): void {
  const path = join(f.root, "2026", "10", "09", `rollout-2026-10-09T10-00-00-${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id, cwd: "/project" } }) + "\n");
  f.db.query("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, path, "/project", name, "raw initial user prompt", 1, 0, kind, 1, 1, 1);
}

const A = "01a12044-bb78-7f72-81cf-9742bc7d1fc7";
const B = "01a12044-8f4a-7761-bff8-7f5d984d4e4e";

describe("desktop roster titles", () => {
  test("shows sidebar titles and excludes guardian sessions before the candidate limit", () => {
    const f = fixture();
    add(f, A, "Audit pilot prompts");
    for (let i = 0; i < 130; i++) add(f, randomUUID(), "Guardian review", "guardian_review");
    f.db.run("UPDATE threads SET recency_at_ms = 2 WHERE thread_source = 'guardian_review'");
    f.db.close();
    const rows = listCodexRosterSessions(f.root);
    expect(rows.map((r) => [r.threadId, r.summary])).toEqual([[A, "Audit pilot prompts"]]);
  });

  test("keeps older user chats beyond the former 128-candidate cutoff", () => {
    const f = fixture();
    add(f, A, "Older open chat");
    for (let i = 0; i < 129; i++) add(f, randomUUID(), "Newer chat");
    f.db.query("UPDATE threads SET recency_at_ms = 2 WHERE id != ?").run(A);
    f.db.close();
    const rows = listCodexRosterSessions(f.root);
    expect(rows).toHaveLength(130);
    expect(rows.at(-1)?.threadId).toBe(A);
  });

  test("ignores archived chats and rollouts outside the sessions root", () => {
    const f = fixture();
    add(f, A, "Archived chat");
    add(f, B, "Outside root");
    const outside = join(tempDir("ocs-outside-roster-"), "rollout.jsonl");
    writeFileSync(outside, "");
    f.db.query("UPDATE threads SET archived = 1 WHERE id = ?").run(A);
    f.db.query("UPDATE threads SET rollout_path = ? WHERE id = ?").run(outside, B);
    f.db.close();
    expect(listCodexRosterSessions(f.root)).toEqual([]);
  });

  test("falls back to rollouts when the desktop index schema is incompatible", () => {
    const f = fixture();
    add(f, A, "Audit pilot prompts");
    f.db.run("DROP TABLE threads");
    f.db.close();
    expect(listCodexRosterSessions(f.root).map((row) => row.threadId)).toEqual([A]);
    const db = new Database(join(f.env.CODEX_HOME!, "state_5.sqlite"), { readonly: true });
    try {
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("same short id and normalized title produce distinct stable routable names", () => {
    const f = fixture();
    add(f, A, "Audit pilot prompts");
    add(f, B, "AUDIT—pilot prompts");
    f.db.close();
    const rows = listCodexRosterSessions(f.root);
    const rosterNames = listOcsNames(f.env);
    const aliases = rows.map((r) => codexRosterName(r, rosterNames, f.env)!);
    expect(aliases[0]).toBe("audit-pilot-prompts");
    expect(aliases[1]).not.toBe(aliases[0]);
    for (let i = 0; i < rows.length; i++) {
      expect(resolveDmTarget(aliases[i]!, f.env)?.threadId).toBe(rows[i]!.threadId);
    }
    const rebuiltNames = listOcsNames(f.env);
    expect(rows.map((r) => codexRosterName(r, rebuiltNames, f.env))).toEqual(aliases);
  });

  test("does not expose generated setup instructions as a chat title", () => {
    const f = fixture();
    add(f, A, "temporary");
    f.db.query("UPDATE threads SET name = NULL, title = ?, cwd = ? WHERE id = ?")
      .run("<system_instruction> generated context </system_instruction>", "/project/miami", A);
    f.db.close();
    expect(listCodexRosterSessions(f.root)[0]!.summary).toBe("Codex in miami");
  });

  test("preserves a user-assigned alias", () => {
    const f = fixture();
    add(f, A, "Audit pilot prompts");
    f.db.close();
    expect(setOcsName("reviewer", { kind: "codex", id: A }, { env: f.env }).ok).toBe(true);
    expect(codexRosterName(listCodexRosterSessions(f.root)[0]!, listOcsNames(f.env), f.env)).toBe("reviewer");
  });

  test("sidebar renames update labels while keeping the existing routing address", () => {
    const f = fixture();
    add(f, A, "Audit pilot prompts");
    const before = listCodexRosterSessions(f.root)[0]!;
    const address = codexRosterName(before, listOcsNames(f.env), f.env)!;
    f.db.query("UPDATE threads SET name = ? WHERE id = ?").run("Mega dataset audit", A);
    f.db.close();
    const after = listCodexRosterSessions(f.root)[0]!;
    expect(after.summary).toBe("Mega dataset audit");
    expect(codexRosterName(after, listOcsNames(f.env), f.env)).toBe(address);
    expect(resolveDmTarget(address, f.env)?.threadId).toBe(A);
  });

  test("sidebar renames preserve an explicitly assigned address", () => {
    const f = fixture();
    add(f, A, "Audit pilot prompts");
    expect(setOcsName("dataset-reviewer", { kind: "codex", id: A }, { env: f.env }).ok).toBe(true);
    f.db.query("UPDATE threads SET name = ? WHERE id = ?").run("Mega dataset audit", A);
    f.db.close();
    const after = listCodexRosterSessions(f.root)[0]!;
    expect(after.summary).toBe("Mega dataset audit");
    expect(codexRosterName(after, listOcsNames(f.env), f.env)).toBe("dataset-reviewer");
    expect(resolveDmTarget("dataset-reviewer", f.env)?.threadId).toBe(A);
  });
});
