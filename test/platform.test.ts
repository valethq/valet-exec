import { describe, expect, test } from "bun:test";
import { defaultShell, parseDarwinBoot, sameBoot, shellKind } from "../src/platform";
import { pickRunner } from "../src/runner";

describe("shellKind", () => {
  test("recognises PowerShell and cmd by name, with or without .exe or a Windows path", () => {
    expect(shellKind("pwsh")).toBe("powershell");
    expect(shellKind("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("powershell");
    expect(shellKind("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell");
    expect(shellKind("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
    expect(shellKind("CMD.EXE")).toBe("cmd");
  });

  test("everything else is treated as a POSIX shell", () => {
    for (const s of ["/bin/bash", "/bin/sh", "/usr/bin/zsh", "C:\\Program Files\\Git\\bin\\bash.exe"]) {
      expect(shellKind(s)).toBe("posix");
    }
  });
});

describe("defaultShell", () => {
  test("POSIX prefers /bin/bash and falls back to /bin/sh", () => {
    expect(defaultShell("linux", () => true)).toBe("/bin/bash");
    expect(defaultShell("darwin", () => false)).toBe("/bin/sh");
  });

  test("Windows prefers pwsh, then powershell, then ComSpec", () => {
    const found = (names: string[]) => (n: string) => (names.includes(n) ? `C:\\bin\\${n}.exe` : null);
    expect(defaultShell("win32", () => false, found(["pwsh", "powershell"]))).toBe("C:\\bin\\pwsh.exe");
    expect(defaultShell("win32", () => false, found(["powershell"]))).toBe("C:\\bin\\powershell.exe");
    expect(defaultShell("win32", () => false, found([]))).toBe(process.env.ComSpec ?? "cmd.exe");
  });
});

describe("boot ids", () => {
  test("a linux boot id must match exactly; unknown ids never block", () => {
    expect(sameBoot("abc", "abc")).toBe(true);
    expect(sameBoot("abc", "abd")).toBe(false);
    expect(sameBoot(null, "abc")).toBe(true);
    expect(sameBoot("abc", null)).toBe(true);
  });

  test("boot times tolerate the OS nudging its clock but not a reboot", () => {
    expect(sameBoot("t:1700000000", "t:1700000003")).toBe(true);
    expect(sameBoot("t:1700000000", "t:1699999900")).toBe(true);
    expect(sameBoot("t:1700000000", "t:1700003600")).toBe(false);
  });

  test("macOS kern.boottime output is read for its seconds", () => {
    expect(parseDarwinBoot("{ sec = 1763300000, usec = 123456 } Sun Nov 16 10:00:00 2026")).toBe(
      "t:1763300000",
    );
    expect(parseDarwinBoot("garbage")).toBeNull();
  });
});

describe("pickRunner", () => {
  test("Windows always gets the supervisor, and refuses unix-only runners", async () => {
    for (const want of [undefined, "auto", "detached", "supervisor"] as const) {
      expect((await pickRunner(want, "win32")).kind).toBe("supervisor");
    }
    await expect(pickRunner("systemd", "win32")).rejects.toThrow("not available on Windows");
    await expect(pickRunner("launchd", "win32")).rejects.toThrow("not available on Windows");
  });

  test("an explicit runner is honoured on the right OS and refused on the wrong one", async () => {
    expect((await pickRunner("launchd", "darwin")).kind).toBe("launchd");
    expect((await pickRunner("systemd", "linux")).kind).toBe("systemd");
    expect((await pickRunner("supervisor", "linux")).kind).toBe("supervisor");
    expect((await pickRunner("detached", "darwin")).kind).toBe("detached");
    await expect(pickRunner("launchd", "linux")).rejects.toThrow("needs macOS");
    await expect(pickRunner("systemd", "darwin")).rejects.toThrow("needs Linux");
  });
});
