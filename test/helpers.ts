import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, PluginStorage } from "@valethq/sdk";
import { settings } from "../src/config";
import { type Job, Jobs } from "../src/db";
import { JobManager } from "../src/jobs";
import type { Runner } from "../src/runner";

export function storage(db = new Database(":memory:")): PluginStorage["sql"] {
  return {
    migrate(migrations) {
      db.exec("CREATE TABLE IF NOT EXISTS m (id TEXT PRIMARY KEY)");
      for (const m of migrations) {
        if (db.query("SELECT 1 FROM m WHERE id = ?").get(m.id)) continue;
        db.exec(m.up);
        db.query("INSERT INTO m (id) VALUES (?)").run(m.id);
      }
    },
    db,
  };
}

export function kv(): PluginStorage["kv"] {
  const map = new Map<string, unknown>();
  return {
    get: <T>(k: string) => map.get(k) as T | undefined,
    set: (k, v) => void map.set(k, v),
    delete: (k) => void map.delete(k),
    list: (p = "") => [...map.keys()].filter((k) => k.startsWith(p)),
  };
}

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export interface Harness {
  manager: JobManager;
  ended: Job[];
  output: string[];
  sql: PluginStorage["sql"];
  dir: string;
}

export function harness(runner: Runner, opts: { sql?: PluginStorage["sql"]; dir?: string } = {}): Harness {
  const sql = opts.sql ?? storage();
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "valet-exec-jobs-"));
  const ended: Job[] = [];
  const output: string[] = [];
  const manager = new JobManager({
    jobs: new Jobs(sql),
    dir,
    settings: () => settings({ yieldMs: 2000 }),
    runner,
    log: quiet,
    onOutput: (_job, delta) => void output.push(delta),
    onEnd: (job) => void ended.push(job),
  });
  return { manager, ended, output, sql, dir };
}

export async function waitFor<T>(fn: () => T | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await Bun.sleep(25);
  }
}
