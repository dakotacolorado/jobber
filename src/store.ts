import { backup, DatabaseSync } from "node:sqlite";
import { DEFAULT_MEMORY_MIB, LOG_DAYS, RequestError, type Host, type Run, type State } from "./domain.ts";

export interface StoredHost extends Host {
  /** sha256 of its secret, hex. */
  tokenHash: string;
}

export interface RunFilter {
  state?: State;
  /** `owner/name`, matched without regard to case. */
  repo?: string;
  /** Every one of these labels, with these values. */
  labels?: [string, string][];
  limit: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  repo TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_by_state ON runs (state, created_at, id);
CREATE INDEX IF NOT EXISTS runs_by_created ON runs (created_at, id);
CREATE TABLE IF NOT EXISTS run_logs (
  run_id TEXT NOT NULL,
  start INTEGER NOT NULL,
  data BLOB NOT NULL,
  written_at TEXT NOT NULL,
  PRIMARY KEY (run_id, start)
);
CREATE INDEX IF NOT EXISTS run_logs_by_written ON run_logs (written_at);
CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, record TEXT NOT NULL);
`;

const conflict = (run: Pick<Run, "id">) => new RequestError(`run ${run.id} changed meanwhile: read it again`, 409);

type Row = Record<string, unknown>;

const fromRow = (row: Row | undefined): Run | null => (row ? (JSON.parse(row.record as string) as Run) : null);

/**
 * Runs, their logs and hosts in one SQLite database, each run and host as
 * its JSON beside the columns it is found by. Every write is one synchronous
 * statement or transaction, so one process never interleaves two; a write
 * based on a run that has changed since it was read is refused with 409.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    migrate(db);
    db.exec(SCHEMA);
    backfill(db);
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
  runs({ state, repo, labels = [], limit }: RunFilter): Run[] {
    const where: string[] = [];
    const args: string[] = [];
    if (state !== undefined) where.push("state = ?"), args.push(state);
    if (repo !== undefined) where.push("repo = ?"), args.push(repo);
    for (const [key, value] of labels) {
      where.push("EXISTS (SELECT 1 FROM json_each(runs.record, '$.labels') WHERE json_each.key = ? AND json_each.value = ?)");
      args.push(key, value);
    }
    const sql = `SELECT record FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`;
    return this.db
      .prepare(sql)
      .all(...args, limit)
      .map((row) => fromRow(row)!);
  }

  create(run: Run): void {
    try {
      this.db
        .prepare("INSERT INTO runs (id, state, repo, created_at, updated_at, record) VALUES (?, ?, ?, ?, ?, ?)")
        .run(run.id, run.state, run.repo, run.createdAt, run.updatedAt, JSON.stringify(run));
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

  /** Pending runs in queue order: highest priority first, then oldest (`queueOrder`). */
  pending(): Run[] {
    return this.db
      .prepare("SELECT record FROM runs WHERE state = 'pending' ORDER BY record ->> '$.priority' DESC, created_at, id")
      .all()
      .map((row) => fromRow(row)!);
  }

  /** Running runs, in no order. */
  running(): Run[] {
    return this.inState("running");
  }

  /** Runs in any of `states`, in no order. */
  inState(...states: State[]): Run[] {
    return this.db
      .prepare(`SELECT record FROM runs WHERE state IN (${states.map(() => "?").join(", ")})`)
      .all(...states)
      .map((row) => fromRow(row)!);
  }

  /**
   * Stores `bytes` at `start`, sets the run's log size and `updatedAt`, and
   * answers the run as it then is. Refused with 409 unless the run is still
   * running on its host with its log `start` bytes long.
   */
  append(run: Run, start: number, bytes: Uint8Array, at: string): Run {
    return this.transaction(() => {
      const stored = this.run(run.id);
      if (!stored || stored.state !== "running" || stored.host !== run.host || stored.logSize !== start) throw conflict(run);
      if (bytes.length) this.db.prepare("INSERT INTO run_logs (run_id, start, data, written_at) VALUES (?, ?, ?, ?)").run(run.id, start, bytes, at);
      const next = { ...stored, logSize: start + bytes.length, updatedAt: at > stored.updatedAt ? at : stored.updatedAt };
      this.update(next, stored.updatedAt);
      return next;
    });
  }

  /**
   * Renews the lease of each of `ids` still running on `host`, and answers
   * those a cancel was asked for and those no longer running there.
   */
  renew(host: string, ids: string[], lease: string, at: string): { cancel: string[]; ended: string[] } {
    return this.transaction(() => {
      const cancel: string[] = [];
      const ended: string[] = [];
      for (const id of ids) {
        const stored = this.run(id);
        if (!stored || stored.state !== "running" || stored.host !== host) {
          ended.push(id);
          continue;
        }
        this.update({ ...stored, leaseExpiresAt: lease, updatedAt: at > stored.updatedAt ? at : stored.updatedAt }, stored.updatedAt);
        if (stored.cancelRequested) cancel.push(id);
      }
      return { cancel, ended };
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

  /** Stores `host`, replacing the one of that name, whose id it must keep. */
  putHost(host: StoredHost): void {
    this.db
      .prepare("INSERT INTO hosts (id, name, record) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, record = excluded.record")
      .run(host.id, host.name, JSON.stringify(host));
  }

  host(id: string): StoredHost | null {
    const row = this.db.prepare("SELECT record FROM hosts WHERE id = ?").get(id);
    return row ? (JSON.parse(row.record as string) as StoredHost) : null;
  }

  hostNamed(name: string): StoredHost | null {
    const row = this.db.prepare("SELECT record FROM hosts WHERE name = ?").get(name);
    return row ? (JSON.parse(row.record as string) as StoredHost) : null;
  }

  hosts(): StoredHost[] {
    return this.db
      .prepare("SELECT record FROM hosts")
      .all()
      .map((row) => JSON.parse(row.record as string) as StoredHost);
  }

  /** What a host last said: when, and what it had free and how it was, when it said. */
  seen(id: string, at: string, report: Partial<Pick<Host, "free" | "metrics">> = {}): void {
    const host = this.host(id);
    if (host) this.putHost({ ...host, ...report, lastSeenAt: at });
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

/** Gives each run stored before a field was added that field's default: `priority` 0, `assignedAt` null. */
export function backfill(db: DatabaseSync): void {
  db.exec("UPDATE runs SET record = json_set(record, '$.priority', 0) WHERE record ->> '$.priority' IS NULL");
  db.exec("UPDATE runs SET record = json_set(record, '$.assignedAt', json('null')) WHERE json_type(record, '$.assignedAt') IS NULL");
}

type Legacy = Record<string, unknown>;

/**
 * Brings a database written before hosts and requirements to this shape:
 * each run's `limits` become its `requirements`, its `for` and `submittedBy`
 * become labels (`<kind>=<id>`, `by=<who>`), its `runner` its `host`, and each
 * runner a host named for the machine it said it was on. Does nothing to one
 * already migrated, or new.
 */
export function migrate(db: DatabaseSync): void {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
  if (!tables.has("runs")) return;
  const columns = new Set((db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name));
  if (!columns.has("for_key") && !tables.has("runners")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const label = (text: string) => text.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "").slice(0, 63) || "x";
    for (const row of db.prepare("SELECT id, record FROM runs").all() as { id: string; record: string }[]) {
      const old = JSON.parse(row.record) as Legacy;
      if ("requirements" in old) continue;
      const { limits, for: f, submittedBy, runner, routine: _r, host: _h, runsWith: _w, ...rest } = old as {
        limits?: { memory: number | null; timeout: number | null };
        for?: { kind: string; id: string } | null;
        submittedBy?: string | null;
        runner?: string | null;
        routine?: unknown;
        host?: unknown;
        runsWith?: unknown;
      } & Legacy;
      const labels = { ...((rest.labels as Record<string, string>) ?? {}) };
      if (f) labels[label(f.kind)] = label(f.id);
      if (submittedBy) labels.by = label(submittedBy);
      const run = {
        ...rest,
        requirements: { os: null, arch: null, memory: limits?.memory ?? null, timeout: limits?.timeout ?? null },
        labels,
        host: runner ?? null,
      };
      db.prepare("UPDATE runs SET record = ? WHERE id = ?").run(JSON.stringify(run), row.id);
    }
    if (columns.has("for_key")) {
      db.exec("DROP INDEX IF EXISTS runs_by_for; ALTER TABLE runs DROP COLUMN for_key; ALTER TABLE runs DROP COLUMN submitted_by;");
    }
    if (tables.has("runners")) {
      db.exec("CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, record TEXT NOT NULL)");
      const taken = new Set<string>();
      for (const row of db.prepare("SELECT record FROM runners").all() as { record: string }[]) {
        const old = JSON.parse(row.record) as {
          id: string;
          name: string;
          hostId?: string | null;
          labels?: Record<string, string>;
          slots: number;
          memory?: number;
          version?: string | null;
          createdAt: string;
          lastSeenAt: string;
          tokenHash: string;
        };
        let name = old.hostId ?? old.name;
        if (taken.has(name)) name = `${name}-${old.id.slice(0, 8)}`;
        taken.add(name);
        const arch = old.labels?.arch === "aarch64" ? "aarch64" : "x86_64";
        const host: StoredHost = {
          id: old.id,
          name,
          os: "linux",
          arch,
          slots: old.slots,
          memory: old.memory ?? DEFAULT_MEMORY_MIB,
          labels: old.labels ?? {},
          version: old.version ?? null,
          free: null,
          metrics: null,
          createdAt: old.createdAt,
          lastSeenAt: old.lastSeenAt,
          tokenHash: old.tokenHash,
        };
        db.prepare("INSERT OR IGNORE INTO hosts (id, name, record) VALUES (?, ?, ?)").run(host.id, host.name, JSON.stringify(host));
      }
      db.exec("DROP TABLE runners");
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
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
