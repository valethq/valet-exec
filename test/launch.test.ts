import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { supervisorLaunch } from "../src/launch";
import { jobFiles } from "../src/script";

const dir = join("/data", "jobs", "9");
const files = jobFiles(dir);
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
    expect(config.argv[2]).toContain(files.cwd);
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
      `${files.script}.ps1`,
    ]);
    expect(script?.path).toBe(`${files.script}.ps1`);
    const text = script?.content ?? "";
    expect(text.startsWith("\ufeff")).toBe(true);
    expect(text).toContain("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)");
    expect(text.indexOf("Get-ChildItem")).toBeGreaterThan(text.indexOf("OutputEncoding"));
    expect(text).toContain(`WriteAllText('${files.cwd}', (Get-Location).Path)`);
    expect(text).toContain("$LASTEXITCODE");
    expect(text).toContain("\r\n");
  });

  test("a single quote in a PowerShell path is doubled", () => {
    const odd = jobFiles(join("/d", "it's", "1"));
    const launch = supervisorLaunch({ ...base, files: odd, shell: "pwsh" });
    expect(launch.script?.content).toContain(`'${odd.cwd.replaceAll("'", "''")}'`);
  });

  test("cmd.exe runs a generated batch file from the job directory and enters the working directory itself", () => {
    const { config, script } = supervisorLaunch({
      ...base,
      cwd: "C:\\Users\\me\\proj (x)",
      shell: "C:\\Windows\\System32\\cmd.exe",
      command: "dir & echo %CD%",
    });
    expect(config.cwd).toBe(dir);
    expect(config.argv).toEqual(["C:\\Windows\\System32\\cmd.exe", "/d", "/c", "command.cmd"]);
    expect(script?.path).toBe(`${files.script}.cmd`);
    const lines = (script?.content ?? "").split("\r\n");
    expect(lines).toContain('cd /d "C:\\Users\\me\\proj (x)"');
    expect(lines).toContain("dir & echo %CD%");
    expect(lines).toContain("set __valet_rc=%ERRORLEVEL%");
    expect(lines).toContain(`cd > "${files.cwd}"`);
    expect(lines.at(-2)).toBe("exit /b %__valet_rc%");
  });

  test("stdin and the supervisor's file set are carried in the config", () => {
    const { config } = supervisorLaunch({ ...base, shell: "/bin/sh", stdin: true });
    expect(config.stdin).toBe(true);
    expect(config.files).toMatchObject({ log: files.log, exit: files.exit });
  });
});
