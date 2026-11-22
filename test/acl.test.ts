import { afterEach, describe, expect, test } from "bun:test";
import { can, type Role, type ToolDefinition, type ToolResult } from "@valethq/sdk";
import manifest from "../manifest.json";
import execPlugin from "../src/index";
import { announce } from "../src/notify";
import { detachedRunner } from "../src/runner";
import { type Fake, caller, fakeCtx } from "./fakeCtx";
import { harness, waitFor } from "./helpers";

const roles: Record<string, Role> = { boss: "owner", boss2: "owner", pal: "trusted", nobody: "guest" };
const scope = (c: ReturnType<typeof caller>, role: Role = "owner") => ({
  sessionId: "ses_1",
  projectId: "prj_1",
  role,
  caller: c,
});
const call = (c: ReturnType<typeof caller>, role: Role = "owner") => ({
  sessionId: "ses_1",
  runId: "run_1",
  callId: "call_1",
  role,
  caller: c,
  cwd: "/",
  signal: new AbortController().signal,
  progress() {},
});

const open: Fake[] = [];
async function activated(opts: Parameters<typeof fakeCtx>[0] = {}) {
  const fake = fakeCtx({ roles, policy: true, ...opts });
  open.push(fake);
  await execPlugin.activate(fake.ctx);
  const provider = fake.provided.tools;
  if (!provider) throw new Error("tools@1 not provided");
  const list = async (c: ReturnType<typeof caller>, role: Role = "owner") =>
    (await provider.list(scope(c, role))) as ToolDefinition[];
  return { fake, list };
}

afterEach(async () => {
  for (const f of open.splice(0)) for (const d of f.disposers.reverse()) await d();
});

const text = (r: ToolResult) => (r.content[0] as { text: string }).text;

describe("manifest", () => {
  test("declares run and output.read, owner by default", () => {
    expect(manifest.acl.permissions).toEqual({
      run: { summary: "Run shell commands and manage jobs", default: "owner" },
      "output.read": { summary: "Read job output topics", default: "owner" },
    });
  });
});

describe("shell access", () => {
  test("an owner actor in an owner run lists and invokes both tools", async () => {
    const { list } = await activated();
    const tools = await list(caller("boss"));
    expect(tools.map((t) => t.name)).toEqual(["exec", "process"]);
    expect(tools.map((t) => t.permission)).toEqual(["exec:run", "exec:run"]);
    const process = tools.find((t) => t.name === "process");
    const result = await process?.invoke({ action: "list" }, call(caller("boss")));
    expect(text(result as ToolResult)).toBe("No jobs yet.");
  });

  test("a trusted actor is denied even when the policy grants exec:run", async () => {
    const { fake, list } = await activated();
    const c = caller("pal");
    expect(can(fake.ctx, c, "exec:run")).toEqual({ allow: true });
    expect(await list(c)).toEqual([]);
    const tools = await list(caller("boss"));
    for (const tool of tools) {
      const result = (await tool.invoke({ action: "list", command: "true" }, call(c))) as ToolResult;
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("owner-only");
    }
  });

  test("a guest and an actor-less caller are denied", async () => {
    const { list } = await activated();
    expect(await list(caller("nobody"))).toEqual([]);
    expect(await list(caller())).toEqual([]);
    expect(await list(caller("unknown"))).toEqual([]);
  });

  test("a non-owner run role is denied for an owner actor", async () => {
    const { list } = await activated();
    expect(await list(caller("boss"), "trusted")).toEqual([]);
    const tools = await list(caller("boss"));
    const result = (await tools[1]?.invoke(
      { action: "list" },
      call(caller("boss"), "trusted"),
    )) as ToolResult;
    expect(result.isError).toBe(true);
  });

  test("the actor's current stored role counts, not the role stamped on the caller", async () => {
    const { list } = await activated({ roles: { ...roles, boss: "trusted" } });
    expect(await list(caller("boss"))).toEqual([]);
  });

  test("an audience with a trusted reader is denied even though the policy grants them", async () => {
    const { fake, list } = await activated();
    const c = caller("boss", { principals: ["boss2", "pal"] });
    expect(can(fake.ctx, c, "exec:run")).toEqual({ allow: true });
    expect(await list(c)).toEqual([]);
    const tools = await list(caller("boss"));
    const result = (await tools[0]?.invoke({ command: "true" }, call(c))) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("pal");
  });

  test("an audience tier below owner is denied; owner readers and an owner tier pass", async () => {
    const { list } = await activated();
    expect(await list(caller("boss", { tier: "guest" }))).toEqual([]);
    expect(await list(caller("boss", { tier: "trusted" }))).toEqual([]);
    expect(await list(caller("boss", { principals: ["nobody"] }))).toEqual([]);
    expect(await list(caller("boss", { tier: "owner", principals: ["boss2"] }))).toHaveLength(2);
  });

  test("without a policy provider the declared owner default still applies", async () => {
    const { list } = await activated({ policy: false });
    expect(await list(caller("boss"))).toHaveLength(2);
    expect(await list(caller("pal"))).toEqual([]);
  });
});

describe("output topics", () => {
  test("exec: topics require exec:output.read on the job", async () => {
    const { fake } = await activated();
    expect(fake.topics).toHaveLength(1);
    const [topic] = fake.topics;
    expect(topic?.prefix).toBe("exec:");
    expect(topic?.opts.permission).toBe("exec:output.read");
    expect(topic?.opts.resource?.("exec:12")).toEqual({ id: "job:12" });
  });
});

describe("completion wake", () => {
  const base = { cwd: "/tmp", onExit: "notify" as const, command: "true", background: true };

  test("a job stores its runId and the wake posts as that run", async () => {
    const h = harness(detachedRunner);
    try {
      const job = await h.manager.start({ ...base, sessionId: "ses_1", runId: "run_7", principalId: "boss" });
      expect(h.manager.get(job.id)).toMatchObject({ runId: "run_7", principalId: "boss" });
      const ended = await waitFor(() => h.ended[0]);
      const fake = fakeCtx({ roles });
      await announce(fake.ctx, ended);
      expect(fake.asCalls).toEqual([{ principalId: "boss", runId: "run_7" }]);
      expect(fake.messages).toHaveLength(1);
    } finally {
      h.manager.close();
    }
  });

  test("a job with no runId wakes as the principal alone", async () => {
    const h = harness(detachedRunner);
    try {
      const job = await h.manager.start({ ...base, sessionId: "ses_1", principalId: "boss" });
      expect(h.manager.get(job.id)?.runId).toBeNull();
      const ended = await waitFor(() => h.ended[0]);
      const fake = fakeCtx({ roles });
      await announce(fake.ctx, ended);
      expect(fake.asCalls).toEqual([{ principalId: "boss" }]);
    } finally {
      h.manager.close();
    }
  });
});
