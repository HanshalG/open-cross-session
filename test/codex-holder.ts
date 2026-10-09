import { join } from "node:path";
import { tempDir } from "./tmp";

export async function holdRolloutAsCodex(rollout: string): Promise<{ pid: number; stop: () => Promise<void> }> {
  const bin = join(tempDir("ocs-fakecodex-"), "codex");
  // macOS can kill renamed copies of its signed system binaries.
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures", "codex-rollout-holder.ts")],
    compile: { outfile: bin },
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not build Codex rollout fixture");
  if (process.platform === "darwin") {
    const signed = Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", "-", bin]);
    if (signed.exitCode !== 0) throw new Error(signed.stderr.toString());
  }
  // Reparent the fixture before discovery so running tests inside Desktop cannot
  // turn a terminal fixture into a Desktop-hosted task.
  const child = Bun.spawn([
    process.execPath, join(import.meta.dir, "fixtures", "start-codex-holder.ts"), bin, rollout,
  ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pid: number | undefined;
  try {
    const ready = (async (): Promise<void> => {
      let text = "";
      while (!text.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Codex rollout fixture exited before opening its file");
        text += new TextDecoder().decode(value);
      }
      const message = JSON.parse(text.trim()) as { pid: number };
      if (!Number.isInteger(message.pid) || message.pid <= 1) throw new Error(`Unexpected fixture output: ${text}`);
      pid = message.pid;
    })();
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Codex rollout fixture did not open its file")), 10_000); }),
    ]);
    if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());
  } catch (error) {
    if (pid !== undefined) process.kill(pid);
    if (child.exitCode === null) child.kill();
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  if (pid === undefined) throw new Error("Codex rollout fixture did not report its pid");
  const holderPid = pid;
  return {
    pid: holderPid,
    stop: async () => {
      process.kill(holderPid);
      const completion = child.stdout.getReader();
      try {
        while (!(await completion.read()).done) {}
      } finally {
        completion.releaseLock();
      }
    },
  };
}
