import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Boots the real kernel with valet-agent, valet-contextmanager and a scripted model that calls exec.
const CORE = process.env.VALET_CORE_DIR ?? join(import.meta.dir, "..", "..", "valet-core");
const CLI = join(CORE, "packages/core/src/cli.ts");
const VALET = join(import.meta.dir, "..", "..");
const ROOT = join(import.meta.dir, "..");
const AUTH = { authorization: "Bearer tok", "content-type": "application/json" };

// biome-ignore lint/suspicious/noExplicitAny: loose REST shapes in a test
type Json = any;

setDefaultTimeout(40_000);

let home: string;
let base: string;
let proc: Bun.Subprocess | undefined;
let sessionId: string;
let workspace: string;

function shim(id: string, dir: string): void {
  const out = join(home, "plugins", id);
  mkdirSync(out, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ ...manifest, main: "./index.ts" }));
  writeFileSync(
    join(out, "index.ts"),
    `export { default } from ${JSON.stringify(join(dir, manifest.main))};\n`,
  );
}

// Windows shells end lines with CRLF; the assertions below are written for LF.
const lf = (v: Json): Json => JSON.parse(JSON.stringify(v).replaceAll("\\r\\n", "\\n"));
const PWD = process.platform === "win32" ? "(Get-Location).Path" : "pwd"; // PowerShell's pwd prints a table

// bash's pwd keeps the logical path (macOS tmp is a symlink); PowerShell expands Windows 8.3 short names.
const expectedSub = () =>
  process.platform === "win32" ? realpathSync.native(join(workspace, "sub")) : join(workspace, "sub");

async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<Json> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: AUTH,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return lf(await res.json());
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await Bun.sleep(50);
  }
}

async function boot(): Promise<void> {
  proc = Bun.spawn(["bun", CLI, "start", "--home", home], {
    stdout: Bun.file(join(home, `out-${Date.now()}.log`)),
    stderr: Bun.file(join(home, `err-${Date.now()}.log`)),
  });
  await waitFor(async () => (await fetch(`${base}/`)).status === 200);
}

async function stop(): Promise<void> {
  proc?.kill("SIGTERM");
  await proc?.exited;
  proc = undefined;
}

/** Sends a scripted tool call and returns the assistant reply once its run is done. */
async function call(tool: string, input: unknown): Promise<Json> {
  const before: Json[] = await api(`/api/core/sessions/${sessionId}/messages`);
  await api(`/api/core/sessions/${sessionId}/messages`, {
    method: "POST",
    body: { role: "user", parts: [{ type: "text", text: JSON.stringify({ tool, input }) }] },
  });
  return waitFor(async () => {
    const list: Json[] = await api(`/api/core/sessions/${sessionId}/messages`);
    const a = list.slice(before.length).find((m) => m.message.role === "assistant");
    return a && a.message.status !== "streaming" && a.parts.length === 2 && a;
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "valet-exec-kernel-"));
  workspace = mkdtempSync(join(tmpdir(), "valet-exec-ws-"));
  mkdirSync(join(workspace, "sub"));
  shim("valet-exec", ROOT);
  shim("valet-agent", join(VALET, "valet-agent"));
  shim("valet-contextmanager", join(VALET, "valet-contextmanager"));
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  await probe.stop(true);
  base = `http://127.0.0.1:${port}`;
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      server: { port },
      pluginPaths: [join(import.meta.dir, "fixtures", "plugins"), join(home, "plugins")],
      plugins: { "valet-fixture-auth": { config: { token: "tok" } } },
    }),
  );
  await boot();
  const project = await api("/api/core/projects", {
    method: "POST",
    body: { name: "p", workspaceDir: workspace },
  });
  const session = await api("/api/core/sessions", {
    method: "POST",
    body: { projectId: project.id, settings: { model: { provider: "fixture-model", model: "m1" } } },
  });
  sessionId = session.id;
});

afterAll(stop);

