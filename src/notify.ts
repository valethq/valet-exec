import type { PluginContext } from "@valethq/sdk";
import type { ExecConfig } from "./config";
import type { Job } from "./db";
import type { JobSummary } from "./events";
import { duration, elapsed, failed, oneLine, statusText } from "./format";
import { excerpt, sizeOf } from "./output";
import { jobFiles } from "./script";

const WAKE_TAIL = 2048;

export function summary(job: Job): JobSummary {
  return {
    jobId: job.id,
    sessionId: job.sessionId,
    command: job.command,
    label: job.label,
    status: job.status,
    exitCode: job.exitCode,
    killReason: job.killReason,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
  };
}

/** Posts a background job's end in its session: a notice, or a user message that starts a run ("wake"). */
export async function announce(ctx: PluginContext<ExecConfig>, job: Job): Promise<void> {
  if (!job.background || !job.sessionId || job.onExit === "none") return;
  if (!ctx.store.sessions.get(job.sessionId)) return;
  const line = `exec job ${job.id} ${statusText(job)} after ${duration(elapsed(job))}: ${oneLine(job.label ?? job.command, 100)}`;
  if (job.onExit === "wake" && job.principalId) {
    const log = jobFiles(job.dir).log;
    const size = sizeOf(log);
    const tail = excerpt(log, Math.max(0, size - WAKE_TAIL), size, 0, WAKE_TAIL).text.trimEnd();
    const text = `[valet-exec] ${line}\n\nLast output:\n${tail || "(none)"}\n\n(process log with jobId ${job.id} has the full log.)`;
    await ctx.store.as({ principalId: job.principalId }).messages.create({
      sessionId: job.sessionId,
      role: "user",
      authorPrincipalId: job.principalId,
      meta: { valetExec: { jobId: job.id } },
      parts: [{ type: "text", text }],
    });
    return;
  }
  await ctx.store.messages.create({
    sessionId: job.sessionId,
    role: "system",
    meta: { valetExec: { jobId: job.id } },
    parts: [{ type: "notice", level: failed(job) ? "warn" : "info", text: line }],
  });
}
