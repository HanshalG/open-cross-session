import { spawn } from "node:child_process";

const child = spawn(process.argv[2]!, [process.argv[3]!], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
child.unref();
