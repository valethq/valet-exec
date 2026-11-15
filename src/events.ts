import type { JobStatus, KillReason } from "./db";

export interface JobSummary {
  jobId: number;
  sessionId: string | null;
  command: string;
  label: string | null;
  status: JobStatus;
  exitCode: number | null;
  killReason: KillReason | null;
  startedAt: number;
  endedAt: number | null;
}

declare module "@valethq/sdk" {
  interface ValetEvents {
    "exec.job.start": JobSummary;
    "exec.job.end": JobSummary;
  }
  interface ValetSignals {
    /** Raw output as it lands in the job's log; `offset` is the byte offset of `delta` in out.log. */
    "exec.output": { jobId: number; sessionId: string | null; delta: string; offset: number };
  }
}
