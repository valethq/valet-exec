import { join } from "node:path";

/** Single-quotes a string for POSIX sh. */
export const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Set by systemd for valet's own unit; meaningless (or harmful) inside a job. */
const DROPPED = new Set([
  "NOTIFY_SOCKET",
  "INVOCATION_ID",
  "JOURNAL_STREAM",
  "MANAGERPID",
  "SYSTEMD_EXEC_PID",
  "LISTEN_FDS",
  "LISTEN_PID",
  "LISTEN_FDNAMES",
  "WATCHDOG_PID",
  "WATCHDOG_USEC",
]);

/** The variables a job should see: defined, validly named, and not meant for valet's own unit. */
export function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => e[1] !== undefined && NAME.test(e[0]) && !DROPPED.has(e[0]),
    ),
  );
}

/** An `export` line per variable, sourced by the wrapper and deleted right after (it may hold secrets). */
export function envScript(env: Record<string, string | undefined>): string {
  return Object.entries(cleanEnv(env))
    .map(([k, v]) => `export ${k}=${quote(v)}\n`)
    .join("");
}

export interface JobFiles {
  dir: string;
  wrapper: string;
  env: string;
  log: string;
  exit: string;
  pid: string;
  cwd: string;
  stdin: string;
  stdinHolder: string;
  /** Supervisor launches: what to run (job.json), the generated script for PowerShell and cmd, and the EOF marker. */
  config: string;
  script: string;
  stdinEof: string;
}

export function jobFiles(dir: string): JobFiles {
  return {
    dir,
    wrapper: join(dir, "run.sh"),
    env: join(dir, "env.sh"),
    log: join(dir, "out.log"),
    exit: join(dir, "exit"),
    pid: join(dir, "pid"),
    cwd: join(dir, "cwd"),
    stdin: join(dir, "stdin"),
    stdinHolder: join(dir, "stdin.pid"),
    config: join(dir, "job.json"),
    script: join(dir, "command"),
    stdinEof: join(dir, "stdin.eof"),
  };
}

/**
 * The job's wrapper. It records its pid, loads and deletes the env file, enters `cwd`, runs the command with
 * output to out.log, and writes the exit status last. The command's final directory goes to `cwd` (EXIT trap),
 * so a session can keep `cd` between calls. With `stdin`, a FIFO feeds the command; a sleeping writer holds it
 * open until `process write` asks for EOF by killing that writer.
 */
export function wrapperScript(o: {
  files: JobFiles;
  shell: string;
  cwd: string;
  command: string;
  stdin: boolean;
}): string {
  const q = Object.fromEntries(Object.entries(o.files).map(([k, v]) => [k, quote(v)])) as Record<
    keyof JobFiles,
    string
  >;
  const script = `trap "pwd > ${q.cwd} 2>/dev/null" EXIT\n${o.command}`;
  const run = `${quote(o.shell)} -c ${quote(script)}`;
  return [
    "#!/bin/sh",
    `echo $$ > ${q.pid}`,
    // a handler (not an ignore) so the command still gets the default SIGTERM, and the wrapper lives on to record its status
    "trap : TERM INT HUP",
    `if [ -f ${q.env} ]; then . ${q.env}; rm -f ${q.env}; fi`,
    `cd ${quote(o.cwd)} || { echo "valet-exec: cannot cd to "${quote(o.cwd)} > ${q.log}; echo 1 > ${q.exit}; exit 1; }`,
    ...(o.stdin
      ? [
          `mkfifo ${q.stdin}`,
          `${run} < ${q.stdin} > ${q.log} 2>&1 &`,
          "__valet_cmd=$!",
          `sleep 2147483647 > ${q.stdin} &`,
          `echo $! > ${q.stdinHolder}`,
          "wait $__valet_cmd",
          "__valet_rc=$?",
          `kill $(cat ${q.stdinHolder}) 2>/dev/null`,
        ]
      : [`${run} < /dev/null > ${q.log} 2>&1`, "__valet_rc=$?"]),
    `echo $__valet_rc > ${q.exit}`,
    "",
  ].join("\n");
}
