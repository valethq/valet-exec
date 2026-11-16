import { basename } from "node:path";
import type { RunnerKind } from "./config";
import { shellKind } from "./platform";

/** How the shell is invoked, for the tool text: "bash -c", "PowerShell" or "cmd.exe". */
export function shellPhrase(shell: string): string {
  const kind = shellKind(shell);
  if (kind === "powershell") return "PowerShell";
  if (kind === "cmd") return "cmd.exe";
  return `${basename(shell)} -c`;
}

const WHERE: Record<RunnerKind, string> = {
  systemd: "in their own systemd unit",
  launchd: "as their own launchd job",
  detached: "in their own process group",
  supervisor: "under their own detached supervisor process",
};

export function whereJobsRun(runner: RunnerKind): string {
  return WHERE[runner];
}

export function killNote(runner: RunnerKind): string {
  return runner === "supervisor" && process.platform === "win32"
    ? " On Windows the first step ends the whole process tree at once (there is no graceful signal), and only the signals SIGTERM, SIGKILL, SIGINT, SIGHUP and SIGQUIT are accepted."
    : "";
}
