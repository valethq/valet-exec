# TODO

- **Windows: Task Scheduler runner (maybe).** The supervisor survives valet exiting, but not a service manager that
  runs valet in a job object with kill-on-close. `schtasks` (or a hidden scheduled task) would put jobs outside
  that tree, at the cost of a console window or a service account. Only worth it if valet runs as a Windows service.
- **Windows: graceful stop.** `kill` ends the tree at once; a console-less tree has no graceful signal. A
  `GenerateConsoleCtrlEvent` helper in the supervisor could deliver Ctrl+C for programs that handle it.
- **Windows startup time.** PowerShell adds about half a second to every job; a persistent shell per session would
  remove it but loses the per-job isolation.
- A PTY mode for interactive programs (spec: not in v1).
- A `settings@1` panel listing running jobs with kill buttons, once the SDK publishes the settings types.
- valet-agent turning `exec.job.end` into notices itself (spec 11.4); until then this plugin posts them.
- Live output into the tool-call part: valet-agent's ToolSurface drops `progress()` today (its own spec-gap).
