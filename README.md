# valet-exec

`tools@1` provider (ARCHITECTURE 11.4) with two tools, `exec` and `process`, that give an agent a shell whose
jobs outlive valet. Owner only: both tools are hidden from and refuse `trusted` and `guest` runs.

## Tools

`exec { command, description?, cwd?, env?, yieldMs?, background?, timeoutSec?, stdin?, onExit? }`

- Runs the command with the platform's shell (`bash -c` on Linux and macOS, PowerShell on Windows; configurable) and waits up to `yieldMs` (default 10 s, max 10 min). A command that
  finishes in time returns its combined stdout+stderr and `[job N · exit 0 · 1.2s]`. One that doesn't keeps
  running as background job N, and the call returns the output so far.
- `background: true` returns immediately. When a background job ends, the model is notified: a message with
  the exit status and the tail of the log, which starts a run if the session is idle (see Notifications).
  `onExit: "none"` opts out, per call or in config. A job the model or user killed themselves, or one a `process poll` was waiting on when it ended, does not notify.
- The working directory persists per session, like a terminal: a trailing `cd` sticks for the next call.
- Output in a result is cut to the first 2 KB and last 30 KB; `process log` pages the full log.
- stdin is empty unless `stdin: true`, which opens a pipe that `process write` feeds (a FIFO on Linux and macOS, a file the supervisor tails on Windows). No PTY.
- Also accepts Claude Code's Bash input shape (`timeout` in ms, `run_in_background`), so
  `toolAliases: { "Bash": "mcp__valet__exec" }` in valet-claudecode works.

`process { action: list | poll | log | write | kill, jobId?, waitMs?, offset?, limit?, data?, eof?, signal? }`

- `poll` returns output since the last poll; `waitMs` blocks until the job ends (streaming progress).
- `kill` sends SIGTERM to the whole job, then SIGKILL after 5 s. `signal` sends just one signal.

## Platforms

| | Linux | macOS | Windows |
|---|---|---|---|
| Runner (`auto`) | `systemd` user unit, else `detached` | `launchd` job, else `detached` | `supervisor` |
| Default shell | `/bin/bash` | `/bin/bash` | `pwsh`, then `powershell`, then `cmd.exe` |
| `kill` | SIGTERM, then SIGKILL after 5 s, to the whole job | the same, to the process group | ends the whole process tree at once (`taskkill /T /F`) |
| Tested | CI and by hand | CI (a real launchd) | CI (pwsh 7, Windows PowerShell 5.1, cmd.exe) |

`runner` can force one (`systemd`, `launchd`, `detached`, `supervisor`); asking for one the OS doesn't have is an
error at start-up. `supervisor` also works on Linux and macOS, which is how the Windows runner is tested there.

### Linux: systemd units

Each job runs as a transient systemd user unit, `systemd-run --user --collect --unit=valet-exec-<id>-<rand>`,
so it lives in its own cgroup: restarting `valet.service` doesn't touch it, and its memory isn't valet's.
`KillMode=process` lets daemons the command forks (`nohup x &`) outlive the job, as in a normal shell; `kill`
still reaches the whole cgroup with `systemctl --user kill --kill-whom=all`.

### macOS: launchd jobs

Each job is its own launchd job: a plist (`job.plist` in the job directory) with `RunAtLoad`, no `KeepAlive` and
`AbandonProcessGroup` (the equivalent of `KillMode=process`), bootstrapped into `gui/<uid>`, or `user/<uid>` on a
Mac with no GUI session. It runs the same `run.sh` wrapper as Linux. Liveness is `launchctl print`, `kill` signals
the wrapper's process group and then calls `launchctl kill`, and the job is booted out when it ends. Because each
job is a launchd job, valet restarting (or being stopped by its own LaunchAgent) doesn't take running jobs with it.

### Windows: a supervisor per job

There is no `sh` and no service manager to hand a job to, so each job gets a small detached Bun process,
`src/supervisor.ts`, started with `bun supervisor.ts <job dir>`. It runs the shell, sends its output to `out.log`,
and writes `exit` last, the same files the wrapper writes elsewhere; a new valet re-attaches to it the same way.
The command goes to the shell as a generated script, not as an argument, so there is no quoting to get wrong:

