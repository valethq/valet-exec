import type { Database } from "bun:sqlite";
import type { PluginStorage } from "@valethq/sdk";
import type { OnExit, RunnerKind } from "./config";

export type JobStatus = "running" | "exited" | "killed" | "lost";
export type KillReason = "user" | "timeout" | "cancelled";

export interface Job {
  id: number;
  sessionId: string | null;
  runId: string | null;
  callId: string | null;
  principalId: string | null;
  command: string;
  label: string | null;
  cwd: string;
  runner: RunnerKind;
  unit: string | null;
  pid: number | null;
  bootId: string | null;
  dir: string;
  status: JobStatus;
  exitCode: number | null;
  timeoutSec: number | null;
  stdin: boolean;
  /** Set once no tool call is waiting on the job; only background jobs announce their end. */
  background: boolean;
  onExit: OnExit;
  pollOffset: number;
  killReason: KillReason | null;
  startedAt: number;
  endedAt: number | null;
}

const MIGRATIONS = [
  {
    id: "001_jobs",
    up: `CREATE TABLE p_exec_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT, run_id TEXT, call_id TEXT, principal_id TEXT,
      command TEXT NOT NULL, label TEXT, cwd TEXT NOT NULL,
      runner TEXT NOT NULL, unit TEXT, pid INTEGER, boot_id TEXT, dir TEXT NOT NULL,
      status TEXT NOT NULL, exit_code INTEGER, timeout_sec INTEGER,
      stdin INTEGER NOT NULL DEFAULT 0, background INTEGER NOT NULL DEFAULT 0,
      on_exit TEXT NOT NULL, poll_offset INTEGER NOT NULL DEFAULT 0, kill_reason TEXT,
      started_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE INDEX p_exec_jobs_status ON p_exec_jobs(status);
    CREATE INDEX p_exec_jobs_session ON p_exec_jobs(session_id, id);`,
  },
];

type Row = Record<string, string | number | null>;

const COLUMNS: Record<string, keyof Job> = {
  session_id: "sessionId",
  run_id: "runId",
  call_id: "callId",
  principal_id: "principalId",
  boot_id: "bootId",
  exit_code: "exitCode",
  timeout_sec: "timeoutSec",
  on_exit: "onExit",
  poll_offset: "pollOffset",
  kill_reason: "killReason",
  started_at: "startedAt",
  ended_at: "endedAt",
};
const FIELDS = Object.fromEntries(Object.entries(COLUMNS).map(([col, field]) => [field, col]));
const BOOLEANS = new Set(["stdin", "background"]);

function fromRow(row: Row): Job {
  const job: Record<string, unknown> = {};
  for (const [col, value] of Object.entries(row)) {
    const field = COLUMNS[col] ?? col;
    job[field] = BOOLEANS.has(field) ? value === 1 : value;
  }
  return job as unknown as Job;
}

const column = (field: string) => FIELDS[field] ?? field;
const toSql = (v: unknown) => (typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null)) as string | number | null;

export class Jobs {
  readonly #db: Database;

  constructor(storage: PluginStorage["sql"]) {
    storage.migrate(MIGRATIONS);
    this.#db = storage.db;
  }

  insert(job: Omit<Job, "id">): Job {
    const entries = Object.entries(job);
    const row = this.#db
      .query<Row, (string | number | null)[]>(
        `INSERT INTO p_exec_jobs (${entries.map(([k]) => column(k)).join(", ")})
         VALUES (${entries.map(() => "?").join(", ")}) RETURNING *`,
      )
      .get(...entries.map(([, v]) => toSql(v)));
    return fromRow(row as Row);
  }

  update(id: number, patch: Partial<Omit<Job, "id">>): Job | undefined {
    const entries = Object.entries(patch);
    if (entries.length > 0) {
      this.#db
        .query(`UPDATE p_exec_jobs SET ${entries.map(([k]) => `${column(k)} = ?`).join(", ")} WHERE id = ?`)
        .run(...entries.map(([, v]) => toSql(v)), id);
    }
    return this.get(id);
  }

  get(id: number): Job | undefined {
    const row = this.#db.query<Row, [number]>("SELECT * FROM p_exec_jobs WHERE id = ?").get(id);
    return row ? fromRow(row) : undefined;
  }

  running(): Job[] {
    return this.#db
      .query<Row, []>("SELECT * FROM p_exec_jobs WHERE status = 'running' ORDER BY id")
      .all()
      .map(fromRow);
  }

  recent(limit: number): Job[] {
    return this.#db
      .query<Row, [number]>("SELECT * FROM p_exec_jobs ORDER BY (status = 'running') DESC, id DESC LIMIT ?")
      .all(limit)
      .map(fromRow);
  }

  endedBefore(ts: number): Job[] {
    return this.#db
      .query<Row, [number]>("SELECT * FROM p_exec_jobs WHERE status != 'running' AND ended_at < ?")
      .all(ts)
      .map(fromRow);
  }

  delete(id: number): void {
    this.#db.query("DELETE FROM p_exec_jobs WHERE id = ?").run(id);
  }
}
