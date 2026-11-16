export interface RunResult {
  code: number;
  out: string;
}

/** Runs a command to completion and returns its exit code and combined output. Never throws. */
export type RunCommand = (cmd: string[]) => Promise<RunResult>;

export const run: RunCommand = async (cmd) => {
  try {
    const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, out: `${out}${err}`.trim() };
  } catch (error) {
    return { code: 127, out: error instanceof Error ? error.message : String(error) };
  }
};

/** True while a process with this pid exists. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
