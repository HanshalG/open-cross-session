// Background processes (LAN daemon, idle watcher, wake helper, update check) must hold only
// the handles they need (issue #38).
//
// On Windows, libuv always calls CreateProcessW with bInheritHandles=TRUE, so `stdio: "ignore"`
// is not enough: every inheritable handle in this process leaks into the child too. The usual
// one is our own stdout/stderr — PowerShell `ocs lan up *> out.txt` hands us an inheritable
// handle to out.txt, and the daemon then keeps that file locked until it restarts. Clearing
// HANDLE_FLAG_INHERIT on our three std handles stops that; we can still write to them, and
// `stdio: "inherit"` children still work because libuv duplicates stdio handles explicitly.
// Unix needs nothing: Node/Bun open everything close-on-exec and stdio "ignore" is /dev/null.

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const STD_HANDLES = [-10, -11, -12] as const; // STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE
const HANDLE_FLAG_INHERIT = 1;
const INVALID_HANDLE = 0xffffffffffffffffn;

export interface StdHandleApi {
  getStdHandle(id: number): bigint;
  clearInherit(handle: bigint): boolean;
}

function kernel32(): StdHandleApi | null {
  try {
    const { dlopen } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("kernel32.dll", {
      GetStdHandle: { args: ["i32"], returns: "u64" },
      SetHandleInformation: { args: ["u64", "u32", "u32"], returns: "i32" },
    });
    return {
      getStdHandle: (id) => BigInt(lib.symbols.GetStdHandle(id) as number | bigint),
      clearInherit: (handle) => lib.symbols.SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) !== 0,
    };
  } catch {
    return null;
  }
}

/** Mark this process's std handles non-inheritable. Returns how many were cleared. Never throws. */
export function stopStdHandleInheritance(
  platform: NodeJS.Platform = process.platform,
  api: () => StdHandleApi | null = kernel32,
): number {
  if (platform !== "win32") return 0;
  const lib = api();
  if (lib === null) return 0;
  let cleared = 0;
  for (const id of STD_HANDLES) {
    try {
      const handle = lib.getStdHandle(id);
      if (handle === 0n || handle === INVALID_HANDLE) continue;
      if (lib.clearInherit(handle)) cleared++;
    } catch {
      // best effort: a handle we cannot touch is no reason to not start the background process
    }
  }
  return cleared;
}

/** `spawn` for processes that outlive us: detached, and on Windows without our std handles. */
export function spawnDetached(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  stopStdHandleInheritance();
  return spawn(command, args, { ...options, detached: true });
}
