import { describe, expect, test } from "bun:test";
import { stopStdHandleInheritance, type StdHandleApi } from "../src/detach.ts";

describe("background processes do not inherit our std handles (issue #38)", () => {
  function fakeKernel(handles: Record<number, bigint>) {
    const cleared: bigint[] = [];
    const api: StdHandleApi = {
      getStdHandle: (id) => handles[id] ?? 0n,
      clearInherit: (handle) => {
        cleared.push(handle);
        return true;
      },
    };
    return { api: () => api, cleared };
  }

  test("Windows: clears HANDLE_FLAG_INHERIT on stdin, stdout and stderr", () => {
    const kernel = fakeKernel({ [-10]: 0x10n, [-11]: 0x20n, [-12]: 0x30n });
    expect(stopStdHandleInheritance("win32", kernel.api)).toBe(3);
    expect(kernel.cleared).toEqual([0x10n, 0x20n, 0x30n]);
  });

  test("Windows: skips absent and invalid std handles", () => {
    const kernel = fakeKernel({ [-10]: 0n, [-11]: 0xffffffffffffffffn, [-12]: 0x30n });
    expect(stopStdHandleInheritance("win32", kernel.api)).toBe(1);
    expect(kernel.cleared).toEqual([0x30n]);
  });

  test("Windows without kernel32 access still spawns (best effort)", () => {
    expect(stopStdHandleInheritance("win32", () => null)).toBe(0);
    const throwing: StdHandleApi = { getStdHandle: () => { throw new Error("boom"); }, clearInherit: () => true };
    expect(stopStdHandleInheritance("win32", () => throwing)).toBe(0);
  });

  test("Unix: nothing to do", () => {
    const kernel = fakeKernel({ [-11]: 0x20n });
    expect(stopStdHandleInheritance("darwin", kernel.api)).toBe(0);
    expect(stopStdHandleInheritance("linux", kernel.api)).toBe(0);
    expect(kernel.cleared).toEqual([]);
  });

  test("every detached spawn goes through spawnDetached", async () => {
    const glob = new Bun.Glob("src/**/*.ts");
    const offenders: string[] = [];
    for await (const file of glob.scan(".")) {
      if (file.endsWith("detach.ts")) continue;
      const source = await Bun.file(file).text();
      if (/\bdetached:\s*true/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
