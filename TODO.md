# TODO

- **macOS: launchd runner.** Untested on macOS so far (no Mac to test on). Today macOS falls back to the
  `detached` runner (new session + process group), which survives valet exiting but has no supervisor. A
  `launchd` runner would submit each job as its own launchd job, either with `launchctl submit -l
  dev.valet.exec.<id> -- /bin/sh <dir>/run.sh` or a generated LaunchAgent plist loaded with `launchctl
  bootstrap gui/<uid>`, check liveness with `launchctl print gui/<uid>/<label>`, and stop it with `launchctl
  kill` / `bootout`. The wrapper script and job directory work as-is; `bootId()` needs a macOS source
  (`sysctl kern.boottime`). Plug it in at `pickRunner` in `src/runner.ts`.
- A PTY mode for interactive programs (spec: not in v1).
- A `settings@1` panel listing running jobs with kill buttons, once the SDK publishes the settings types.
- valet-agent turning `exec.job.end` into notices itself (spec 11.4); until then this plugin posts them.
- Live output into the tool-call part: valet-agent's ToolSurface drops `progress()` today (its own spec-gap).
