import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALLER = join(import.meta.dir, "..", "install.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(path: string, source: string): void {
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function fixture(npxExit = 0, checksumTool: "shasum" | "sha256sum" = "shasum"): {
  root: string;
  env: Record<string, string>;
  npxLog: string;
  downloadLog: string;
  binaryLog: string;
  installDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ocs-install-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  const installDir = join(root, "install");
  const npxLog = join(root, "npx.log");
  const downloadLog = join(root, "download.log");
  const binaryLog = join(root, "binary.log");
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "uname"), `#!/bin/sh
if [ "\${1:-}" = "-s" ]; then echo Darwin; else echo arm64; fi
`);
  executable(join(bin, "curl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$INSTALL_TEST_DOWNLOAD_LOG"
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi
done
case "$out" in
  *.sha256) printf '%s\\n' 'deadbeef  archive' > "$out" ;;
  *) printf '%s\\n' 'archive' > "$out" ;;
esac
`);
  executable(join(bin, checksumTool), `#!/bin/sh
printf '%s\\n' 'deadbeef  archive'
exit "\${INSTALL_TEST_HASH_EXIT:-0}"
`);
  if (checksumTool === "sha256sum") {
    for (const tool of ["tr", "mktemp", "rm", "awk", "chmod", "mkdir", "mv", "grep"]) {
      const path = Bun.which(tool);
      if (path === null) throw new Error(`missing test utility: ${tool}`);
      symlinkSync(path, join(bin, tool));
    }
  }
  executable(join(bin, "tar"), `#!/bin/sh
dest=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then dest="$2"; shift 2; else shift; fi
done
printf '%s\\n' '#!/bin/sh' \\
  'case "$1" in' \\
  '  help) exit 0 ;;' \\
  '  version) echo "ocs 0.4.2" ;;' \\
  '  skill) echo "$*" >> "$INSTALL_TEST_BINARY_LOG" ;;' \\
  'esac' > "$dest/ocs"
chmod +x "$dest/ocs"
`);
  executable(join(bin, "npx"), `#!/bin/sh
printf '%s\\n' "$*" > "$INSTALL_TEST_NPX_LOG"
exit "\${INSTALL_TEST_NPX_EXIT:-0}"
`);
  return {
    root,
    npxLog,
    downloadLog,
    binaryLog,
    installDir,
    env: {
      ...process.env,
      PATH: checksumTool === "sha256sum" ? bin : `${bin}:/usr/bin:/bin`,
      OCS_INSTALL_DIR: installDir,
      OCS_INSTALL_SKILLS: "1",
      OCS_SKILLS_CLI_VERSION: "1.5.23",
      INSTALL_TEST_NPX_LOG: npxLog,
      INSTALL_TEST_DOWNLOAD_LOG: downloadLog,
      INSTALL_TEST_BINARY_LOG: binaryLog,
      INSTALL_TEST_NPX_EXIT: String(npxExit),
    } as Record<string, string>,
  };
}

async function run(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["/bin/sh", INSTALLER], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

describe("curl installer skill setup", () => {
  test.each(["shasum", "sha256sum"] as const)("a failed %s preserves the existing install even if it prints a matching digest", async (tool) => {
    const f = fixture(0, tool);
    mkdirSync(f.installDir, { recursive: true });
    const previous = "#!/bin/sh\nexit 0\n";
    executable(join(f.installDir, "ocs"), previous);
    f.env.INSTALL_TEST_HASH_EXIT = "1";
    const result = await run(f.env);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("cannot verify download");
    expect(readFileSync(join(f.installDir, "ocs"), "utf8")).toBe(previous);
    expect(existsSync(f.npxLog)).toBe(false);
    expect(existsSync(f.binaryLog)).toBe(false);
  });
  test("downloads this fork's binary and checksum instead of upstream releases", async () => {
    const f = fixture();
    f.env.OCS_INSTALL_SKILLS = "0";
    const result = await run(f.env);
    expect(result.code).toBe(0);
    const requests = readFileSync(f.downloadLog, "utf8");
    expect(requests).toContain("https://github.com/HanshalG/open-cross-session/releases/latest/download/ocs-darwin-arm64.tar.gz");
    expect(requests).toContain("ocs-darwin-arm64.tar.gz.sha256");
    expect(requests).not.toContain("leeguooooo");
  });
  test("pins skills add to the downloaded ocs version and targets Claude, Codex, and Pi", async () => {
    const f = fixture();
    const result = await run(f.env);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(join(f.installDir, "ocs"))).toBe(true);
    expect(readFileSync(f.npxLog, "utf8").trim()).toBe(
      "-y skills@1.5.23 add https://github.com/HanshalG/open-cross-session/tree/v0.4.2/skills/ocs " +
        "--skill ocs --global --agent claude-code --agent codex --agent pi --yes",
    );
    expect(readFileSync(f.binaryLog, "utf8").trim()).toBe("skill install");
    expect(result.stdout).toContain("skill registered via skills CLI (source: v0.4.2)");
  });

  test("skills CLI failure keeps the binary install and runs the embedded fallback", async () => {
    const f = fixture(1);
    const result = await run(f.env);
    expect(result.code).toBe(0);
    expect(existsSync(join(f.installDir, "ocs"))).toBe(true);
    expect(readFileSync(f.binaryLog, "utf8").trim()).toBe("skill install");
    expect(result.stderr).toContain("skills CLI failed; using the embedded skill installer");
  });

  test("OCS_INSTALL_SKILLS=0 installs only the binary", async () => {
    const f = fixture();
    f.env.OCS_INSTALL_SKILLS = "0";
    const result = await run(f.env);
    expect(result.code).toBe(0);
    expect(existsSync(join(f.installDir, "ocs"))).toBe(true);
    expect(existsSync(f.npxLog)).toBe(false);
    expect(existsSync(f.binaryLog)).toBe(false);
    expect(result.stdout).toContain("skill installation skipped (OCS_INSTALL_SKILLS=0)");
  });
});
