import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidAlive } from "../src/proc";
import { supervisorRunner } from "../src/runner";
import { type Harness, harness } from "./helpers";

// Real PowerShell and cmd.exe through the supervisor runner. They only run on Windows (CI's windows runner).
setDefaultTimeout(60_000);
const win = process.platform === "win32";
const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.manager.close();
});

const make = (shell: string) => {
  const h = harness(supervisorRunner());
  h.shell(shell);
  open.push(h);
  return h;
};

const lf = (s: string) => s.replaceAll("\r\n", "\n");
const log = (h: Harness, job: Parameters<Harness["manager"]["files"]>[0]) =>
  lf(readFileSync(h.manager.files(job).log, "utf8"));
const cwdOf = (h: Harness, job: Parameters<Harness["manager"]["files"]>[0]) =>
  readFileSync(h.manager.files(job).cwd, "utf8").trim();
const base = () => ({ cwd: mkdtempSync(join(tmpdir(), "valet exec (win) ")), onExit: "notify" as const });

const shells: Record<string, string | null | undefined> = {
  pwsh: Bun.which("pwsh"),
  powershell: Bun.which("powershell"),
};

for (const [name, shell] of Object.entries(shells)) {
  describe.skipIf(!win || !shell)(`${name} on Windows`, () => {
    test("output, stderr, the final directory and the exit code of a native command", async () => {
      const h = make(shell as string);
      const b = base();
      const job = await h.manager.start({
        ...b,
        command:
          'Write-Output "out"; [Console]::Error.WriteLine("err"); New-Item -ItemType Directory -Name sub | Out-Null; Set-Location sub; cmd /c exit 3',
      });
      expect(await h.manager.wait(job.id, 30_000)).toBe("done");
      expect(h.manager.get(job.id)).toMatchObject({ status: "exited", exitCode: 3, runner: "supervisor" });
      expect(log(h, job)).toContain("out\n");
      expect(log(h, job)).toContain("err");
      expect(cwdOf(h, job)).toEndWith("sub");
    });

    test("a failed cmdlet is exit 1, a successful run is exit 0", async () => {
      const h = make(shell as string);
      const bad = await h.manager.start({ ...base(), command: "Get-Item C:\\definitely\\not\\here" });
      const good = await h.manager.start({ ...base(), command: "Get-Date | Out-Null" });
      await h.manager.wait(bad.id, 30_000);
      await h.manager.wait(good.id, 30_000);
      expect(h.manager.get(bad.id)?.exitCode).toBe(1);
      expect(h.manager.get(good.id)?.exitCode).toBe(0);
    });

    test("env reaches the command, and non-ASCII output survives as UTF-8", async () => {
      const h = make(shell as string);
      const job = await h.manager.start({
        ...base(),
        command: 'Write-Output "$env:GREETING $env:VALET_EXEC_JOB"; Write-Output "héllo ✓"',
        env: { GREETING: "it's hi" },
      });
      await h.manager.wait(job.id, 30_000);
      expect(log(h, job)).toBe(`it's hi ${job.id}\nhéllo ✓\n`);
    });

    test("kill ends the whole process tree", async () => {
      const h = make(shell as string);
      const job = await h.manager.start({ ...base(), command: "cmd /c ping -n 60 127.0.0.1 > $null" });
      await Bun.sleep(1500);
      await h.manager.kill(job.id, "user");
      expect(await h.manager.wait(job.id, 30_000)).toBe("done");
      expect(h.manager.get(job.id)).toMatchObject({ status: "killed", killReason: "user" });
      expect(pidAlive(job.pid as number)).toBe(false);
    });

    test("timeoutSec kills the job", async () => {
      const h = make(shell as string);
      const job = await h.manager.start({ ...base(), command: "Start-Sleep 60", timeoutSec: 2 });
      expect(await h.manager.wait(job.id, 30_000)).toBe("done");
      expect(h.manager.get(job.id)).toMatchObject({ status: "killed", killReason: "timeout" });
    });

    test("stdin: write lines, then eof", async () => {
      const h = make(shell as string);
      const job = await h.manager.start({
        ...base(),
        command: 'while ($null -ne ($l = [Console]::In.ReadLine())) { "got:$l" }; "end"',
        stdin: true,
      });
      await h.manager.write(job.id, "a\nb\n", false);
      await h.manager.write(job.id, "", true);
      expect(await h.manager.wait(job.id, 30_000)).toBe("done");
      expect(log(h, job)).toBe("got:a\ngot:b\nend\n");
    });

    test("a missing working directory fails cleanly", async () => {
      const h = make(shell as string);
      const job = await h.manager.start({
        cwd: join(tmpdir(), "valet-exec-missing"),
        onExit: "notify",
        command: "1",
      });
      await h.manager.wait(job.id, 30_000);
      expect(h.manager.get(job.id)).toMatchObject({ status: "exited", exitCode: 1 });
    });
  });
}

describe.skipIf(!win)("cmd.exe on Windows", () => {
  const cmd = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";

  test("a working directory with spaces and parentheses, env, output, final directory and exit code", async () => {
    const h = make(cmd);
    const b = base();
    mkdirSync(join(b.cwd, "sub"));
    const job = await h.manager.start({
      ...b,
      command: "echo %GREETING% %VALET_EXEC_JOB%& cd sub& cmd /c exit 4",
      env: { GREETING: "hi" },
    });
    expect(await h.manager.wait(job.id, 30_000)).toBe("done");
    expect(h.manager.get(job.id)).toMatchObject({ status: "exited", exitCode: 4 });
    expect(log(h, job)).toContain(`hi ${job.id}`);
    expect(cwdOf(h, job)).toEndWith("sub");
  });

  test("kill ends the whole process tree", async () => {
    const h = make(cmd);
    const job = await h.manager.start({ ...base(), command: "ping -n 60 127.0.0.1 > nul" });
    await Bun.sleep(1500);
    await h.manager.kill(job.id, "user");
    expect(await h.manager.wait(job.id, 30_000)).toBe("done");
    expect(h.manager.get(job.id)).toMatchObject({ status: "killed" });
    expect(pidAlive(job.pid as number)).toBe(false);
  });
});

describe.skipIf(!win)("the plugin's own defaults on Windows", () => {
  test("pickRunner and the default shell come out as the supervisor and a Windows shell", async () => {
    const { pickRunner } = await import("../src/runner");
    const { defaultShell, shellKind } = await import("../src/platform");
    expect((await pickRunner("auto")).kind).toBe("supervisor");
    expect(shellKind(defaultShell())).not.toBe("posix");
  });
});
