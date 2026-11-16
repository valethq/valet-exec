import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { PluginStorage, ToolCall, ToolDefinition, ToolResult } from "@valethq/sdk";
import { MAX_WAIT_MS, type OnExit, type RunnerKind, type Settings } from "./config";
import { killNote, shellPhrase, whereJobsRun } from "./describe";
import type { Job } from "./db";
import { duration, elapsed, failed, oneLine, statusText } from "./format";
import type { JobManager } from "./jobs";
import { excerpt, readRange, sizeOf } from "./output";

export interface ToolDeps {
  manager: JobManager;
  kv: PluginStorage["kv"];
  settings(): Settings;
  /** The runner jobs start with; it shapes the tool descriptions. */
  runner: RunnerKind;
  /** True while valet is stopping: an aborted call then leaves its job running instead of killing it. */
  stopping(): boolean;
}

interface ExecInput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  description?: string;
  yieldMs?: number;
  background?: boolean;
  timeoutSec?: number;
  stdin?: boolean;
  onExit?: OnExit;
  /** Claude Code Bash shape, so `toolAliases: { Bash: "exec" }` works: kill timeout in ms. */
  timeout?: number;
  /** Claude Code Bash shape. */
  run_in_background?: boolean;
}

interface ProcessInput {
  action: "list" | "poll" | "log" | "write" | "kill";
  jobId?: number | string;
  waitMs?: number;
  offset?: number;
  limit?: number;
  data?: string;
  eof?: boolean;
  signal?: string;
}

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL", "SIGQUIT", "SIGUSR1", "SIGUSR2"] as const;
const LOG_LIMIT = 30_000;
const LOG_LIMIT_MAX = 200_000;
const ON_EXIT_TEXT: Record<OnExit, string> = {
  notify: "You will be notified in this session when it ends",
  none: "You will not be notified when it ends",
};

const text = (t: string, isError = false, meta?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: t }],
  ...(isError && { isError }),
  ...(meta && { meta }),
});

const cwdKey = (sessionId: string) => `cwd:${sessionId}`;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p);

function finished(deps: ToolDeps, job: Job): ToolResult {
  const s = deps.settings();
  const log = deps.manager.files(job).log;
  const size = sizeOf(log);
  const out = excerpt(log, 0, size, s.headBytes, s.tailBytes).text;
  const body = out ? (out.endsWith("\n") ? out : `${out}\n`) : "(no output)\n";
  return text(`${body}[job ${job.id} · ${statusText(job)} · ${duration(elapsed(job))}]`, failed(job), {
    jobId: job.id,
    status: job.status,
    exitCode: job.exitCode,
    durationMs: elapsed(job),
    log,
    bytes: size,
  });
}

function rememberCwd(deps: ToolDeps, job: Job, sessionId: string): void {
  try {
    const dir = readFileSync(deps.manager.files(job).cwd, "utf8").trim();
    if (dir && isDir(dir)) deps.kv.set(cwdKey(sessionId), dir);
  } catch {}
}

function resolveCwd(deps: ToolDeps, call: ToolCall, asked: string | undefined): string {
  const kept = deps.kv.get<string>(cwdKey(call.sessionId));
  const base = kept && isDir(kept) ? kept : call.cwd;
  return asked ? resolve(base, expandHome(asked)) : base;
}

function ownerOnly(call: ToolCall): ToolResult | undefined {
  return call.role === "owner" ? undefined : text("exec is only available to the owner.", true);
}

const execDescription = (
  deps: ToolDeps,
) => `Run a shell command (${shellPhrase(deps.settings().shell)}) on the host. Use this for anything you would do in a terminal: builds, tests, git, package managers, system administration.

- The call waits up to yieldMs (default 10s) for the command. If it finishes, you get its combined stdout+stderr and exit status. If not, it keeps running as a background job and you get the job id and the output so far; follow up with the process tool (poll with waitMs to block until it ends, log to page output, write for stdin, kill).
- Jobs run ${whereJobsRun(deps.runner)}, outside valet: they survive valet restarts, and their memory is not valet's.
- The working directory persists between calls in a session (a trailing \`cd\` sticks), starting at the project workspace. cwd overrides it for one call.
- background: true returns right away. When a background job ends you are notified with a message holding its exit status and the end of its output, which starts a new turn if you are idle, so you do not need to poll or sleep. Pass onExit: "none" to opt out.
- Long output is cut to the start and the end; the full log stays readable with process log.
- stdin is empty unless stdin: true, which opens a pipe that process write feeds. There is no TTY, so interactive programs will not work: use non-interactive flags.`;

