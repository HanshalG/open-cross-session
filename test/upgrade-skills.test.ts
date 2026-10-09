import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectSkillChannels, refreshSkills } from "../src/upgrade.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
}

function commit(cwd: string, message: string): void {
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.name=OCS test", "-c", "user.email=test@example.invalid", "commit", "-qm", message]);
}

function fixture(): { home: string; checkout: string; seed: string; skill: string } {
  const root = tempDir("ocs-upgrade-skills-");
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const checkout = join(root, "source checkout's $(not-a-command) folder");
  const home = join(root, "home");
  mkdirSync(seed);
  git(root, ["init", "-q", "--bare", "--initial-branch=main", remote]);
  git(seed, ["init", "-q", "--initial-branch=main"]);
  mkdirSync(join(seed, "skills", "ocs"), { recursive: true });
  writeFileSync(join(seed, "skills", "ocs", "SKILL.md"), "initial skill\n");
  commit(seed, "initial skill");
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-q", "origin", "main"]);
  git(root, ["clone", "-q", remote, checkout]);
  const skill = join(home, ".codex", "skills", "ocs");
  mkdirSync(join(home, ".codex", "skills"), { recursive: true });
  symlinkSync(join(checkout, "skills", "ocs"), skill);
  writeFileSync(join(seed, "skills", "ocs", "SKILL.md"), "updated skill\n");
  commit(seed, "update skill");
  git(seed, ["push", "-q", "origin", "main"]);
  return { home, checkout, seed, skill };
}

describe("Git skill upgrades", () => {
  test("refreshes a checkout whose path contains spaces and an apostrophe", () => {
    const f = fixture();
    const channels = detectSkillChannels(f.home);
    expect(channels).toHaveLength(1);
    expect(channels[0]!.channel).toBe("git-checkout");
    expect(refreshSkills(channels)[0]).toContain(": updated");
    expect(readFileSync(join(f.skill, "SKILL.md"), "utf8")).toBe("updated skill\n");
    expect(git(f.checkout, ["rev-parse", "HEAD"])).toBe(git(f.seed, ["rev-parse", "HEAD"]));
  });

  test("preserves local edits when the upstream skill changed", () => {
    const f = fixture();
    writeFileSync(join(f.skill, "SKILL.md"), "local changes\n");
    const head = git(f.checkout, ["rev-parse", "HEAD"]);
    expect(refreshSkills(detectSkillChannels(f.home))[0]).toContain(": not updated");
    expect(readFileSync(join(f.skill, "SKILL.md"), "utf8")).toBe("local changes\n");
    expect(git(f.checkout, ["rev-parse", "HEAD"])).toBe(head);
  });

  test("uses the skill's actual checkout instead of parsing its display command", () => {
    const f = fixture();
    const channels = detectSkillChannels(f.home);
    channels[0]!.update = "follow the instructions in the README";
    expect(refreshSkills(channels)[0]).toContain(": updated");
    expect(git(f.checkout, ["rev-parse", "HEAD"])).toBe(git(f.seed, ["rev-parse", "HEAD"]));
  });

  test("the printed update command works in a shell without interpreting path characters", () => {
    const f = fixture();
    const [channel] = detectSkillChannels(f.home);
    const result = spawnSync("/bin/sh", ["-c", channel!.update], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("not-a-command");
    expect(readFileSync(join(f.skill, "SKILL.md"), "utf8")).toBe("updated skill\n");
  });

  test("a removed skill link reports failure without updating its previous checkout", () => {
    const f = fixture();
    const channels = detectSkillChannels(f.home);
    const head = git(f.checkout, ["rev-parse", "HEAD"]);
    unlinkSync(f.skill);
    expect(refreshSkills(channels)[0]).toContain(": not updated");
    expect(git(f.checkout, ["rev-parse", "HEAD"])).toBe(head);
  });
});
