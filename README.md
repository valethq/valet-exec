# valet-exec

`tools@1` provider (ARCHITECTURE 11.4) with two tools, `exec` and `process`, that give an agent a shell whose
jobs outlive valet. Owner only: both tools are hidden from and refuse `trusted` and `guest` runs.

## Tools

`exec { command, description?, cwd?, env?, yieldMs?, background?, timeoutSec?, stdin?, onExit? }`

- Runs `bash -c <command>` (configurable) and waits up to `yieldMs` (default 10 s, max 10 min). A command that
  finishes in time returns its combined stdout+stderr and `[job N · exit 0 · 1.2s]`. One that doesn't keeps
  running as background job N, and the call returns the output so far.
- `background: true` returns immediately. When a background job ends, the model is notified: a message with
  the exit status and the tail of the log, which starts a run if the session is idle (see Notifications).
  `onExit: "none"` opts out, per call or in config. A job the model or user killed themselves, or one a `process poll` was waiting on when it ended, does not notify.
- The working directory persists per session, like a terminal: a trailing `cd` sticks for the next call.
- Output in a result is cut to the first 2 KB and last 30 KB; `process log` pages the full log.
- stdin is `/dev/null` unless `stdin: true`, which opens a FIFO that `process write` feeds. No PTY.
- Also accepts Claude Code's Bash input shape (`timeout` in ms, `run_in_background`), so
  `toolAliases: { "Bash": "mcp__valet__exec" }` in valet-claudecode works.

`process { action: list | poll | log | write | kill, jobId?, waitMs?, offset?, limit?, data?, eof?, signal? }`

- `poll` returns output since the last poll; `waitMs` blocks until the job ends (streaming progress).
- `kill` sends SIGTERM to the whole job, then SIGKILL after 5 s. `signal` sends just one signal.

## How jobs survive

Each job runs as a transient systemd user unit, `systemd-run --user --collect --unit=valet-exec-<id>-<rand>`,
so it lives in its own cgroup: restarting `valet.service` doesn't touch it, and its memory isn't valet's.
`KillMode=process` lets daemons the command forks (`nohup x &`) outlive the job, as in a normal shell; `kill`
still reaches the whole cgroup with `systemctl --user kill --kill-whom=all`.

A job is a directory, `~/.valet/data/valet-exec/jobs/<id>/`:

- `run.sh`: the wrapper. It records its pid, sources and deletes `env.sh`, `cd`s, runs the command, and writes `exit` last.
- `out.log`: stdout and stderr together.
- `exit`: the exit status. Its presence means the job is done.
- `cwd`: the command's final directory (EXIT trap).
- `stdin`, `stdin.pid`: the FIFO and the sleeping writer that holds it open (with `stdin: true`).

The `p_exec_jobs` table indexes jobs by session, run and call. On activate the plugin re-attaches to every job
still marked running and finishes the ones that ended while valet was down (a job with no `exit` file and no
live unit is `lost`). Finished jobs and their logs are deleted after 14 days.

Without user systemd (`runner: "detached"`, or `auto` when `systemctl --user` fails) jobs run in a new session
and process group instead. That survives valet exiting on its own, but not a service manager that kills
valet's whole cgroup.

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

## Replacing Claude Code's Bash

With valet-exec loaded, Claude Code sessions see `mcp__valet__exec` and `mcp__valet__process`. To take Bash
away, set this in valet-claudecode's config:

```json
{ "denyTools": ["Bash"], "toolAliases": { "Bash": "mcp__valet__exec" } }
```

`denyTools` removes Bash from the model's tool list. The alias catches the odd skill or habit that still emits a
Bash call.

## Checks

`bun run typecheck`, `bun run lint`, `bun test` (the runner tests skip systemd where it isn't available).