- PowerShell: `command.ps1` (UTF-8 with a BOM, output forced to UTF-8). The exit code is the last native
  command's code, 1 for a failed cmdlet, 0 otherwise.
- cmd.exe: `command.cmd` (code page 65001), which `cd`s to the working directory, runs the command, and exits with
  its `ERRORLEVEL`. A command that calls `exit` itself skips recording the final directory.
- Any other shell (Git Bash, WSL's `bash.exe`) gets `-c` like on Linux.

The environment is handed to the supervisor directly, so no env file exists on this path. `process write` appends
to a `stdin` file the supervisor feeds to the command, and writes `stdin.eof` to close it. Jobs survive valet
exiting, but not a service manager that runs valet inside a Windows job object set to kill its children; if you run
valet as a service, check that.

Without a service manager (`runner: "detached"`, or `auto` when `systemctl --user` fails, or on a Mac with no
launchd) jobs run in a new session and process group instead. That survives valet exiting on its own, but not a
service manager that kills valet's whole cgroup or process group.

## What a job is

A job is a directory, `<valet data>/valet-exec/jobs/<id>/`:

- `run.sh`, `env.sh`: the wrapper and the environment it loads and deletes (the `sh` runners).
- `job.json`, `command.ps1` or `command.cmd`: what the supervisor runs (the `supervisor` runner).
- `out.log`: stdout and stderr together.
- `exit`: the exit status. Its presence means the job is done.
- `cwd`: the command's final directory, so a session can keep its `cd`.
- `stdin`, `stdin.pid` or `stdin.eof`: the stdin pipe (with `stdin: true`).

The `p_exec_jobs` table indexes jobs by session, run and call. On activate the plugin re-attaches to every job
still marked running and finishes the ones that ended while valet was down (a job with no `exit` file and no
live process is `lost`). Finished jobs and their logs are deleted after 14 days. Each job also records the boot it
started in (a kernel boot id on Linux, the boot time on macOS and Windows), so a pid left over from before a reboot
is never taken for a live job.

## Notifications

When a background job ends, the plugin posts a `system` message holding one `valet-exec/job-end@1` part, a
plugin-defined part type (ARCHITECTURE 9.4) that the plugin registers on activate. People see its title,
"Process finished: <label> (exit 0, 30s)", collapsed. The model sees its text: the status and the last 2 KB of the
log. `data` carries `jobId`, `status`, `exitCode`, `killReason`, `label` and `durationMs`. The type `wakes`, so
valet-agent runs on it like a user message, under the role of the principal who started the job.

## Events

- `exec.job.end` (action event) and `exec.output` (signal) with the job id, session and output delta.
- WS topic `exec:<jobId>`: `output` and `end` frames. Subscribing is denied below `owner`.

## Config

```json
{
  "plugins": {
    "valet-exec": {
      "config": {
        "runner": "auto",
        "shell": "/bin/bash",
        "yieldMs": 10000,
        "inheritEnv": true,
        "onExit": "notify",
        "logRetentionDays": 14,
        "headBytes": 2048,
        "tailBytes": 30720
      }
    }
  }
}
```

All keys are optional. `inheritEnv` starts jobs with valet's environment (minus systemd's own variables such as
`NOTIFY_SOCKET`); the env file is mode 0600 and deleted as soon as the wrapper has read it.
`shell` can be a full path (`C:\\Program Files\\PowerShell\\7\\pwsh.exe`); PowerShell and cmd.exe are recognised by file name.

## Replacing Claude Code's Bash

With valet-exec loaded, Claude Code sessions see `mcp__valet__exec` and `mcp__valet__process`. To take Bash
away, set this in valet-claudecode's config:

```json
{ "denyTools": ["Bash"], "toolAliases": { "Bash": "mcp__valet__exec" } }
```

`denyTools` removes Bash from the model's tool list. The alias catches the odd skill or habit that still emits a
Bash call.

## Checks

`bun run typecheck`, `bun run lint`, `bun test`. The tests for a runner skip where its OS service isn't available
(systemd, launchd) and the Windows tests skip off Windows. CI (`.github/workflows/ci.yml`) runs everything on Linux,
macOS and Windows runners.
