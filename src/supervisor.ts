// Runs one job and records what happened, for platforms without the sh wrapper (Windows). Started detached by the
// supervisor runner as `bun supervisor.ts <job dir>`; it leaves the same files the sh wrapper does: out.log, pid,
// cwd (written by the command's script) and, last of all, exit.
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SupervisorConfig } from "./launch";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: supervisor.ts <job dir>");
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(join(dir, "job.json"), "utf8")) as SupervisorConfig;
const { files } = cfg;

writeFileSync(files.pid, `${process.pid}\n`);

function finish(code: number): never {
  writeFileSync(files.exit, `${code}\n`);
  process.exit(0);
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

if (!existsSync(cfg.cwd)) {
  appendFileSync(files.log, `valet-exec: cannot cd to ${cfg.cwd}\n`);
  finish(1);
}

const [program, ...args] = cfg.argv as [string, ...string[]];
const out = openSync(files.log, "a");
const child = spawn(program, args, {
  cwd: cfg.cwd,
  stdio: [cfg.stdin ? "pipe" : "ignore", out, out],
  windowsHide: true,
});

child.once("error", (error) => {
  appendFileSync(files.log, `valet-exec: cannot start ${program}: ${error.message}\n`);
  finish(127);
});
child.once("close", (code, signal) => {
  closeSync(out);
  finish(code ?? (signal ? 128 + (SIGNALS[signal] ?? 0) : 1));
});

// A signal sent to the supervisor itself (a plain `kill`) is passed on; the runner's tree kill normally ends it first.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));

// stdin: `process write` appends to the stdin file and drops stdin.eof to close it.
if (cfg.stdin && child.stdin) {
  const sink = child.stdin;
  sink.on("error", () => {});
  let offset = 0;
  const pump = setInterval(() => {
    let size = 0;
    try {
      size = statSync(files.stdin).size;
    } catch {}
    if (size > offset) {
      const fd = openSync(files.stdin, "r");
      const buf = Buffer.alloc(size - offset);
      const n = readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);
      offset += n;
      sink.write(buf.subarray(0, n));
    } else if (existsSync(files.stdinEof)) {
      clearInterval(pump);
      sink.end();
    }
  }, 50);
  child.once("close", () => clearInterval(pump));
}
