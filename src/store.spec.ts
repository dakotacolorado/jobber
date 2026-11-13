import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { NO_RETRY, queueOrder, submitted, type Run } from "./domain.ts";
import { Store } from "./store.ts";

const COMMIT = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const draft = { repo: "o/r", commit: COMMIT, job: "hello", args: [], requirements: { os: null, arch: null, memory: null, timeout: null }, labels: {}, retry: NO_RETRY };

describe("a database written before priority and assignments", () => {
  it("opens with each run at priority 0 and assigned nowhere, queued oldest first", () => {
    const db = new DatabaseSync(":memory:");
    new Store(db);
    const older = { ...submitted({ ...draft, priority: 0 }, "2026-11-01T00:00:00.000Z") } as Partial<Run>;
    const newer = { ...submitted({ ...draft, priority: 0 }, "2026-11-02T00:00:00.000Z") } as Partial<Run>;
    for (const run of [newer, older]) {
      delete run.priority;
      delete run.assignedAt;
      db.prepare("INSERT INTO runs (id, state, repo, created_at, updated_at, record) VALUES (?, ?, ?, ?, ?, ?)").run(
        run.id!,
        run.state!,
        run.repo!,
        run.createdAt!,
        run.updatedAt!,
        JSON.stringify(run),
      );
    }
    const store = new Store(db);
    expect(store.run(older.id!)).toMatchObject({ priority: 0, assignedAt: null });
    expect(store.pending().map((r) => r.id)).toEqual([older.id, newer.id]);
  });
});

describe("the queue", () => {
  it("is in queueOrder: higher priority first, then older", () => {
    const store = Store.open(":memory:");
    const runs = [
      submitted({ ...draft, priority: 0 }, "2026-11-01T00:00:00.000Z"),
      submitted({ ...draft, priority: 3 }, "2026-11-03T00:00:00.000Z"),
      submitted({ ...draft, priority: -2 }, "2026-11-01T00:00:00.000Z"),
      submitted({ ...draft, priority: 3 }, "2026-11-02T00:00:00.000Z"),
      submitted({ ...draft, priority: 1000 }, "2026-11-04T00:00:00.000Z"),
    ];
    for (const run of runs) store.create(run);
    expect(store.pending().map((r) => r.id)).toEqual([...runs].sort(queueOrder).map((r) => r.id));
    expect(store.pending().map((r) => r.priority)).toEqual([1000, 3, 3, 0, -2]);
  });
});
