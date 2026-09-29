// `ocs lan autostart on|off`：登录后自动起局域网守护进程。
//
// 必须跑在用户自己的登录会话里：Windows 上 Claude 的收件箱是 `\\.\pipe\LOCAL\…`，只对同一
// 登录会话可见；macOS 的 launchd gui 域同理。所以一律用「当前用户登录项」，不用系统服务：
//   - macOS：~/Library/LaunchAgents/<label>.plist（RunAtLoad，不 KeepAlive——`ocs lan down`
//     要能真的停下来）
//   - Windows：HKCU\…\Run 值，执行 `ocs.exe lan up`（它隐藏窗口拉起守护进程后退出；直接挂
//     `_lan-daemon` 会留一个常驻控制台窗口）。不需要管理员。
//   - Linux：~/.config/systemd/user/ocs-lan.service
// 只写登录项，不顺手启动：当前要不要跑由 `ocs lan up` / `down` 决定。

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LAN_DAEMON_COMMAND } from "./lan-daemon.ts";
import { OCS_HOME_ENV } from "./store.ts";

export const AUTOSTART_LABEL = "com.leeguooooo.ocs.lan";
const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_RUN_VALUE = "ocs-lan";

export type AutostartPlan =
  | { kind: "file"; path: string; content: string; activate?: string[] }
  | { kind: "registry"; key: string; value: string; data: string };

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function quoteWindows(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function quoteSystemd(arg: string): string {
  return /[\s"\\]/.test(arg) ? `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : arg;
}

/** 纯函数：给定平台和自身命令，算出要写的登录项。测试直接断言它。 */
export function autostartPlan(
  platform: NodeJS.Platform,
  selfCommand: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): AutostartPlan | null {
  const ocsHome = env[OCS_HOME_ENV];
  if (platform === "darwin") {
    const args = [...selfCommand, LAN_DAEMON_COMMAND];
    const envBlock = typeof ocsHome === "string" && ocsHome !== ""
      ? `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>${OCS_HOME_ENV}</key>\n    <string>${xmlEscape(ocsHome)}</string>\n  </dict>\n`
      : "";
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AUTOSTART_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n")}
  </array>
${envBlock}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
    return { kind: "file", path: join(home, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`), content };
  }
  if (platform === "win32") {
    const prefix = typeof ocsHome === "string" && ocsHome !== ""
      ? `cmd /c set "${OCS_HOME_ENV}=${ocsHome}" && `
      : "";
    return {
      kind: "registry",
      key: WINDOWS_RUN_KEY,
      value: WINDOWS_RUN_VALUE,
      data: `${prefix}${[...selfCommand, "lan", "up"].map(quoteWindows).join(" ")}`,
    };
  }
  if (platform === "linux") {
    const envLine = typeof ocsHome === "string" && ocsHome !== "" ? `Environment=${quoteSystemd(`${OCS_HOME_ENV}=${ocsHome}`)}\n` : "";
    const content = `[Unit]
Description=ocs LAN daemon (open-cross-session)

[Service]
ExecStart=${[...selfCommand, LAN_DAEMON_COMMAND].map(quoteSystemd).join(" ")}
${envLine}Restart=no

[Install]
WantedBy=default.target
`;
    return {
      kind: "file",
      path: join(home, ".config", "systemd", "user", "ocs-lan.service"),
      content,
      activate: ["systemctl", "--user", "enable", "ocs-lan.service"],
    };
  }
  return null;
}

export function enableAutostart(plan: AutostartPlan): string {
  if (plan.kind === "file") {
    mkdirSync(dirname(plan.path), { recursive: true });
    writeFileSync(plan.path, plan.content, { mode: 0o644 });
    if (plan.activate !== undefined) {
      const [cmd, ...args] = plan.activate;
      spawnSync(cmd!, args, { stdio: "ignore" });
    }
    return plan.path;
  }
  const out = spawnSync("reg", ["add", plan.key, "/v", plan.value, "/t", "REG_SZ", "/d", plan.data, "/f"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (out.status !== 0) throw new Error(`reg add failed: ${out.stderr ?? out.error}`);
  return `${plan.key}\\${plan.value}`;
}

export function disableAutostart(plan: AutostartPlan): boolean {
  if (plan.kind === "file") {
    if (plan.activate !== undefined) spawnSync("systemctl", ["--user", "disable", "ocs-lan.service"], { stdio: "ignore" });
    try {
      unlinkSync(plan.path);
      return true;
    } catch {
      return false;
    }
  }
  const out = spawnSync("reg", ["delete", plan.key, "/v", plan.value, "/f"], { windowsHide: true, stdio: "ignore" });
  return out.status === 0;
}

/** 登录项存在且指向的正是这份计划（换了安装位置要重新 on）。 */
export function autostartState(plan: AutostartPlan): "on" | "stale" | "off" {
  if (plan.kind === "file") {
    try {
      return readFileSync(plan.path, "utf8") === plan.content ? "on" : "stale";
    } catch {
      return "off";
    }
  }
  const out = spawnSync("reg", ["query", plan.key, "/v", plan.value], { encoding: "utf8", windowsHide: true });
  if (out.status !== 0 || typeof out.stdout !== "string") return "off";
  return out.stdout.includes(plan.data) ? "on" : "stale";
}
