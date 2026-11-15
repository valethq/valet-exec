import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Logger } from "@valethq/sdk";
import type { OnExit, Settings } from "./config";
import type { Job, Jobs, KillReason } from "./db";
import { readRange, sizeOf } from "./output";
import { bootId, type Runner, runners } from "./runner";
import { envScript, type JobFiles, jobFiles, wrapperScript } from "./script";

export interface JobHost {
  jobs: Jobs;
  /** Job directories go under here, one per job id. */
  dir: string;
  settings(): Settings;
  runner: Runner;
  log: Logger;
  onOutput(job: Job, delta: string, offset: number): void;
  onEnd(job: Job): void | Promise<void>;
}

export interface StartRequest {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  label?: string;
  timeoutSec?: number;
  stdin?: boolean;
  background?: boolean;
  onExit: OnExit;
  sessionId?: string;
  runId?: string;
  callId?: string;
  principalId?: string;
}

export type WaitOutcome = "done" | "timeout" | "aborted";

interface Watch {
  job: Job;
  files: JobFiles;
  offset: number;
  decoder: TextDecoder;
  lastCheck: number;
  checking: boolean;
  listeners: Set<(delta: string) => void>;
  waiters: Set<() => void>;
}

const TICK_MS = 250;
const LIVENESS_MS = 2000;
const LIVENESS_KILLING_MS = 500;
const KILL_GRACE_MS = 5000;

function readExit(path: string): number | undefined {
  try {
    const s = readFileSync(path, "utf8").trim();
    return /^\d+$/.test(s) ? Number(s) : undefined;
  } catch {
    return undefined;
  }
}

export class JobManager {
  readonly #host: JobHost;
  readonly #watched = new Map<number, Watch>();
  readonly #timer: ReturnType<typeof setInterval>;
  #ticking = false;

  constructor(host: JobHost) {
    this.#host = host;
    this.#timer = setInterval(() => void this.#tick(), TICK_MS);
  }

  files(job: Job): JobFiles {
    return jobFiles(job.dir);
  }

  get(id: number): Job | undefined {
    return this.#watched.get(id)?.job ?? this.#host.jobs.get(id);
  }

  async start(req: StartRequest): Promise<Job> {
    const { jobs, runner } = this.#host;
    const s = this.#host.settings();
    const label = req.label?.trim() || req.command.split("\n")[0]?.slice(0, 120) || "";
    let job = jobs.insert({
      sessionId: req.sessionId ?? null,
      runId: req.runId ?? null,
      callId: req.callId ?? null,
      principalId: req.principalId ?? null,
      command: req.command,
      label,
      cwd: req.cwd,
      runner: runner.kind,
      unit: null,
      pid: null,
      bootId: bootId(),
      dir: "",
      status: "running",
      exitCode: null,
      timeoutSec: req.timeoutSec ?? null,
      stdin: req.stdin ?? false,
      background: req.background ?? false,
      onExit: req.onExit,
      pollOffset: 0,
      killReason: null,
      startedAt: Date.now(),
      endedAt: null,
    });
    const dir = join(this.#host.dir, String(job.id));
    const files = jobFiles(dir);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const env = { ...(s.inheritEnv ? process.env : {}), ...req.env, VALET_EXEC_JOB: String(job.id) };
      writeFileSync(files.env, envScript(env), { mode: 0o600 });
      writeFileSync(
        files.wrapper,
        wrapperScript({ files, shell: s.shell, cwd: req.cwd, command: req.command, stdin: job.stdin }),
        { mode: 0o700 },
      );
      chmodSync(files.env, 0o600);
      writeFileSync(files.log, "");
      job = jobs.update(job.id, { dir }) as Job;
      const started = await runner.start({ id: job.id, wrapper: files.wrapper, dir, label });
      job = jobs.update(job.id, { unit: started.unit ?? null, pid: started.pid ?? null }) as Job;
    } catch (error) {
      jobs.update(job.id, { dir, status: "lost", endedAt: Date.now() });
      throw error;
    }
    this.#watch(job, 0);
    this.#host.log.info("job started", { jobId: job.id, runner: job.runner, unit: job.unit, pid: job.pid });
    return job;
  }

