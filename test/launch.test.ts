import { describe, expect, test } from "bun:test";
import { supervisorLaunch } from "../src/launch";
import { jobFiles } from "../src/script";

const files = jobFiles("/data/jobs/9");
const base = { files, cwd: "/work", command: "echo hi", stdin: false };

describe("supervisorLaunch", () => {
  test("a POSIX shell gets the command as a -c script that records the final directory", () => {
    const { config, script } = supervisorLaunch({
      ...base,
      shell: "/bin/bash",
      command: "cd /tmp; echo 'x'",
    });
    expect(script).toBeUndefined();
    expect(config.cwd).toBe("/work");
    expect(config.argv.slice(0, 2)).toEqual(["/bin/bash", "-c"]);
    expect(config.argv[2]).toContain("EXIT");
    expect(config.argv[2]).toEndWith("cd /tmp; echo 'x'");
    expect(config.argv[2]).toContain("/data/jobs/9/cwd");
  });

  test("PowerShell runs a generated .ps1 with a BOM, UTF-8 output, and a cwd and exit code epilogue", () => {
    const { config, script } = supervisorLaunch({
      ...base,
      shell: "C:\\bin\\pwsh.exe",
      command: "Get-ChildItem",
    });
    expect(config.cwd).toBe("/work");
    expect(config.argv).toEqual([
      "C:\\bin\\pwsh.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "/data/jobs/9/command.ps1",
    ]);
    expect(script?.path).toBe("/data/jobs/9/command.ps1");
    const text = script?.content ?? "";
    expect(text.startsWith("\ufeff")).toBe(true);
    expect(text).toContain("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)");
    expect(text.indexOf("Get-ChildItem")).toBeGreaterThan(text.indexOf("OutputEncoding"));
    expect(text).toContain("WriteAllText('/data/jobs/9/cwd', (Get-Location).Path)");
    expect(text).toContain("$LASTEXITCODE");
    expect(text).toContain("\r\n");
  });

  test("a single quote in a PowerShell path is doubled", () => {
    const odd = supervisorLaunch({ ...base, files: jobFiles("/d/it's/1"), shell: "pwsh" });
    expect(odd.script?.content).toContain("'/d/it''s/1/cwd'");
  });

  test("cmd.exe runs a generated batch file from the job directory and enters the working directory itself", () => {
    const { config, script } = supervisorLaunch({
      ...base,
      cwd: "C:\\Users\\me\\proj (x)",
      shell: "C:\\Windows\\System32\\cmd.exe",
      command: "dir & echo %CD%",
    });
    expect(config.cwd).toBe("/data/jobs/9");
    expect(config.argv).toEqual(["C:\\Windows\\System32\\cmd.exe", "/d", "/c", "command.cmd"]);
    expect(script?.path).toBe("/data/jobs/9/command.cmd");
    const lines = (script?.content ?? "").split("\r\n");
    expect(lines).toContain('cd /d "C:\\Users\\me\\proj (x)"');
    expect(lines).toContain("dir & echo %CD%");
    expect(lines).toContain("set __valet_rc=%ERRORLEVEL%");
    expect(lines).toContain('cd > "/data/jobs/9/cwd"');
    expect(lines.at(-2)).toBe("exit /b %__valet_rc%");
  });

  test("stdin and the supervisor's file set are carried in the config", () => {
    const { config } = supervisorLaunch({ ...base, shell: "/bin/sh", stdin: true });
    expect(config.stdin).toBe(true);
    expect(config.files).toMatchObject({ log: "/data/jobs/9/out.log", exit: "/data/jobs/9/exit" });
  });
});
