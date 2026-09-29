import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("release workflow signs and smokes macOS binaries before packaging", () => {
  const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
  const sign = workflow.indexOf("codesign --force --sign - ocs");
  const verify = workflow.indexOf("codesign --verify --deep --strict --verbose=4 ocs");
  const smoke = workflow.indexOf("run: ./ocs help");
  const archive = workflow.indexOf("tar -czf ${{ matrix.asset }}.tar.gz ocs");
  expect(workflow).toContain("os: macos-26\n            target: bun-darwin-arm64");
  expect(workflow).toContain("os: macos-26-intel\n            target: bun-darwin-x64");
  expect(sign).toBeGreaterThan(0);
  expect(verify).toBeGreaterThan(sign);
  expect(smoke).toBeGreaterThan(verify);
  expect(archive).toBeGreaterThan(smoke);
});

test("release workflow builds, smokes, and checksums the Windows binary on real Windows", () => {
  const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
  const win = workflow.slice(workflow.indexOf("  windows:"));
  expect(win).toContain("runs-on: windows-latest");
  const build = win.indexOf("--target=bun-windows-x64 src/cli.ts --outfile ocs.exe");
  const smoke = win.indexOf("./ocs.exe help");
  const zip = win.indexOf("7z a -tzip ocs-windows-x64.zip ocs.exe");
  const sum = win.indexOf("sha256sum ocs-windows-x64.zip > ocs-windows-x64.zip.sha256");
  expect(build).toBeGreaterThan(0);
  expect(smoke).toBeGreaterThan(build);
  expect(zip).toBeGreaterThan(smoke);
  expect(sum).toBeGreaterThan(zip);
});

test("macOS CI signs the compiled binary before its smoke test", () => {
  const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");
  const build = workflow.indexOf("bun build --compile src/cli.ts --outfile /tmp/ocs");
  const sign = workflow.indexOf("codesign --force --sign - /tmp/ocs");
  const verify = workflow.indexOf("codesign --verify --deep --strict --verbose=4 /tmp/ocs");
  const smoke = workflow.indexOf("/tmp/ocs help");
  expect(build).toBeGreaterThan(0);
  expect(sign).toBeGreaterThan(build);
  expect(verify).toBeGreaterThan(sign);
  expect(smoke).toBeGreaterThan(verify);
});
