import { spawn } from "node:child_process";
import { join } from "node:path";
import type { RunnerKind } from "./config";
import type { Job } from "./db";
import { launchdAvailable, launchdRunner } from "./launchd";
import { bootId as currentBoot, sameBoot } from "./platform";
import { pidAlive, run } from "./proc";

export interface StartJob {
  id: number;
  dir: string;
  label: string;
  /** `launch: "sh"`: the wrapper script to run with /bin/sh. */
  wrapper: string;
  /** `launch: "supervisor"`: the environment the job should see (it never touches disk). */
  env: Record<string, string>;
}

/** Starts a job outside valet's process tree and controls it afterwards. */
export interface Runner {
  readonly kind: RunnerKind;
  /** What the runner starts: the sh wrapper script (run.sh), or the supervisor program with a job.json. */
  readonly launch: "sh" | "supervisor";
  start(job: StartJob): Promise<{ unit?: string; pid?: number }>;
  alive(job: Job): Promise<boolean>;
  signal(job: Job, sig: NodeJS.Signals): Promise<void>;
  /** Called once a job has ended, to clean up whatever the runner registered for it. */
  release?(job: Job): Promise<void>;
}

export async function systemdAvailable(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  return (await run(["systemctl", "--user", "show", "--property=Version"])).code === 0;
}

/**
 * Each job is a transient user unit: its own cgroup, so it survives a valet restart and its memory is not
 * valet's. KillMode=process lets daemons the command forks (`nohup x &`) outlive the job, as they would
 * under a plain shell; `signal` targets the whole cgroup with --kill-whom=all.
 */
export const systemdRunner: Runner = {
  kind: "systemd",
  launch: "sh",
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

/**
 * Fallback without a service manager: a new session and process group, unref'd. It survives valet exiting on
 * its own, but a service manager that kills valet's whole cgroup or process group takes it along.
 */
export const detachedRunner: Runner = {
  kind: "detached",
  launch: "sh",
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
    if (!job.pid || !sameBoot(job.bootId, currentBoot())) return false;
    try {
      process.kill(-job.pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  async signal(job, sig) {
    if (!job.pid || !sameBoot(job.bootId, currentBoot())) return;
    try {
      process.kill(-job.pid, sig);
    } catch {}
  },
};

/** Ends a process and everything it started. `taskkill /T` on Windows, the process group elsewhere. */
export type TreeKill = (pid: number, sig: NodeJS.Signals) => Promise<void>;

const SUPPORTED_ON_WINDOWS = new Set<NodeJS.Signals>(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGQUIT"]);

export const treeKill: TreeKill = async (pid, sig) => {
  if (process.platform === "win32") {
    // Windows has no graceful signal for a console tree; every supported signal ends the whole tree at once.
    if (!SUPPORTED_ON_WINDOWS.has(sig)) throw new Error(`${sig} is not supported on Windows`);
    await run(["taskkill", "/PID", String(pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(-pid, sig);
  } catch {}
};

const SUPERVISOR = join(import.meta.dir, "supervisor.ts");

/**
 * A detached Bun process per job (`supervisor.ts`) runs the command and writes out.log, cwd and exit. It is the
 * Windows runner, and works anywhere Bun does. It survives valet exiting on its own, but not a service manager
 * that kills valet's whole process tree or job object.
 */
export function supervisorRunner(o: { kill?: TreeKill } = {}): Runner {
  const kill = o.kill ?? treeKill;
  return {
    kind: "supervisor",
    launch: "supervisor",
    async start(job) {
      const child = spawn(process.execPath, [SUPERVISOR, job.dir], {
        cwd: job.dir,
        env: job.env,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
      const pid = await new Promise<number>((resolve, reject) => {
        child.once("spawn", () => resolve(child.pid as number));
        child.once("error", reject);
      });
      child.unref();
      return { pid };
    },
    async alive(job) {
      return Boolean(job.pid) && sameBoot(job.bootId, currentBoot()) && pidAlive(job.pid as number);
    },
    async signal(job, sig) {
      if (!job.pid || !sameBoot(job.bootId, currentBoot())) return;
      await kill(job.pid, sig);
    },
  };
}

export const runners: Record<RunnerKind, Runner> = {
  systemd: systemdRunner,
  launchd: launchdRunner(),
  detached: detachedRunner,
  supervisor: supervisorRunner(),
};

export async function pickRunner(
  want: "auto" | RunnerKind | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<Runner> {
  const wanted = want ?? "auto";
  if (platform === "win32") {
    if (wanted === "systemd" || wanted === "launchd")
      throw new Error(`runner "${wanted}" is not available on Windows`);
    return runners.supervisor;
  }
  if (wanted === "supervisor") return runners.supervisor;
  if (wanted === "detached") return detachedRunner;
  if (wanted === "systemd") {
    if (platform !== "linux") throw new Error('runner "systemd" needs Linux');
    return systemdRunner;
  }
  if (wanted === "launchd") {
    if (platform !== "darwin") throw new Error('runner "launchd" needs macOS');
    return runners.launchd;
  }
  if (platform === "linux" && (await systemdAvailable())) return systemdRunner;
  if (platform === "darwin" && (await launchdAvailable())) return runners.launchd;
  return detachedRunner;
}
