import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isCodexThreadId, listCodexSessions, type CodexSessionSummary } from "./codex-sessions.ts";
import { ocsNameFor, setOcsName, type OcsNameEntry } from "./names.ts";

interface IndexedThread {
  id: string;
  rollout_path: string;
  cwd: string;
  name: string | null;
  title: string;
  created_at: number;
}

export function listCodexRosterSessions(root: string): CodexSessionSummary[] {
  const path = join(dirname(root), "state_5.sqlite");
  if (!existsSync(path)) return listCodexSessions(root, { limit: 128 });
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, create: false });
    const rows = db.query(`
      SELECT id, rollout_path, cwd, name, title, created_at
      FROM threads
      WHERE archived = 0 AND COALESCE(thread_source, 'user') = 'user'
      ORDER BY COALESCE(recency_at_ms, updated_at_ms, updated_at * 1000) DESC
      LIMIT 128
    `).all() as IndexedThread[];
    return rows.filter((row) => isCodexThreadId(row.id) &&
      resolve(row.rollout_path).startsWith(resolve(root) + sep) && existsSync(row.rollout_path))
      .map((row) => ({
        threadId: row.id.toLowerCase(), path: row.rollout_path,
        startedAt: row.created_at * 1000,
        startedAtLabel: new Date(row.created_at * 1000).toISOString(),
        cwd: row.cwd, originator: null, source: null, branch: null,
        summary: rosterTitle(row),
      }));
  } catch {
    return listCodexSessions(root, { limit: 128 });
  } finally {
    db?.close();
  }
}

function rosterTitle(row: IndexedThread): string {
  const title = row.name?.trim() || row.title.trim();
  if (!row.name?.trim() && (title.length > 96 || /[<>\n\r]/.test(title))) {
    return `Codex in ${basename(row.cwd) || "workspace"}`;
  }
  return title.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim() || `Codex in ${basename(row.cwd) || "workspace"}`;
}

export function codexRosterName(
  session: CodexSessionSummary,
  names: readonly OcsNameEntry[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  const owner = { kind: "codex" as const, id: session.threadId };
  const existing = ocsNameFor(owner, names);
  if (existing !== null) return existing.name;
  if (session.summary === null) return undefined;
  const base = session.summary.normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 54).replace(/-+$/g, "") || "chat";
  const suffix = createHash("sha256").update(session.threadId).digest("hex").slice(0, 8);
  for (const name of [base, `${base}-${suffix}`]) {
    const result = setOcsName(name, owner, { env });
    if (result.ok) return result.entry.name;
  }
  return undefined;
}
