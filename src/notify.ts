import type { PartTypeDefinition, PluginContext } from "@valethq/sdk";
import type { ExecConfig } from "./config";
import type { Job } from "./db";
import type { JobSummary } from "./events";
import { duration, elapsed, failed, oneLine, statusText } from "./format";
import { excerpt, sizeOf } from "./output";
import { jobFiles } from "./script";

const TAIL_BYTES = 2048;

/** The part a job-end notification holds (ARCHITECTURE 9.4). People see the title; the model sees the text. */
export const JOB_END: PartTypeDefinition = {
  id: "valet-exec/job-end@1",
  description: "A background exec job ended. The text is the status and the tail of its log.",
  schema: {
    type: "object",
    required: ["jobId", "status", "exitCode", "label", "durationMs"],
    properties: {
      jobId: { type: "integer" },
      status: { type: "string", enum: ["exited", "killed", "lost"] },
      exitCode: { type: ["integer", "null"] },
      killReason: { type: ["string", "null"] },
      label: { type: "string" },
      durationMs: { type: "number" },
    },
  },
  view: { collapsed: true, icon: "terminal", fields: ["jobId", "status", "exitCode", "durationMs"] },
  wakes: true,
};

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
 * Tells the model its background job ended: a system message holding a `valet-exec/job-end@1` part, whose type
 * wakes the session. A job the model or user killed themselves is not news, so it stays quiet.
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
  const label = oneLine(job.label ?? job.command, 100);
  await ctx.store.as({ principalId: job.principalId }).messages.create({
    sessionId: job.sessionId,
    role: "system",
    authorPrincipalId: job.principalId,
    parts: [
      {
        type: "custom",
        kind: JOB_END.id,
        title: `Process ${failed(job) ? "failed" : "finished"}: ${oneLine(label, 60)} (${statusText(job)}, ${duration(elapsed(job))})`,
        text,
        data: {
          jobId: job.id,
          status: job.status,
          exitCode: job.exitCode,
          killReason: job.killReason,
          label,
          durationMs: elapsed(job),
        },
      },
    ],
  });
}
