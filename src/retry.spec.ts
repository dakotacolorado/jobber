import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { JobApi } from "./api.ts";
import { BACKOFF_MAX_SECONDS, backoffAfter, canceled, finished, lapsed, NO_RETRY, retried, submitted, type Host, type Run } from "./domain.ts";
import { Store } from "./store.ts";
import { startNext } from "./testing.ts";

const COMMIT = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const T0 = "2026-11-13T00:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

const running = (retry = { limit: 2, backoff: 10 }, attempt = 1): Run => ({
  ...submitted({ repo: "o/r", commit: COMMIT, job: "hello", args: [], requirements: { os: null, arch: null, cpu: null, memory: null, timeout: null }, labels: {}, priority: 0, retry }, T0),
  state: "running",
  host: "h",
  attempt,
  startedAt: at(1),
  logSize: 7,
});

describe("a failed attempt", () => {
  it("is tried again after its backoff, doubling, up to the limit, the failure kept as an attempt", () => {
    const first = finished(running(), { state: "failed", exit: 3, duration: 2, reason: null }, at(5));
    expect(first).toMatchObject({
      state: "pending",
      attempt: 2,
      host: null,
      exit: null,
      logSize: 0,
      startedAt: null,
      endedAt: null,
      retryAt: at(15),
      reason: `attempt 1 failed with exit 3; retry 1 of 2 from ${at(15)}`,
    });
    expect(first.attempts).toEqual([{ attempt: 1, host: "h", state: "failed", exit: 3, reason: null, duration: 2, logSize: 7, startedAt: at(1), endedAt: at(5) }]);

    const second = finished({ ...first, state: "running", host: "h2", startedAt: at(16) }, { state: "failed", exit: 1, duration: 1, reason: "boom" }, at(20));
    expect(second).toMatchObject({ state: "pending", attempt: 3, retryAt: at(40) });
    expect(second.attempts.map((a) => [a.attempt, a.host, a.exit])).toEqual([
      [1, "h", 3],
      [2, "h2", 1],
    ]);

    // The limit spent: the third failure is the run's end.
    const third = finished({ ...second, state: "running", host: "h" }, { state: "failed", exit: 1, duration: 1, reason: null }, at(50));
    expect(third).toMatchObject({ state: "failed", attempt: 3, exit: 1, retryAt: at(40) });
    expect(third.attempts).toHaveLength(2);
  });

  it("whose lease lapsed is tried again too", () => {
    const run = { ...running(), leaseExpiresAt: at(60) };
    expect(lapsed(run, at(61))).toMatchObject({ state: "pending", attempt: 2, reason: expect.stringContaining("lease lapsed") });
  });

  it("is not tried again when canceled, when a cancel was asked for, when it succeeded, or without a retry", () => {
    expect(finished(running(), { state: "canceled", exit: 143, duration: 1, reason: null }).state).toBe("canceled");
    expect(finished(canceled(running()), { state: "failed", exit: 1, duration: 1, reason: null }).state).toBe("failed");
    expect(finished(running(), { state: "succeeded", exit: 0, duration: 1, reason: null }).state).toBe("succeeded");
    expect(finished(running(NO_RETRY), { state: "failed", exit: 1, duration: 1, reason: null }).state).toBe("failed");
    expect(retried(running())).toMatchObject({ state: "running", attempt: 1 });
  });

  it(`waits at most ${BACKOFF_MAX_SECONDS}s`, () => {
    expect(backoffAfter({ limit: 10, backoff: 600 }, 1)).toBe(600);
    expect(backoffAfter({ limit: 10, backoff: 600 }, 4)).toBe(BACKOFF_MAX_SECONDS);
  });
});

/** Writes `run` over what is stored, as no API call would. */
function force(store: Store, run: Run) {
  store.db.prepare("UPDATE runs SET state = ?, updated_at = ?, record = ? WHERE id = ?").run(run.state, run.updatedAt, JSON.stringify(run), run.id);
}

