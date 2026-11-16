import { defaultShell } from "./platform";

export type RunnerKind = "systemd" | "launchd" | "detached" | "supervisor";
export type OnExit = "notify" | "none";

export interface ExecConfig {
  /**
   * How jobs are detached from valet. "auto" picks systemd user units on Linux and launchd jobs on macOS when
   * they work, else a detached process group; on Windows it is always "supervisor", a small detached Bun
   * process per job (also usable elsewhere).
   */
  runner?: "auto" | RunnerKind;
  /**
   * Shell that runs each command (`-c` for bash and sh; PowerShell and cmd.exe are recognised by name).
   * Default /bin/bash, or /bin/sh when bash is missing; pwsh, then powershell, then cmd.exe on Windows.
   */
  shell?: string;
  /** Default time an exec call waits for its command before backgrounding it. Default 10000. */
  yieldMs?: number;
  /** Start jobs with valet's own environment (plus the call's `env`). Default true. */
  inheritEnv?: boolean;
  /** Default for whether the model is notified (and its session woken) when a background job ends. Default "notify". */
  onExit?: OnExit;
  /** Finished jobs and their logs are deleted after this many days. Default 14. */
  logRetentionDays?: number;
  /** A tool result keeps this many bytes from the start of the output... Default 2048. */
  headBytes?: number;
  /** ...and this many from the end. Default 30720. */
  tailBytes?: number;
}

export interface Settings {
  shell: string;
  yieldMs: number;
  inheritEnv: boolean;
  onExit: OnExit;
  retentionMs: number;
  headBytes: number;
  tailBytes: number;
}

export const MAX_WAIT_MS = 600_000;

export function settings(cfg: ExecConfig | undefined): Settings {
  return {
    shell: cfg?.shell ?? defaultShell(),
    yieldMs: Math.min(cfg?.yieldMs ?? 10_000, MAX_WAIT_MS),
    inheritEnv: cfg?.inheritEnv ?? true,
    onExit: cfg?.onExit ?? "notify",
    retentionMs: (cfg?.logRetentionDays ?? 14) * 86_400_000,
    headBytes: cfg?.headBytes ?? 2048,
    tailBytes: cfg?.tailBytes ?? 30_720,
  };
}
