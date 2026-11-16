import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type RunCommand, run as defaultRun } from "./proc";
import type { Runner } from "./runner";

const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * One launchd job per exec job: RunAtLoad runs the wrapper once, AbandonProcessGroup lets daemons the command
 * forks outlive it (like systemd's KillMode=process), and nothing restarts it. The wrapper loads its own
 * environment from env.sh, so the plist carries none.
 */
export function plist(label: string, wrapper: string, dir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>${xml(wrapper)}</string></array>
  <key>WorkingDirectory</key><string>${xml(dir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`;
}

/** Domains to try, in order: a logged-in GUI session, then the user's background domain (SSH-only or headless Macs). */
const domains = (uid: number) => [`gui/${uid}`, `user/${uid}`];

export interface LaunchdOptions {
  run?: RunCommand;
  uid?: number;
  /** Signals the wrapper's process group (the wrapper is its leader); default `process.kill(-pid)`. */
  killGroup?: (pid: number, sig: NodeJS.Signals) => void;
}

export function launchdRunner(o: LaunchdOptions = {}): Runner {
  const run = o.run ?? defaultRun;
  const uid = o.uid ?? process.getuid?.() ?? 501;
  const killGroup =
    o.killGroup ??
    ((pid, sig) => {
      process.kill(-pid, sig);
    });

  return {
    kind: "launchd",
    launch: "sh",
    async start(job) {
      const label = `dev.valet.exec.${job.id}.${Math.random().toString(36).slice(2, 6)}`;
      const file = join(job.dir, "job.plist");
      writeFileSync(file, plist(label, job.wrapper, job.dir));
      const errors: string[] = [];
      for (const domain of domains(uid)) {
        const r = await run(["launchctl", "bootstrap", domain, file]);
        if (r.code === 0) return { unit: `${domain}/${label}` };
        errors.push(`${domain}: ${r.out || `exit ${r.code}`}`);
      }
      throw new Error(`launchctl bootstrap failed (${errors.join("; ")})`);
    },
    async alive(job) {
      if (!job.unit) return false;
      const r = await run(["launchctl", "print", job.unit]);
      return r.code === 0 && /\bstate = (running|spawn scheduled)\b|\bpid = \d+/.test(r.out);
    },
    async signal(job, sig) {
      if (!job.unit) return;
      try {
        const pid = Number(readFileSync(join(job.dir, "pid"), "utf8").trim());
        if (pid > 0) killGroup(pid, sig);
      } catch {}
      await run(["launchctl", "kill", sig.replace(/^SIG/, ""), job.unit]);
    },
    async release(job) {
      if (job.unit) await run(["launchctl", "bootout", job.unit]);
      rmSync(join(job.dir, "job.plist"), { force: true });
    },
  };
}

export async function launchdAvailable(
  run: RunCommand = defaultRun,
  uid = process.getuid?.() ?? 501,
): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  for (const domain of domains(uid)) if ((await run(["launchctl", "print", domain])).code === 0) return true;
  return false;
}