const processDescription = (deps: ToolDeps) => `Manage jobs started by exec.

- list: recent jobs, running first.
- poll: status plus output since the last poll. waitMs (max 600000) blocks until the job ends or the time passes, streaming output.
- log: page the full log. offset is a byte offset (negative counts from the end; default: the last ${LOG_LIMIT} bytes), limit defaults to ${LOG_LIMIT}.
- write: send data to the job's stdin (needs exec stdin: true); eof: true closes stdin after writing.
- kill: SIGTERM, then SIGKILL after 5s. signal sends one specific signal instead.${killNote(deps.runner)}`;

export function execTool(deps: ToolDeps): ToolDefinition<ExecInput> {
  return {
    name: "exec",
    description: execDescription(deps),
    minRole: "owner",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: {
          type: "string",
          description: `The command, run with ${shellPhrase(deps.settings().shell)}.`,
        },
        description: { type: "string", description: "Short label for the job list, e.g. 'Run unit tests'." },
        cwd: { type: "string", description: "Working directory for this call, relative to the current one." },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Extra environment variables.",
        },
        yieldMs: {
          type: "number",
          description: `How long to wait for the command before backgrounding it. Default 10000, max ${MAX_WAIT_MS}.`,
        },
        background: { type: "boolean", description: "Start as a background job and return immediately." },
        timeoutSec: {
          type: "number",
          description: "Kill the job after this many seconds. Default: no limit.",
        },
        stdin: { type: "boolean", description: "Open a stdin pipe that process write can feed." },
        onExit: {
          type: "string",
          enum: ["notify", "none"],
          description: "Whether to notify this session when a background job ends. Default notify.",
        },
      },
    },
    async invoke(input, call) {
      const denied = ownerOnly(call);
      if (denied) return denied;
      if (typeof input?.command !== "string" || !input.command.trim()) {
        return text("exec needs a non-empty command.", true);
      }
      const s = deps.settings();
      const cwd = resolveCwd(deps, call, input.cwd);
      if (!isDir(cwd)) return text(`cwd does not exist or is not a directory: ${cwd}`, true);
      const background = input.background ?? input.run_in_background ?? false;
      const timeoutSec = input.timeoutSec ?? (input.timeout ? Math.ceil(input.timeout / 1000) : undefined);
      const onExit = input.onExit ?? s.onExit;
      const job = await deps.manager.start({
        command: input.command,
        cwd,
        ...(input.env && { env: input.env }),
        ...(input.description && { label: input.description }),
        ...(timeoutSec && { timeoutSec }),
        stdin: input.stdin ?? false,
        background,
        onExit,
        sessionId: call.sessionId,
        runId: call.runId,
        callId: call.callId,
        ...(call.caller.actor && { principalId: call.caller.actor.principalId }),
      });
      if (background) {
        return text(
          `Started job ${job.id} in the background (cwd ${cwd}). ${ON_EXIT_TEXT[onExit]}. Check it with process poll.`,
          false,
          { jobId: job.id, status: "running" },
        );
      }
      const yieldMs = Math.min(Math.max(input.yieldMs ?? s.yieldMs, 0), MAX_WAIT_MS);
      const outcome = await deps.manager.wait(job.id, yieldMs, call.signal, (d) =>
        call.progress({ outputDelta: d }),
      );
      if (outcome === "aborted") {
        if (deps.stopping()) {
          deps.manager.markBackground(job.id);
          return text(`valet is stopping; job ${job.id} keeps running in the background.`, true);
        }
        await deps.manager.kill(job.id, "cancelled");
        await deps.manager.wait(job.id, 6000);
      }
      if (outcome === "timeout") deps.manager.markBackground(job.id);
      const now = deps.manager.get(job.id) ?? job;
      if (now.status !== "running") {
        if (outcome === "done") rememberCwd(deps, now, call.sessionId);
        return finished(deps, now);
      }
      const log = deps.manager.files(now).log;
      const size = sizeOf(log);
      deps.manager.setPollOffset(now.id, size);
      const so = excerpt(log, 0, size, s.headBytes, s.tailBytes).text;
      return text(
        `Still running after ${duration(elapsed(now))}; it is now background job ${now.id}. ${ON_EXIT_TEXT[now.onExit]}.\n` +
          `Output so far:\n${so || "(none)"}\n[job ${now.id} · running · process poll/log/write/kill with jobId ${now.id}]`,
        false,
        { jobId: now.id, status: "running", log },
      );
    },
  };
}

