import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { detachedRunner, type Runner, systemdAvailable, systemdRunner } from "../src/runner";
import { type Harness, harness, waitFor } from "./helpers";

setDefaultTimeout(20_000);
const hasSystemd = await systemdAvailable();
const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.manager.close();
});

const make = (runner: Runner, opts?: Parameters<typeof harness>[1]) => {
  const h = harness(runner, opts);
  open.push(h);
  return h;
};

const base = { cwd: tmpdir(), onExit: "notice" as const };

for (const runner of [detachedRunner, systemdRunner]) {
  describe.skipIf(runner.kind === "systemd" && !hasSystemd)(`${runner.kind} runner`, () => {
    test("runs a command to completion with output, exit code and cwd", async () => {
      const h = make(runner);
      const job = await h.manager.start({ ...base, command: "echo out; echo err >&2; cd /; exit 3" });
      expect(await h.manager.wait(job.id, 10_000)).toBe("done");
      const done = h.manager.get(job.id);
      expect(done).toMatchObject({ status: "exited", exitCode: 3, runner: runner.kind });
      const files = h.manager.files(job);
      expect(readFileSync(files.log, "utf8")).toBe("out\nerr\n");
      expect(readFileSync(files.cwd, "utf8").trim()).toBe("/");
      expect(h.ended.map((j) => j.id)).toEqual([job.id]);
    });

    test("passes env, uses bash, and deletes the env file", async () => {
      const h = make(runner);
      const job = await h.manager.start({
        ...base,
        command: 'echo "$GREETING $VALET_EXEC_JOB"; [[ -n "$BASH_VERSION" ]] && echo bash',
        env: { GREETING: "it's hi" },
      });
      await h.manager.wait(job.id, 10_000);
      const files = h.manager.files(job);
      expect(readFileSync(files.log, "utf8")).toBe(`it's hi ${job.id}\nbash\n`);
      expect(() => readFileSync(files.env)).toThrow();
    });

    test("streams output while waiting and times out the wait without killing", async () => {
      const h = make(runner);
      const job = await h.manager.start({ ...base, command: "echo one; sleep 1.5; echo two" });
      const seen: string[] = [];
      expect(await h.manager.wait(job.id, 600, undefined, (d) => seen.push(d))).toBe("timeout");
      expect(seen.join("")).toBe("one\n");
      expect(await h.manager.wait(job.id, 10_000)).toBe("done");
      expect(h.manager.get(job.id)?.status).toBe("exited");
      expect(h.output.join("")).toBe("one\ntwo\n");
    });

    test("kill ends the whole job and records why", async () => {
      const h = make(runner);
      const job = await h.manager.start({ ...base, command: "sleep 30 & sleep 30; wait" });
      await Bun.sleep(300);
      await h.manager.kill(job.id, "user");
      expect(await h.manager.wait(job.id, 10_000)).toBe("done");
      expect(h.manager.get(job.id)).toMatchObject({ status: "killed", killReason: "user" });
    });

    test("timeoutSec kills the job", async () => {
      const h = make(runner);
      const job = await h.manager.start({ ...base, command: "sleep 30", timeoutSec: 1 });
      expect(await h.manager.wait(job.id, 10_000)).toBe("done");
      expect(h.manager.get(job.id)).toMatchObject({ status: "killed", killReason: "timeout" });
    });

    test("stdin pipe: write lines, then eof", async () => {
      const h = make(runner);
      const job = await h.manager.start({
        ...base,
        command: "while read l; do echo got:$l; done; echo end",
        stdin: true,
      });
      await waitFor(() => {
        try {
          return readFileSync(h.manager.files(job).stdinHolder, "utf8").trim();
        } catch {
          return false;
        }
      });
      await h.manager.write(job.id, "a\nb\n", false);
      await h.manager.write(job.id, "", true);
      expect(await h.manager.wait(job.id, 10_000)).toBe("done");
      expect(readFileSync(h.manager.files(job).log, "utf8")).toBe("got:a\ngot:b\nend\n");
    });

    test("a job outlives its manager and is re-attached by the next one", async () => {
      const first = make(runner);
      const job = await first.manager.start({ ...base, command: "sleep 1; echo survived" });
      first.manager.close(); // valet stops; the job keeps going
      const second = make(runner, { sql: first.sql, dir: first.dir });
      const found = second.manager.reattach();
      expect(found.map((j) => j.id)).toEqual([job.id]);
      expect(found[0]?.background).toBe(false); // as stored; the live copy is now background
      expect(await second.manager.wait(job.id, 10_000)).toBe("done");
      expect(second.ended[0]).toMatchObject({ id: job.id, status: "exited", exitCode: 0, background: true });
      expect(readFileSync(second.manager.files(job).log, "utf8")).toBe("survived\n");
    });
  });
}

test("a job that dies without an exit status is marked lost", async () => {
  const h = make(detachedRunner);
  const job = await h.manager.start({ ...base, command: "sleep 30" });
  await Bun.sleep(200);
  process.kill(-(job.pid as number), "SIGKILL"); // killed outside valet: the wrapper never writes `exit`
  expect(await h.manager.wait(job.id, 10_000)).toBe("done");
  expect(h.manager.get(job.id)).toMatchObject({ status: "lost", exitCode: null });
});

test("prune deletes finished jobs past retention", async () => {
  const h = make(detachedRunner);
  const job = await h.manager.start({ ...base, command: "true" });
  await h.manager.wait(job.id, 10_000);
  expect(h.manager.prune()).toBe(0);
  h.sql.db.query("UPDATE p_exec_jobs SET ended_at = 0").run();
  expect(h.manager.prune()).toBe(1);
  expect(h.manager.get(job.id)).toBeUndefined();
});