  /** Picks up jobs that were running when valet last stopped. Nobody is waiting on them any more. */
  reattach(): Job[] {
    const found = this.#host.jobs.running();
    for (const row of found) {
      const job = row.background ? row : (this.#host.jobs.update(row.id, { background: true }) as Job);
      this.#watch(job, sizeOf(jobFiles(job.dir).log));
    }
    return found;
  }

  recentJobs(limit: number): Job[] {
    return this.#host.jobs.recent(limit).map((j) => this.#watched.get(j.id)?.job ?? j);
  }

  markBackground(id: number): void {
    const w = this.#watched.get(id);
    if (!w || w.job.background) return;
    w.job = this.#host.jobs.update(id, { background: true }) ?? w.job;
  }

  /** Waits until the job ends, `ms` passes or `signal` aborts, streaming new output to `onDelta`. */
  wait(
    id: number,
    ms: number,
    signal?: AbortSignal,
    onDelta?: (delta: string) => void,
  ): Promise<WaitOutcome> {
    const w = this.#watched.get(id);
    if (!w) return Promise.resolve("done");
    if (signal?.aborted) return Promise.resolve("aborted");
    return new Promise((resolve) => {
      const finish = (outcome: WaitOutcome) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        w.waiters.delete(onDone);
        if (onDelta) w.listeners.delete(onDelta);
        resolve(outcome);
      };
      const onDone = () => finish("done");
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), Math.max(0, ms));
      w.waiters.add(onDone);
      if (onDelta) w.listeners.add(onDelta);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** SIGTERM by default, then SIGKILL if the job is still running after a grace period. */
  async kill(id: number, reason: KillReason, sig: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const w = this.#watched.get(id);
    if (!w) return;
    const ending = sig === "SIGTERM" || sig === "SIGKILL";
    if (ending && !w.job.killReason) w.job = this.#host.jobs.update(id, { killReason: reason }) ?? w.job;
    await this.#runnerFor(w.job).signal(w.job, sig);
    if (sig !== "SIGTERM") return;
    setTimeout(() => {
      const still = this.#watched.get(id);
      if (still) void this.#runnerFor(still.job).signal(still.job, "SIGKILL");
    }, KILL_GRACE_MS);
  }

  /** Feeds the job's stdin FIFO. `eof` closes it once the data is written. */
  async write(id: number, data: string, eof: boolean): Promise<void> {
    const w = this.#watched.get(id);
    if (!w) throw new Error(`job ${id} is not running`);
    if (!w.job.stdin) throw new Error(`job ${id} was started without stdin: true`);
    if (data) await writeFifo(w.files.stdin, new TextEncoder().encode(data));
    if (eof) {
      const holder = Number(readFileSync(w.files.stdinHolder, "utf8").trim());
      if (holder > 0) process.kill(holder, "SIGTERM");
    }
  }

  setPollOffset(id: number, offset: number): void {
    const w = this.#watched.get(id);
    if (w) w.job.pollOffset = offset;
    this.#host.jobs.update(id, { pollOffset: offset });
  }

  /** Deletes finished jobs, and their logs, that ended before the retention window. */
  prune(): number {
    const old = this.#host.jobs.endedBefore(Date.now() - this.#host.settings().retentionMs);
    for (const job of old) {
      if (job.dir) rmSync(job.dir, { recursive: true, force: true });
      this.#host.jobs.delete(job.id);
    }
    return old.length;
  }

  /** Stops watching; the jobs themselves keep running. */
  close(): void {
    clearInterval(this.#timer);
    this.#watched.clear();
  }

  /** A job keeps the runner it started with, even if config has since picked another. */
  #runnerFor(job: Job): Runner {
    return job.runner === this.#host.runner.kind ? this.#host.runner : runners[job.runner];
  }

  #watch(job: Job, offset: number): void {
    this.#watched.set(job.id, {
      job,
      files: jobFiles(job.dir),
      offset,
      decoder: new TextDecoder(),
      lastCheck: Date.now(),
      checking: false,
      listeners: new Set(),
      waiters: new Set(),
    });
  }

  async #tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const now = Date.now();
      for (const w of [...this.#watched.values()]) {
        this.#drain(w);
        const code = readExit(w.files.exit);
        if (code !== undefined) {
          await this.#finish(w, code);
          continue;
        }
        const { timeoutSec, startedAt, killReason } = w.job;
        if (timeoutSec && !killReason && now - startedAt > timeoutSec * 1000) {
          void this.kill(w.job.id, "timeout");
        }
        const every = w.job.killReason ? LIVENESS_KILLING_MS : LIVENESS_MS;
        if (!w.checking && now - w.lastCheck >= every) void this.#checkAlive(w);
      }
    } catch (error) {
      this.#host.log.error("tick failed", { error: String(error) });
    } finally {
      this.#ticking = false;
    }
  }

  async #checkAlive(w: Watch): Promise<void> {
    w.checking = true;
    try {
      const alive = await this.#runnerFor(w.job).alive(w.job);
      w.lastCheck = Date.now();
      if (alive || !this.#watched.has(w.job.id)) return;
      this.#drain(w);
      await this.#finish(w, readExit(w.files.exit) ?? null);
    } finally {
      w.checking = false;
    }
  }

  #drain(w: Watch): void {
    const size = sizeOf(w.files.log);
    if (size <= w.offset) return;
    const bytes = readRange(w.files.log, w.offset, size);
    const at = w.offset;
    w.offset += bytes.length;
    const delta = w.decoder.decode(bytes, { stream: true });
    if (!delta) return;
    this.#host.onOutput(w.job, delta, at);
    for (const fn of w.listeners) fn(delta);
  }

  async #finish(w: Watch, exitCode: number | null): Promise<void> {
    if (!this.#watched.delete(w.job.id)) return;
    const status = w.job.killReason ? "killed" : exitCode === null ? "lost" : "exited";
    const job = this.#host.jobs.update(w.job.id, { status, exitCode, endedAt: Date.now() }) ?? w.job;
    this.#host.log.info("job ended", { jobId: job.id, status, exitCode });
    for (const fn of w.waiters) fn();
    try {
      await this.#host.onEnd(job);
    } catch (error) {
      this.#host.log.warn("job end handler failed", { jobId: job.id, error: String(error) });
    }
  }
}

async function writeFifo(path: string, bytes: Uint8Array): Promise<void> {
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENXIO") throw new Error("the job is not reading stdin");
    throw error;
  }
  try {
    let done = 0;
    const deadline = Date.now() + 5000;
    while (done < bytes.length) {
      try {
        done += writeSync(fd, bytes, done);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
        if (Date.now() > deadline) throw new Error(`stdin is full; wrote ${done} of ${bytes.length} bytes`);
        await Bun.sleep(20);
      }
    }
  } finally {
    closeSync(fd);
  }
}
