import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "../src/db";
import { launchdRunner, plist } from "../src/launchd";
import type { RunResult } from "../src/proc";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "valet-launchd-"));
  dirs.push(d);
  return d;
};

function fake(replies: Record<string, RunResult | ((cmd: string[]) => RunResult)> = {}) {
  const calls: string[][] = [];
  const kills: [number, string][] = [];
  const runner = launchdRunner({
    uid: 501,
    run: async (cmd) => {
      calls.push(cmd);
      const r = replies[cmd.slice(0, 3).join(" ")] ??
        replies[cmd.slice(0, 2).join(" ")] ?? { code: 0, out: "" };
      return typeof r === "function" ? r(cmd) : r;
    },
    killGroup: (pid, sig) => void kills.push([pid, sig]),
  });
  return { runner, calls, kills };
}

const job = (over: Partial<Job> = {}): Job =>
  ({ unit: "gui/501/dev.valet.exec.7.abcd", dir: "/x", ...over }) as Job;

describe("plist", () => {
  test("runs the wrapper once, abandons its process group and escapes XML", () => {
    const p = plist("dev.valet.exec.1.ab", "/data/a&b/run.sh", "/data/<jobs>/1");
    expect(p).toContain("<key>Label</key><string>dev.valet.exec.1.ab</string>");
    expect(p).toContain("<string>/bin/sh</string><string>/data/a&amp;b/run.sh</string>");
    expect(p).toContain("<key>WorkingDirectory</key><string>/data/&lt;jobs&gt;/1</string>");
    expect(p).toContain("<key>RunAtLoad</key><true/>");
    expect(p).toContain("<key>KeepAlive</key><false/>");
    expect(p).toContain("<key>AbandonProcessGroup</key><true/>");
  });
});

describe("launchd runner", () => {
  test("starts a job in the GUI domain and records the service target as its unit", async () => {
    const dir = tmp();
    const { runner, calls } = fake();
    const started = await runner.start({ id: 7, dir, wrapper: join(dir, "run.sh"), label: "x", env: {} });
    expect(started.unit).toMatch(/^gui\/501\/dev\.valet\.exec\.7\.[a-z0-9]+$/);
    expect(calls).toEqual([["launchctl", "bootstrap", "gui/501", join(dir, "job.plist")]]);
    expect(readFileSync(join(dir, "job.plist"), "utf8")).toContain(started.unit?.split("/")[2] as string);
  });

  test("falls back to the user domain when there is no GUI session, and reports both failures", async () => {
    const dir = tmp();
    const gui = fake({
      "launchctl bootstrap gui/501": { code: 125, out: "Domain does not support specified action" },
    });
    const ok = await gui.runner.start({ id: 1, dir, wrapper: "w", label: "x", env: {} });
    expect(ok.unit).toStartWith("user/501/");
    const none = fake({ "launchctl bootstrap": { code: 5, out: "Input/output error" } });
    await expect(none.runner.start({ id: 2, dir, wrapper: "w", label: "x", env: {} })).rejects.toThrow(
      /gui\/501: Input\/output error; user\/501: Input\/output error/,
    );
  });

  test("a service is alive while launchd says it is running, not once it has exited", async () => {
    const running = fake({ "launchctl print": { code: 0, out: "state = running\n\tpid = 4242" } });
    expect(await running.runner.alive(job())).toBe(true);
    const done = fake({ "launchctl print": { code: 0, out: "state = not running\n\tlast exit code = 0" } });
    expect(await done.runner.alive(job())).toBe(false);
    const gone = fake({ "launchctl print": { code: 113, out: "Could not find service" } });
    expect(await gone.runner.alive(job())).toBe(false);
    expect(await running.runner.alive(job({ unit: null }))).toBe(false);
  });

  test("signal reaches the wrapper's process group, then asks launchd to signal the service", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "pid"), "555\n");
    const { runner, calls, kills } = fake();
    await runner.signal(job({ dir }), "SIGTERM");
    expect(kills).toEqual([[555, "SIGTERM"]]);
    expect(calls).toEqual([["launchctl", "kill", "TERM", "gui/501/dev.valet.exec.7.abcd"]]);
  });

  test("signal still asks launchd when the pid file is missing", async () => {
    const { runner, calls, kills } = fake();
    await runner.signal(job({ dir: tmp() }), "SIGKILL");
    expect(kills).toEqual([]);
    expect(calls[0]).toEqual(["launchctl", "kill", "KILL", "gui/501/dev.valet.exec.7.abcd"]);
  });

  test("release boots the service out and deletes the plist", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "job.plist"), "x");
    const { runner, calls } = fake();
    await runner.release?.(job({ dir }));
    expect(calls).toEqual([["launchctl", "bootout", "gui/501/dev.valet.exec.7.abcd"]]);
    expect(existsSync(join(dir, "job.plist"))).toBe(false);
  });
});
