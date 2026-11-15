import type { PluginContext } from "@valethq/sdk";
import type { ExecConfig } from "./config";
import type { Job } from "./db";
import type { JobSummary } from "./events";
import { duration, elapsed, oneLine, statusText } from "./format";
import { excerpt, sizeOf } from "./output";
import { jobFiles } from "./script";

const TAIL_BYTES = 2048;

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

/**
 * Tells the model its background job ended: a system message with `meta.notification`, which valet-agent runs on
 * like a user message. A job the model or user killed themselves is not news, so it stays quiet.
 */
export async function announce(ctx: PluginContext<ExecConfig>, job: Job): Promise<void> {
  if (!job.background || !job.sessionId || job.onExit === "none") return;
  if (job.killReason === "user" || job.killReason === "cancelled") return;
  if (!ctx.store.sessions.get(job.sessionId)) return;
  if (!job.principalId) {
    ctx.log.warn("no principal behind the job; not notifying", { jobId: job.id });
    return;
  }
  const log = jobFiles(job.dir).log;
  const size = sizeOf(log);
  const tail = excerpt(log, Math.max(0, size - TAIL_BYTES), size, 0, TAIL_BYTES).text.trimEnd();
  const line = `exec job ${job.id} ${statusText(job)} after ${duration(elapsed(job))}: ${oneLine(job.label ?? job.command, 100)}`;
  const text = `[valet-exec] ${line}\n\nLast output:\n${tail || "(none)"}\n\n(process log with jobId ${job.id} has the full log.)`;
  await ctx.store.as({ principalId: job.principalId }).messages.create({
    sessionId: job.sessionId,
    role: "system",
    authorPrincipalId: job.principalId,
    meta: { notification: { source: "valet-exec", kind: "job-end", jobId: job.id } },
    parts: [{ type: "text", text }],
  });
}
