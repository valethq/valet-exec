import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { RunnerKind } from "./config";
import type { Job } from "./db";

/** Starts a job's wrapper outside valet's process tree and controls it afterwards. */
export interface Runner {
  readonly kind: RunnerKind;
  start(job: {
    id: number;
    wrapper: string;
    dir: string;
    label: string;
  }): Promise<{ unit?: string; pid?: number }>;
  alive(job: Job): Promise<boolean>;
  signal(job: Job, sig: NodeJS.Signals): Promise<void>;
}

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out: `${out}${err}`.trim() };
}

export function bootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
}

export async function systemdAvailable(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    return (await run(["systemctl", "--user", "show", "--property=Version"])).code === 0;
  } catch {
    return false;
  }
}

/**
 * Each job is a transient user unit: its own cgroup, so it survives a valet restart and its memory is not
 * valet's. KillMode=process lets daemons the command forks (`nohup x &`) outlive the job, as they would
 * under a plain shell; `signal` targets the whole cgroup with --kill-whom=all.
 */
export const systemdRunner: Runner = {
  kind: "systemd",
  async start(job) {
    const unit = `valet-exec-${job.id}-${Math.random().toString(36).slice(2, 6)}`;
    const r = await run([
      "systemd-run",
      "--user",
      "--quiet",
      "--collect",
      `--unit=${unit}`,
      `--description=valet-exec job ${job.id}: ${job.label.slice(0, 80)}`,
      "--property=KillMode=process",
      "--property=SendSIGHUP=no",
      "--",
      "/bin/sh",
      job.wrapper,
    ]);
    if (r.code !== 0) throw new Error(`systemd-run failed (${r.code}): ${r.out}`);
    return { unit };
  },
  async alive(job) {
    if (!job.unit) return false;
    const r = await run(["systemctl", "--user", "is-active", `${job.unit}.service`]);
    return r.out === "active" || r.out === "activating" || r.out === "deactivating";
  },
  async signal(job, sig) {
    if (!job.unit) return;
    await run(["systemctl", "--user", "kill", "--kill-whom=all", `--signal=${sig}`, `${job.unit}.service`]);
  },
};

// TODO(macOS): a launchd runner (`launchctl submit` or a generated LaunchAgent plist) would give jobs the
// same survival there; until then macOS gets this detached runner. See TODO.md.
/**
 * Fallback without systemd: a new session and process group, unref'd. It survives valet exiting on its own,
 * but a service manager that kills valet's whole cgroup (systemd KillMode=control-group) takes it along.
 */
export const detachedRunner: Runner = {
  kind: "detached",
  async start(job) {
    const child = spawn("/bin/sh", [job.wrapper], { cwd: job.dir, detached: true, stdio: "ignore" });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once("spawn", () => resolve(child.pid as number));
      child.once("error", reject);
    });
    child.unref();
    return { pid };
  },
  async alive(job) {
    if (!job.pid || (job.bootId && job.bootId !== bootId())) return false;
    try {
      process.kill(-job.pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  async signal(job, sig) {
    if (!job.pid || (job.bootId && job.bootId !== bootId())) return;
    try {
      process.kill(-job.pid, sig);
    } catch {}
  },
};

export async function pickRunner(want: "auto" | RunnerKind | undefined): Promise<Runner> {
  if (want === "detached") return detachedRunner;
  if (want === "systemd" || (await systemdAvailable())) return systemdRunner;
  return detachedRunner;
}

export const runners: Record<RunnerKind, Runner> = { systemd: systemdRunner, detached: detachedRunner };