export function processTool(deps: ToolDeps): ToolDefinition<ProcessInput> {
  const lookup = (input: ProcessInput): Job | ToolResult => {
    const id = Number(input.jobId);
    if (!Number.isInteger(id) || id <= 0) return text(`process ${input.action} needs a jobId.`, true);
    return deps.manager.get(id) ?? text(`No job ${id}.`, true);
  };
  const isJob = (j: Job | ToolResult): j is Job => "id" in j;

  return {
    name: "process",
    description: processDescription(deps),
    minRole: "owner",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["list", "poll", "log", "write", "kill"] },
        jobId: { type: "number" },
        waitMs: { type: "number", description: "poll: block up to this long for the job to end." },
        offset: { type: "number", description: "log: byte offset; negative counts from the end." },
        limit: { type: "number", description: `log: bytes to read (default ${LOG_LIMIT}).` },
        data: { type: "string", description: "write: text for stdin (include the trailing newline)." },
        eof: { type: "boolean", description: "write: close stdin after writing." },
        signal: { type: "string", enum: [...SIGNALS], description: "kill: send only this signal." },
      },
    },
    async invoke(input, call) {
      const denied = ownerOnly(call);
      if (denied) return denied;
      const s = deps.settings();
      if (input?.action === "list") {
        const jobs = deps.manager.recentJobs(20);
        if (jobs.length === 0) return text("No jobs yet.");
        const lines = jobs.map(
          (j) =>
            `${j.id}\t${statusText(j).split(" (")[0]}\t${duration(elapsed(j))}\t${j.sessionId === call.sessionId ? "this session" : "other session"}\t${oneLine(j.label ?? j.command, 80)}`,
        );
        return text(`id\tstatus\ttime\tsession\tjob\n${lines.join("\n")}`);
      }
      const found = lookup(input);
      if (!isJob(found)) return found;
      let job = found;
      const log = deps.manager.files(job).log;
      switch (input.action) {
        case "poll": {
          if (job.status === "running" && input.waitMs) {
            await deps.manager.wait(job.id, Math.min(input.waitMs, MAX_WAIT_MS), call.signal, (d) =>
              call.progress({ outputDelta: d }),
            );
            job = deps.manager.get(job.id) ?? job;
          }
          const size = sizeOf(log);
          const out = excerpt(log, Math.min(job.pollOffset, size), size, s.headBytes, s.tailBytes).text;
          deps.manager.setPollOffset(job.id, size);
          return text(
            `${out ? (out.endsWith("\n") ? out : `${out}\n`) : "(no new output)\n"}[job ${job.id} · ${statusText(job)} · ${duration(elapsed(job))}]`,
            failed(job),
            { jobId: job.id, status: job.status, exitCode: job.exitCode },
          );
        }
        case "log": {
          const size = sizeOf(log);
          const limit = Math.min(Math.max(input.limit ?? LOG_LIMIT, 1), LOG_LIMIT_MAX);
          const from =
            input.offset === undefined
              ? Math.max(0, size - limit)
              : input.offset < 0
                ? Math.max(0, size + input.offset)
                : Math.min(input.offset, size);
          const to = Math.min(size, from + limit);
          const body = new TextDecoder().decode(readRange(log, from, to));
          return text(`${body}\n[job ${job.id} · bytes ${from}-${to} of ${size} · ${log}]`);
        }
        case "write": {
          try {
            await deps.manager.write(job.id, input.data ?? "", input.eof ?? false);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
          const n = new TextEncoder().encode(input.data ?? "").length;
          return text(`Wrote ${n} bytes to job ${job.id}${input.eof ? " and closed stdin" : ""}.`);
        }
        case "kill": {
          if (job.status !== "running") return text(`Job ${job.id} already ended: ${statusText(job)}.`);
          const sig = SIGNALS.find((x) => x === input.signal);
          await deps.manager.kill(job.id, "user", sig);
          if (!sig || sig === "SIGTERM" || sig === "SIGKILL") await deps.manager.wait(job.id, 7000);
          job = deps.manager.get(job.id) ?? job;
          return text(`Job ${job.id}: ${sig && sig !== "SIGTERM" ? `sent ${sig}, ` : ""}${statusText(job)}.`);
        }
        default:
          return text(`Unknown action "${String(input?.action)}".`, true);
      }
    },
  };
}
