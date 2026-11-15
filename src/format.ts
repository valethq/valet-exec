import type { Job } from "./db";

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function elapsed(job: Job, now = Date.now()): number {
  return (job.endedAt ?? now) - job.startedAt;
}

/** "exit 0", "killed (timeout), exit 143", "lost", "running". */
export function statusText(job: Job): string {
  switch (job.status) {
    case "running":
      return "running";
    case "exited":
      return `exit ${job.exitCode}`;
    case "killed":
      return `killed (${job.killReason})${job.exitCode === null ? "" : `, exit ${job.exitCode}`}`;
    case "lost":
      return "lost (ended without an exit status: killed outside valet, or the machine rebooted)";
  }
}

export function failed(job: Job): boolean {
  return job.status !== "running" && !(job.status === "exited" && job.exitCode === 0);
}

export function oneLine(s: string, max: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
