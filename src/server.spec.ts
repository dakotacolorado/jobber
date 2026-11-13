import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOG_DAYS, type Host, type Run } from "./domain.ts";
import { start, type Running } from "./server.ts";
import { Store } from "./store.ts";
import { startNext } from "./testing.ts";
import { PRUNE_SECONDS, startTimers, SWEEP_SECONDS } from "./sweep.ts";

const COMMIT = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const tokens = { submitter: "submitter", registration: "registration" };

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function on(running: Running) {
  return (method: string, path: string, auth = tokens.submitter, body?: unknown, headers: Record<string, string> = {}) =>
    running.api.fetch(
      new Request(`http://local${path}`, {
        method,
        headers: { authorization: `Bearer ${auth}`, ...(typeof body === "object" && { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
}

describe("a database on disk", () => {
  it("keeps a run, its log and its host across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobber-"));
    dirs.push(dir);
    const db = join(dir, "jobber.db");

    const first = start({ db, tokens });
    const call = on(first);
    const run = (await (await call("POST", "/runs", tokens.submitter, { repo: "o/r", commit: COMMIT, job: "hello" })).json()) as Run;
    const { host, token } = (await (await call("POST", "/hosts", tokens.registration, { name: "h", os: "linux", arch: "x86_64", capacity: { cpu: 1, memory: 2048 } })).json()) as {
      host: Host;
      token: string;
    };
    expect(startNext(first.store, host.id)?.run.id).toBe(run.id);
    const append = (text: string, at: number) =>
      call("PATCH", `/runs/${run.id}/log`, token, text, { "content-range": `bytes ${at}-${at + text.length - 1}/*` });
    expect((await append("hello ", 0)).status).toBe(200);
    expect((await append("world\n", 6)).status).toBe(200);
    expect((await call("PUT", `/runs/${run.id}`, token, { state: "succeeded", exit: 0, duration: 1 })).status).toBe(200);
    first.close();

    const second = start({ db, tokens });
    const again = on(second);
    expect(await (await again("GET", `/runs/${run.id}`)).json()).toMatchObject({ id: run.id, state: "succeeded", exit: 0, logSize: 12 });
    const log = await again("GET", `/runs/${run.id}/log`, tokens.submitter, undefined, { range: "bytes=3-" });
    expect(await log.text()).toBe("lo world\n");
    expect(log.headers.get("run-state")).toBe("succeeded");
    expect(((await (await again("GET", "/hosts")).json()) as { hosts: Host[] }).hosts.map((h) => h.id)).toEqual([host.id]);
    second.close();
  });

  it("answers /health with the version and commit it runs", async () => {
    const running = start({ db: ":memory:", tokens });
    const health = (await (await on(running)("GET", "/health", "")).json()) as { ok: boolean; version: string; commit: string };
    expect(health).toMatchObject({ ok: true, version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(health.commit).toMatch(/^([0-9a-f]{40}(-dirty)?|unknown)$/);
    running.close();
  });
});

describe("the timers", () => {
  it("fail a run whose lease lapsed within a sweep, and prune logs past LOG_DAYS", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00.000Z") });
    const store = Store.open(":memory:");
    const lines: string[] = [];
    const stop = startTimers(store, (line) => lines.push(line));

    const at = new Date().toISOString();
    const run: Run = {
      id: "11111111-1111-4111-8111-111111111111",
      repo: "o/r",
      commit: COMMIT,
      job: "hello",
      args: [],
      requirements: { os: null, arch: null, cpu: null, memory: null, timeout: null },
      labels: {},
      priority: 0,
      state: "running",
      reason: null,
      cancelRequested: false,
      host: "22222222-2222-4222-8222-222222222222",
      assignedAt: null,
      attempt: 1,
      attempts: [],
      retryAt: null,
      retry: { limit: 0, backoff: 10 },
      exit: null,
      duration: null,
      logSize: 0,
      createdAt: at,
      updatedAt: at,
      startedAt: at,
      endedAt: null,
      leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    };
    store.create(run);
    store.append(run, 0, new TextEncoder().encode("old\n"), at);

    vi.advanceTimersByTime(SWEEP_SECONDS * 1000);
    expect(store.run(run.id)!.state).toBe("running");
    vi.advanceTimersByTime(SWEEP_SECONDS * 1000);
    expect(store.run(run.id)).toMatchObject({ state: "failed", reason: expect.stringContaining("lease lapsed") });
    expect(lines).toContain(JSON.stringify({ lapsed: 1 }));

    vi.advanceTimersByTime(LOG_DAYS * 86_400_000 - 2 * SWEEP_SECONDS * 1000 - PRUNE_SECONDS * 1000);
    expect(store.log(store.run(run.id)!, 0, 100).length).toBe(4);
    vi.advanceTimersByTime(PRUNE_SECONDS * 1000 * 2);
    expect(store.log(store.run(run.id)!, 0, 100).length).toBe(0);
    expect(lines).toContain(JSON.stringify({ pruned: 1 }));

    stop();
    store.close();
  });

  it("prune a run's log only once its last append is past LOG_DAYS, and then all of it", () => {
    const store = Store.open(":memory:");
    const insert = store.db.prepare("INSERT INTO run_logs (run_id, attempt, start, data, written_at) VALUES (?, 1, ?, ?, ?)");
    const enc = new TextEncoder();
    insert.run("old-start", 0, enc.encode("AAAAA"), "2025-01-01T00:00:00.000Z");
    insert.run("old-start", 5, enc.encode("BBBBB"), "2026-01-01T00:00:00.000Z");
    insert.run("all-old", 0, enc.encode("CCCCC"), "2025-01-01T00:00:00.000Z");
    expect(store.pruneLogs("2026-01-02T00:00:00.000Z")).toBe(1);
    const left = store.db.prepare("SELECT run_id, start FROM run_logs ORDER BY run_id, start").all();
    expect(left.map((r) => `${r.run_id}@${r.start}`)).toEqual(["old-start@0", "old-start@5"]);
    store.close();
  });
});
