import { existsSync } from "node:fs";

export type RunnerKind = "systemd" | "detached";
export type OnExit = "notice" | "wake" | "none";

export interface ExecConfig {
  /** How jobs are detached from valet. "auto" picks systemd user units when available, else a detached process group. */
  runner?: "auto" | RunnerKind;
  /** Shell that runs each command with `-c`. Default /bin/bash, or /bin/sh when bash is missing. */
  shell?: string;
  /** Default time an exec call waits for its command before backgrounding it. Default 10000. */
  yieldMs?: number;
  /** Start jobs with valet's own environment (plus the call's `env`). Default true. */
  inheritEnv?: boolean;
  /** Default for what happens in the session when a background job ends. Default "notice". */
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
    shell: cfg?.shell ?? (existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh"),
    yieldMs: Math.min(cfg?.yieldMs ?? 10_000, MAX_WAIT_MS),
    inheritEnv: cfg?.inheritEnv ?? true,
    onExit: cfg?.onExit ?? "notice",
    retentionMs: (cfg?.logRetentionDays ?? 14) * 86_400_000,
    headBytes: cfg?.headBytes ?? 2048,
    tailBytes: cfg?.tailBytes ?? 30_720,
  };
}