test("exec runs through valet-agent's tool loop, and cd persists in the session", async () => {
  const plugins: Json = await api("/api/core/plugins");
  const states = Object.fromEntries(
    (Array.isArray(plugins) ? plugins : plugins.plugins).map((p: Json) => [p.id, p.state]),
  );
  expect(states["valet-exec"]).toBe("active");

  const first = await call("exec", { command: "echo hello; cd sub" });
  expect(first.parts[0].data).toMatchObject({ name: "exec", status: "done" });
  expect(first.parts[0].data.output).toMatch(/^hello\n\[job 1 · exit 0 · /);

  const second = await call("exec", { command: `${PWD}; exit 4` });
  expect(second.parts[0].data.status).toBe("error");
  expect(second.parts[0].data.output).toStartWith(`${expectedSub()}\n[job 2 · exit 4 · `);
});

test("a background job survives a valet restart, then notifies the model and wakes the session", async () => {
  const reply = await call("exec", {
    command: "sleep 4; echo finished",
    background: true,
    description: "slow thing",
  });
  expect(reply.parts[0].data.output).toStartWith("Started job 3 in the background");
  const jobDir = join(home, "data", "valet-exec", "jobs", "3");
  await stop();
  expect(existsSync(join(jobDir, "exit"))).toBe(false); // still running with valet down
  await boot();
  const note = await waitFor(async () => {
    const list: Json[] = await api(`/api/core/sessions/${sessionId}/messages`);
    return list.find((m) => m.message.role === "system" && m.parts[0]?.type === "custom");
  });
  expect(note.parts).toHaveLength(1);
  expect(note.parts[0].data).toMatchObject({
    kind: "valet-exec/job-end@1",
    title: expect.stringMatching(/^Process finished: slow thing \(exit 0, \d+\.\ds\)$/),
    data: { jobId: 3, status: "exited", exitCode: 0, label: "slow thing" },
  });
  const types: Json[] = await api("/api/core/part-types");
  expect(types.find((t) => t.id === "valet-exec/job-end@1")).toMatchObject({
    wakes: true,
    plugin: { id: "valet-exec", repository: "https://github.com/valethq/valet-exec" },
  });
  expect(note.parts[0].data.text).toMatch(
    /^\[valet-exec\] exec job 3 exit 0 after \d+\.\ds: slow thing\n\nLast output:\nfinished/,
  );
  // the notification started a run: the scripted model saw it and answered
  const woken = await waitFor(async () => {
    const list: Json[] = await api(`/api/core/sessions/${sessionId}/messages`);
    const after = list.filter((m) => m.message.seq > note.message.seq && m.message.role === "assistant");
    return after[0]?.message.status === "complete" && after[0];
  });
  expect(woken.parts[0].data.text).toMatch(/^notified: \[valet-exec\] exec job 3 exit 0/);
  expect(readFileSync(join(jobDir, "out.log"), "utf8").replaceAll("\r\n", "\n")).toBe("finished\n");

  const poll = await call("process", { action: "poll", jobId: 3 });
  expect(poll.parts[0].data.output).toStartWith("finished\n[job 3 · exit 0 · ");
});

test("a foreground command that outlasts yieldMs becomes a job that process can wait on", async () => {
  // PowerShell takes most of a second to start, so Windows needs a longer yield to see the first line
  const slow = process.platform === "win32" ? { yieldMs: 3000, sleep: 6 } : { yieldMs: 300, sleep: 2 };
  const reply = await call("exec", {
    command: `echo early; sleep ${slow.sleep}; echo late`,
    yieldMs: slow.yieldMs,
  });
  expect(reply.parts[0].data.output).toContain("it is now background job 4");
  expect(reply.parts[0].data.output).toContain("Output so far:\nearly\n");
  const poll = await call("process", { action: "poll", jobId: 4, waitMs: 10_000 });
  expect(poll.parts[0].data.output).toStartWith("late\n[job 4 · exit 0 · ");
  const list = await call("process", { action: "list" });
  expect(list.parts[0].data.output).toContain("4\texit 0\t");
});

test("a job the model kills itself, or opts out with onExit none, does not notify", async () => {
  await call("exec", { command: "sleep 30", background: true });
  await call("exec", { command: "sleep 1", background: true, onExit: "none" });
  const killed = await call("process", { action: "kill", jobId: 5 });
  expect(killed.parts[0].data.output).toMatch(/killed \(user\)/);
  await Bun.sleep(2500);
  const list: Json[] = await api(`/api/core/sessions/${sessionId}/messages`);
  const jobs = list.filter((m) => m.parts[0]?.type === "custom").map((m) => m.parts[0].data.data.jobId);
  expect(jobs).toEqual([3]); // job 4 ended while process poll was waiting on it, so poll told the model
});
