import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export type ShellKind = "posix" | "powershell" | "cmd";

export function shellKind(shell: string): ShellKind {
  const name = basename(shell.replaceAll("\\", "/"))
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (name === "pwsh" || name === "powershell") return "powershell";
  if (name === "cmd") return "cmd";
  return "posix";
}

/** `/bin/bash` (or `/bin/sh`) on POSIX; on Windows PowerShell 7, then Windows PowerShell, then cmd.exe. */
export function defaultShell(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
  which: (name: string) => string | null = (n) => Bun.which(n),
): string {
  if (platform === "win32") {
    return which("pwsh") ?? which("powershell") ?? process.env.ComSpec ?? "cmd.exe";
  }
  return exists("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

const MAX_BOOT_DRIFT_S = 120;

/**
 * Identifies this boot of the machine, so a pid recorded before a reboot is never taken for a live job.
 * Linux has a kernel boot id; macOS and Windows have a boot time in seconds ("t:<epoch>"), which the OS can
 * nudge a little when it adjusts the clock, so two of those match within a small drift.
 */
export function sameBoot(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return true;
  if (a.startsWith("t:") && b.startsWith("t:")) {
    return Math.abs(Number(a.slice(2)) - Number(b.slice(2))) <= MAX_BOOT_DRIFT_S;
  }
  return a === b;
}

export function parseDarwinBoot(sysctlOutput: string): string | null {
  const sec = /sec\s*=\s*(\d+)/.exec(sysctlOutput)?.[1];
  return sec ? `t:${sec}` : null;
}

let cached: string | null | undefined;

async function output(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

/** Reads the boot id once; macOS and Windows have to ask the OS, which is too slow to do per job. */
export async function initBootId(platform: NodeJS.Platform = process.platform): Promise<string | null> {
  try {
    if (platform === "linux") {
      cached = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } else if (platform === "darwin") {
      cached = parseDarwinBoot(await output(["sysctl", "-n", "kern.boottime"]));
    } else if (platform === "win32") {
      const shell = defaultShell("win32");
      const out = await output([
        shell,
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[DateTimeOffset]::new((Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToUnixTimeSeconds()",
      ]);
      cached = /^\d+$/.test(out.trim()) ? `t:${out.trim()}` : null;
    } else {
      cached = null;
    }
  } catch {
    cached = null;
  }
  return cached ?? null;
}

/** The value `initBootId` found; null when unknown, which disables the reboot check. */
export function bootId(): string | null {
  if (cached === undefined && process.platform === "linux") {
    try {
      cached = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      cached = null;
    }
  }
  return cached ?? null;
}
