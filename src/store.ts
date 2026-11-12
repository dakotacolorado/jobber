import { backup, DatabaseSync } from "node:sqlite";
import { forKey, LOG_DAYS, RequestError, type For, type Run, type Runner, type RunsWith, type State } from "./domain.ts";

export interface StoredRunner extends Runner {
  /** sha256 of its secret, hex. */
  tokenHash: string;
}

export interface RunFilter {
  state?: State;
  for?: For;
  /** `owner/name`, matched without regard to case. */
  repo?: string;
  submittedBy?: string;
  limit: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  repo TEXT NOT NULL COLLATE NOCASE,
  submitted_by TEXT,
  for_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_by_state ON runs (state, created_at, id);
CREATE INDEX IF NOT EXISTS runs_by_created ON runs (created_at, id);
CREATE INDEX IF NOT EXISTS runs_by_for ON runs (for_key, created_at) WHERE for_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS run_logs (
  run_id TEXT NOT NULL,
  start INTEGER NOT NULL,
  data BLOB NOT NULL,
  written_at TEXT NOT NULL,
  PRIMARY KEY (run_id, start)
);
CREATE INDEX IF NOT EXISTS run_logs_by_written ON run_logs (written_at);
CREATE TABLE IF NOT EXISTS runners (id TEXT PRIMARY KEY, record TEXT NOT NULL);
`;

const conflict = (run: Pick<Run, "id">) => new RequestError(`run ${run.id} changed meanwhile: read it again`, 409);

type Row = Record<string, unknown>;

const fromRow = (row: Row | undefined): Run | null => (row ? (JSON.parse(row.record as string) as Run) : null);

/**
 * Runs, their logs and runners in one SQLite database, each run and runner as
 * its JSON beside the columns it is found by. Every write is one synchronous
 * statement or transaction, so one process never interleaves two; a write
 * based on a run that has changed since it was read is refused with 409.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
  }

  /** The database at `path`, made if absent; `:memory:` for one that lasts as long as the process. */
  static open(path: string): Store {
    return new Store(new DatabaseSync(path));
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /** Copies the database to `file`, consistent while it is written to; answers the pages copied. */
  async backup(file: string): Promise<number> {
    return backup(this.db, file);
  }

  run(id: string): Run | null {
    return fromRow(this.db.prepare("SELECT record FROM runs WHERE id = ?").get(id));
  }

  /** Newest first, at most `limit`. */
  runs({ state, for: f, repo, submittedBy, limit }: RunFilter): Run[] {
    const where: string[] = [];
    const args: string[] = [];
    if (state !== undefined) where.push("state = ?"), args.push(state);
    if (f !== undefined) where.push("for_key = ?"), args.push(forKey(f));
    if (repo !== undefined) where.push("repo = ?"), args.push(repo);
    if (submittedBy !== undefined) where.push("submitted_by = ?"), args.push(submittedBy);
    const sql = `SELECT record FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`;
    return this.db
      .prepare(sql)
      .all(...args, limit)
      .map((row) => fromRow(row)!);
  }

  create(run: Run): void {
    try {
      this.db
        .prepare("INSERT INTO runs (id, state, repo, submitted_by, for_key, created_at, updated_at, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(run.id, run.state, run.repo, run.submittedBy, run.for && forKey(run.for), run.createdAt, run.updatedAt, JSON.stringify(run));
    } catch (err) {
      if ((err as { errcode?: number }).errcode === 1555) throw conflict(run);
      throw err;
    }
  }

  /** Refused with 409 unless the stored run was last updated at `base`, so two writes cannot both land. */
  update(next: Run, base: string): void {
    const { changes } = this.db
      .prepare("UPDATE runs SET state = ?, updated_at = ?, record = ? WHERE id = ? AND updated_at = ?")
      .run(next.state, next.updatedAt, JSON.stringify(next), next.id, base);
    if (changes !== 1) throw conflict(next);
  }

  /** The log's bytes from `from`, at most `max`. */
  log(run: Run, from: number, max: number): Uint8Array {
    const want = Math.min(max, run.logSize - from);
    if (want <= 0) return new Uint8Array();
    // The chunk holding `from` is the last one starting at or before it.
    const first = this.db.prepare("SELECT max(start) AS start FROM run_logs WHERE run_id = ? AND start <= ?").get(run.id, from) as { start: number | null };
    const rows = this.db
      .prepare("SELECT data FROM run_logs WHERE run_id = ? AND start >= ? AND start < ? ORDER BY start")
      .all(run.id, first.start ?? 0, from + want) as { data: Uint8Array }[];
    return slice(
      rows.map((r) => r.data),
      first.start ?? 0,
      from,
      want,
    );
  }

  /** Pending runs, oldest first. */
  pending(): Run[] {
    return this.db
      .prepare("SELECT record FROM runs WHERE state = 'pending' ORDER BY created_at, id")
      .all()
      .map((row) => fromRow(row)!);
  }

  /** Running runs, in no order. */
  running(): Run[] {
    return this.db
      .prepare("SELECT record FROM runs WHERE state = 'running'")
      .all()
      .map((row) => fromRow(row)!);
  }

  /**
   * Stores `bytes` at `start`, sets the run's log size, lease and `updatedAt`,
   * and answers the run as it then is. Refused with 409 unless the run is still
   * running on its runner with its log `start` bytes long.
   */
  append(run: Run, start: number, bytes: Uint8Array, lease: string, at: string): Run {
    return this.transaction(() => {
      const stored = this.run(run.id);
      if (!stored || stored.state !== "running" || stored.runner !== run.runner || stored.logSize !== start) throw conflict(run);
      if (bytes.length) this.db.prepare("INSERT INTO run_logs (run_id, start, data, written_at) VALUES (?, ?, ?, ?)").run(run.id, start, bytes, at);
      const next = { ...stored, logSize: start + bytes.length, leaseExpiresAt: lease, updatedAt: at > stored.updatedAt ? at : stored.updatedAt };
      this.update(next, stored.updatedAt);
      return next;
    });
  }

  /**
   * Records what a running run runs with and answers the run as it then is. Refused with 409 unless it is
   * still running on its runner; not on `updatedAt`, so the log's appends meanwhile do not refuse it.
   */
  runsWith(run: Run, runsWith: RunsWith, at: string): Run {
    return this.transaction(() => {
      const stored = this.run(run.id);
      if (!stored || stored.state !== "running" || stored.runner !== run.runner) throw conflict(run);
      const next = { ...stored, runsWith: { ...runsWith }, updatedAt: at > stored.updatedAt ? at : stored.updatedAt };
      this.update(next, stored.updatedAt);
      return next;
    });
  }

  /** Marks a running run `cancelRequested`; false when it is no longer running. */
  requestCancel(id: string, at: string): boolean {
    return this.transaction(() => {
      const stored = this.run(id);
      if (stored?.state !== "running") return false;
      this.update({ ...stored, cancelRequested: true, updatedAt: at > stored.updatedAt ? at : stored.updatedAt }, stored.updatedAt);
      return true;
    });
  }

  createRunner(runner: StoredRunner): void {
    this.db.prepare("INSERT INTO runners (id, record) VALUES (?, ?)").run(runner.id, JSON.stringify(runner));
  }

  runner(id: string): StoredRunner | null {
    const row = this.db.prepare("SELECT record FROM runners WHERE id = ?").get(id);
    return row ? (JSON.parse(row.record as string) as StoredRunner) : null;
  }

  runners(): StoredRunner[] {
    return this.db
      .prepare("SELECT record FROM runners")
      .all()
      .map((row) => JSON.parse(row.record as string) as StoredRunner);
  }

  /** Its last claim, and the host it said it is on, when it said. */
  seen(id: string, at: string, hostId?: string): void {
    const runner = this.runner(id);
    if (!runner) return;
    const next = { ...runner, lastSeenAt: at, ...(hostId !== undefined && { hostId }) };
    this.db.prepare("UPDATE runners SET record = ? WHERE id = ?").run(JSON.stringify(next), id);
  }

  /**
   * Deletes the log of every run last appended to before `LOG_DAYS` ago, all of it at once, so no read
   * sees a log with its start gone; answers how many chunks.
   */
  pruneLogs(at: string): number {
    const before = new Date(Date.parse(at) - LOG_DAYS * 86_400_000).toISOString();
    const sql = "DELETE FROM run_logs WHERE run_id IN (SELECT run_id FROM run_logs GROUP BY run_id HAVING max(written_at) < ?)";
    return Number(this.db.prepare(sql).run(before).changes);
  }

  private transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** `want` bytes from `from` of the chunks laid end to end, the first starting at `first`. */
export function slice(chunks: Uint8Array[], first: number, from: number, want: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, want));
  let at = first;
  let filled = 0;
  for (const chunk of chunks) {
    if (filled >= out.length) break;
    const end = at + chunk.length;
    if (end > from) {
      const part = chunk.subarray(Math.max(0, from + filled - at), Math.min(chunk.length, from + out.length - at));
      out.set(part, filled);
      filled += part.length;
    }
    at = end;
  }
  return out.subarray(0, filled);
}