function setup() {
  const store = Store.open(":memory:");
  const api = new JobApi(store, { submitter: "s", registration: "r" }, { version: "0", commit: "x" });
  const call = (method: string, path: string, auth: string, body?: unknown, headers: Record<string, string> = {}) =>
    api.fetch(
      new Request(`http://local${path}`, {
        method,
        headers: { authorization: `Bearer ${auth}`, ...(typeof body === "object" && { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  return { store, call };
}

describe("a run with retries, over the API", () => {
  it("keeps each attempt's log and exit, readable by attempt, and is retried only after its backoff", async () => {
    const { store, call } = setup();
    const created = await call("POST", "/runs", "s", { repo: "o/r", commit: COMMIT, job: "hello", retry: { limit: 1, backoff: 60 } });
    const run = (await created.json()) as Run;
    expect(run).toMatchObject({ retry: { limit: 1, backoff: 60 }, attempt: 1, attempts: [], retryAt: null });
    const { host, token } = (await (await call("POST", "/hosts", "r", { name: "h", os: "linux", arch: "x86_64", capacity: { cpu: 1, memory: 2048 } })).json()) as { host: Host; token: string };
    const claim = () => startNext(store, host.id);
    const append = (text: string, attempt: number) => call("PATCH", `/runs/${run.id}/log?attempt=${attempt}`, token, text, { "content-range": `bytes 0-${text.length - 1}/*` });
    const complete = (attempt: number, state: string, exit: number) => call("PUT", `/runs/${run.id}?attempt=${attempt}`, token, { state, exit, duration: 1 });
    const log = async (attempt?: number) => {
      const res = await call("GET", `/runs/${run.id}/log${attempt ? `?attempt=${attempt}` : ""}`, "s");
      return { status: res.status, text: await res.text(), state: res.headers.get("run-state"), attempt: res.headers.get("run-attempt") };
    };

    expect(claim()).not.toBeNull();
    expect((await append("first\n", 1)).status).toBe(200);
    const failed = (await (await complete(1, "failed", 2)).json()) as Run;
    expect(failed).toMatchObject({ state: "pending", attempt: 2, attempts: [{ attempt: 1, exit: 2, state: "failed", logSize: 6, host: host.id }] });

    // Repeating how attempt 1 ended is answered as it was; writing to it now is refused.
    expect((await complete(1, "failed", 2)).status).toBe(200);
    expect((await append("late\n", 1)).status).toBe(409);
    // Its backoff not yet over: no host gets it.
    expect(claim()).toBeNull();
    force(store, { ...store.run(run.id)!, retryAt: new Date(Date.now() - 1000).toISOString() });
    const second = claim()!;
    expect(second.run).toMatchObject({ id: run.id, attempt: 2, state: "running" });
    expect((await append("second!\n", 2)).status).toBe(200);
    expect(await log()).toEqual({ status: 206, text: "second!\n", state: "running", attempt: "2" });
    expect((await complete(2, "succeeded", 0)).status).toBe(200);

    expect(await log(1)).toEqual({ status: 206, text: "first\n", state: "failed", attempt: "1" });
    expect(await log(2)).toEqual({ status: 206, text: "second!\n", state: "succeeded", attempt: "2" });
    expect((await log(3)).status).toBe(404);
    expect(await (await call("GET", `/runs/${run.id}`, "s")).json()).toMatchObject({ state: "succeeded", exit: 0, attempt: 2, logSize: 8, attempts: [{ attempt: 1, exit: 2 }] });
  });

  it("is not retried once canceled", async () => {
    const { store, call } = setup();
    const run = (await (await call("POST", "/runs", "s", { repo: "o/r", commit: COMMIT, job: "hello", retry: { limit: 3, backoff: 1 } })).json()) as Run;
    const { host, token } = (await (await call("POST", "/hosts", "r", { name: "h", os: "linux", arch: "x86_64", capacity: { cpu: 1, memory: 2048 } })).json()) as { host: Host; token: string };
    startNext(store, host.id);
    await call("POST", `/runs/${run.id}/cancel`, "s");
    const ended = (await (await call("PUT", `/runs/${run.id}?attempt=1`, token, { state: "failed", exit: 143, duration: 1 })).json()) as Run;
    expect(ended).toMatchObject({ state: "failed", attempt: 1, attempts: [] });
  });

  it.each([
    ["a limit past 10", { limit: 11 }],
    ["a backoff of 0", { backoff: 0 }],
    ["a backoff past an hour", { backoff: 3601 }],
  ])("refuses %s with 400", async (_, retry) => {
    const { call } = setup();
    expect((await call("POST", "/runs", "s", { repo: "o/r", commit: COMMIT, job: "hello", retry })).status).toBe(400);
  });
});

describe("a database written before attempts", () => {
  it("opens with each run's log as its first attempt's, and each run with no retry", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, state TEXT NOT NULL, repo TEXT NOT NULL COLLATE NOCASE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE run_logs (run_id TEXT NOT NULL, start INTEGER NOT NULL, data BLOB NOT NULL, written_at TEXT NOT NULL, PRIMARY KEY (run_id, start));
      CREATE INDEX run_logs_by_written ON run_logs (written_at);`);
    const run = { ...running(), state: "succeeded" } as Partial<Run>;
    for (const key of ["retry", "attempts", "retryAt", "attempt"] as const) delete run[key];
    db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)").run(run.id!, "succeeded", "o/r", T0, T0, JSON.stringify(run));
    db.prepare("INSERT INTO run_logs VALUES (?, ?, ?, ?)").run(run.id!, 0, new TextEncoder().encode("old log"), T0);
    const store = new Store(db);
    const opened = store.run(run.id!)!;
    expect(opened).toMatchObject({ attempt: 1, attempts: [], retryAt: null, retry: NO_RETRY });
    expect(new TextDecoder().decode(store.log(opened, 0, 100))).toBe("old log");
    // Opening it again changes nothing.
    expect(new TextDecoder().decode(new Store(db).log(opened, 0, 100))).toBe("old log");
  });
});
