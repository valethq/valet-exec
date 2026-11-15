import "./events";
import { join } from "node:path";
import { definePlugin } from "@valethq/sdk";
import { type ExecConfig, settings } from "./config";
import { Jobs } from "./db";
import { JobManager } from "./jobs";
import { announce, JOB_END, summary } from "./notify";
import { pickRunner } from "./runner";
import { execTool, processTool, type ToolDeps } from "./tools";

const PRUNE_EVERY_MS = 6 * 3_600_000;

export default definePlugin<ExecConfig>({
  async activate(ctx) {
    let current = settings(ctx.config);
    ctx.store.partTypes.define(JOB_END);
    let stopping = false;
    const runner = await pickRunner(ctx.config?.runner);
    const manager = new JobManager({
      jobs: new Jobs(ctx.storage.sql),
      dir: join(ctx.paths.data, "jobs"),
      settings: () => current,
      runner,
      log: ctx.log,
      onOutput(job, delta, offset) {
        ctx.events.signal("exec.output", { jobId: job.id, sessionId: job.sessionId, delta, offset });
        ctx.ws.publish(`exec:${job.id}`, "output", { delta, offset });
      },
      async onEnd(job, awaited) {
        ctx.ws.publish(`exec:${job.id}`, "end", summary(job));
        await ctx.events.emit("exec.job.end", summary(job));
        if (!awaited) await announce(ctx, job);
      },
    });

    const reattached = manager.reattach();
    if (reattached.length > 0) {
      ctx.log.info("re-attached running jobs", { jobs: reattached.map((j) => j.id) });
    }
    const pruned = manager.prune();
    if (pruned > 0) ctx.log.info("pruned old jobs", { count: pruned });
    const pruneTimer = setInterval(() => manager.prune(), PRUNE_EVERY_MS);
    ctx.log.info("exec ready", { runner: runner.kind, shell: current.shell });

    ctx.events.after("core.shutdown", () => {
      stopping = true;
    });
    ctx.onDispose(() => {
      stopping = true;
      clearInterval(pruneTimer);
      manager.close();
    });
    ctx.onConfigChange((next, prev) => {
      if ((next?.runner ?? "auto") !== (prev?.runner ?? "auto")) {
        throw new Error("changing valet-exec's runner needs a restart");
      }
      current = settings(next);
    });

    // Job output topics carry raw shell output: owner only, like the tools.
    ctx.events.before("control.request", (e) => {
      const { kind, path } = e.payload;
      if (kind === "ws.sub" && path.startsWith("exec:") && e.caller.actor?.role !== "owner") {
        e.deny("exec output is owner-only");
      }
    });

    const deps: ToolDeps = {
      manager,
      kv: ctx.storage.kv,
      settings: () => current,
      stopping: () => stopping || ctx.signal.aborted,
    };
    const tools = [execTool(deps), processTool(deps)];
    ctx.scopes.provide("tools", { list: ({ role }) => (role === "owner" ? tools : []) });
  },
});
