import { quote, type JobFiles } from "./script";
import { type ShellKind, shellKind } from "./platform";

/** What `supervisor.ts` reads from job.json. */
export interface SupervisorConfig {
  /** The program and its arguments. */
  argv: string[];
  /** Directory the program starts in. */
  cwd: string;
  stdin: boolean;
  files: Pick<JobFiles, "log" | "exit" | "pid" | "cwd" | "stdin" | "stdinEof">;
}

export interface Launch {
  config: SupervisorConfig;
  /** A script file the program runs, when the command can't be passed as an argument safely. */
  script?: { path: string; content: string };
}

const BOM = "﻿";

const psQuote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/**
 * PowerShell script: UTF-8 output, the user's command, then the final directory and an exit code that
 * means what the command's last step said (a failed native command's own code, 1 for a failed cmdlet).
 */
function powershellScript(command: string, cwdFile: string): string {
  return [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$ProgressPreference = 'SilentlyContinue'",
    command,
    "$__ok = $?",
    "$__code = $LASTEXITCODE",
    `[System.IO.File]::WriteAllText(${psQuote(cwdFile)}, (Get-Location).Path)`,
    "if ($__ok) { exit 0 } elseif ($null -ne $__code -and $__code -ne 0) { exit $__code } else { exit 1 }",
    "",
  ].join("\r\n");
}

/** cmd.exe batch file: UTF-8 code page, enter the directory, the command, then record the directory and exit with its code. */
function cmdScript(command: string, cwd: string, cwdFile: string): string {
  return [
    "@echo off",
    "chcp 65001 >nul",
    `cd /d "${cwd}"`,
    command,
    "set __valet_rc=%ERRORLEVEL%",
    `cd > "${cwdFile}"`,
    "exit /b %__valet_rc%",
    "",
  ].join("\r\n");
}

export function supervisorLaunch(o: {
  files: JobFiles;
  shell: string;
  cwd: string;
  command: string;
  stdin: boolean;
}): Launch {
  const { files } = o;
  const kind: ShellKind = shellKind(o.shell);
  const common = { stdin: o.stdin, files };
  if (kind === "powershell") {
    return {
      config: {
        ...common,
        cwd: o.cwd,
        argv: [
          o.shell,
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          `${files.script}.ps1`,
        ],
      },
      script: { path: `${files.script}.ps1`, content: BOM + powershellScript(o.command, files.cwd) },
    };
  }
  if (kind === "cmd") {
    return {
      config: { ...common, cwd: files.dir, argv: [o.shell, "/d", "/c", "command.cmd"] },
      script: { path: `${files.script}.cmd`, content: cmdScript(o.command, o.cwd, files.cwd) },
    };
  }
  const script = `trap ${quote(`pwd > ${quote(files.cwd)} 2>/dev/null`)} EXIT\n${o.command}`;
  return { config: { ...common, cwd: o.cwd, argv: [o.shell, "-c", script] } };
}
