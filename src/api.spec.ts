import { describe, expect, it } from "vitest";
import { JobApi } from "./api.ts";
import type { Run } from "./domain.ts";
import { slice, Store } from "./store.ts";

const TOKEN = "submitter";
const REGISTRATION = "registration";
const COMMIT = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const ABOUT = { version: "0.1.0", commit: "x" };

/** Writes `run` over what is stored, as no API call would: to put a run in a state a test needs. */
function force(store: Store, run: Run) {
  store.db.prepare("UPDATE runs SET state = ?, updated_at = ?, record = ? WHERE id = ?").run(run.state, run.updatedAt, JSON.stringify(run), run.id);
}

function setup() {
  const store = Store.open(":memory:");
  const api = new JobApi(store, { submitter: TOKEN, registration: REGISTRATION }, ABOUT);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    api.fetch(
      new Request(`http://local${path}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined && { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const submit = async (over: Record<string, unknown> = {}) => {
    const res = await call("POST", "/runs", { repo: "dakotacolorado/python-template", commit: COMMIT, job: "hello", ...over }, { "claimed-by": "agent-1" });
    expect(res.status).toBe(201);
    return (await res.json()) as Run;
  };
  return { store, call, submit };
}

describe("POST /runs", () => {
  it("stores a pending job with what was submitted, and defaults for what was not", async () => {
    const { submit, call } = setup();
    const job = await submit({ args: ["--n", "3"], limits: { memory: 256 }, labels: { arch: "x86_64" } });
    expect(job).toMatchObject({
      repo: "dakotacolorado/python-template",
      commit: COMMIT,
      job: "hello",
      args: ["--n", "3"],
      limits: { memory: 256, timeout: null },
      labels: { arch: "x86_64" },
      state: "pending",
      runner: null,
      runsWith: null,
      exit: null,
      logSize: 0,
      submittedBy: "agent-1",
    });
    expect(await (await call("GET", `/runs/${job.id}`)).json()).toEqual(job);
    expect(await submit()).toMatchObject({ args: [], limits: { memory: null, timeout: null }, labels: {} });
  });

  it("stores and serves a routine beside its target, and null without one", async () => {
    const { submit, call } = setup();
    const routine = { repo: "dakotacolorado/release-routines", commit: "862d32fbe2a988fb533215c156cf058191ec54b9", dir: "dakotacolorado/honed" };
    const job = await submit({ repo: "dakotacolorado/honed", routine });
    expect(job).toMatchObject({ repo: "dakotacolorado/honed", commit: COMMIT, job: "hello", routine });
    expect(await (await call("GET", `/runs/${job.id}`)).json()).toEqual(job);
    expect(await submit()).toMatchObject({ routine: null, host: null });
    expect((await submit({ host: "dakotas-hp-laptop" })).host).toBe("dakotas-hp-laptop");
  });

  it.each([
    ["a routine dir that climbs out", { routine: { repo: "o/r", commit: COMMIT, dir: "o/../x" } }],
    ["a routine dir that is absolute", { routine: { repo: "o/r", commit: COMMIT, dir: "/o/b" } }],
    ["an empty host", { host: "" }],
    ["a routine at a short commit", { routine: { repo: "o/r", commit: "4b825dc", dir: "o/b" } }],
    ["a routine with no dir", { routine: { repo: "o/r", commit: COMMIT } }],
    ["a short commit", { commit: "4b825dc" }],
    ["a repo that is not owner/name", { repo: "python-template" }],
    ["a job name with a space", { job: "hello world" }],
    ["no job", { job: undefined }],
    ["memory that is not whole MiB", { limits: { memory: 1.5 } }],
    ["a negative timeout", { limits: { timeout: -1 } }],
    ["a label with a space", { labels: { "a b": "c" } }],
    ["args that are not strings", { args: [1] }],
  ])("refuses %s with 400", async (_, over) => {
    const { call } = setup();
    const res = await call("POST", "/runs", { repo: "dakotacolorado/python-template", commit: COMMIT, job: "hello", ...over });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "ValidationException", message: expect.any(String) });
  });

  it("refuses malformed JSON with 400", async () => {
    const { call } = setup();
    const res = await call("POST", "/runs", undefined, { "content-type": "application/json" });
    expect(res.status).toBe(400);
  });
});

describe("what a run was for", () => {
  it("is recorded as submitted, null when not said, and lists runs by it", async () => {
    const { submit, call } = setup();
    const item = { kind: "item", id: "28af81bc-6a9a-4189-ad1f-8fd9de51308a" };
    const a = await submit({ for: item });
    const b = await submit({ for: { kind: "worker", id: "d03e1824-3c95ed51" } });
    const none = await submit();
    expect(a.for).toEqual(item);
    expect(none.for).toBeNull();
    const list = async (q: string) => ((await (await call("GET", `/runs?${q}`)).json()) as { runs: Run[] }).runs.map((j) => j.id);
    expect(await list(`for=item:${item.id}`)).toEqual([a.id]);
    expect(await list("for=worker:d03e1824-3c95ed51")).toEqual([b.id]);
    expect(await list("for=batch:nothing")).toEqual([]);
    expect(await list(`for=item:${item.id}&state=running`)).toEqual([]);
    expect(await list(`for=item:${item.id}&state=pending`)).toEqual([a.id]);
  });

  it("refuses a kind it does not know, and an id with spaces", async () => {
    const { call } = setup();
    const body = { repo: "dakotacolorado/python-template", commit: COMMIT, job: "hello" };
    expect((await call("POST", "/runs", { ...body, for: { kind: "epic", id: "x" } })).status).toBe(400);
    expect((await call("POST", "/runs", { ...body, for: { kind: "item", id: "a b" } })).status).toBe(400);
    expect((await call("GET", "/runs?for=epic:x")).status).toBe(400);
    expect((await call("GET", "/runs?for=item")).status).toBe(400);
  });
});

describe("runs by who submitted them", () => {
  it("lists only that submitter's, newest first, with the other filters", async () => {
    const { submit, call } = setup();
    const a = await submit();
    // Two submits in one millisecond share a createdAt, and newest-first would not tell them apart.
    await new Promise((res) => setTimeout(res, 3));
    const b = await submit({ job: "build" });
    const other = (await (await call("POST", "/runs", { repo: "dakotacolorado/python-template", commit: COMMIT, job: "hello" }, { "claimed-by": "agent-2" })).json()) as Run;
    const list = async (q: string) => ((await (await call("GET", `/runs?${q}`)).json()) as { runs: Run[] }).runs.map((j) => j.id);
    expect(await list("submittedBy=agent-1")).toEqual([b.id, a.id]);
    expect(await list("submittedBy=agent-2")).toEqual([other.id]);
    expect(await list("submittedBy=agent-1&state=running")).toEqual([]);
    expect(await list("submittedBy=nobody")).toEqual([]);
  });
});

describe("auth", () => {
  it("needs the submitter token on every jobs route, but not /health", async () => {
    const { submit, call } = setup();
    const job = await submit();
    for (const [method, path] of [["GET", "/runs"], ["GET", `/runs/${job.id}`], ["GET", `/runs/${job.id}/log`], ["POST", `/runs/${job.id}/cancel`], ["POST", "/runs"]] as const) {
      expect((await call(method, path, undefined, { authorization: "Bearer wrong" })).status, `${method} ${path}`).toBe(401);
    }
    expect((await call("GET", "/health", undefined, { authorization: "" })).status).toBe(200);
  });
});

describe("GET /runs", () => {
  it("lists newest first, filtered by state and repo", async () => {
    const { submit, call } = setup();
    // Apart in time: jobs submitted in the same millisecond have no order between them.
    const tick = () => new Promise((r) => setTimeout(r, 3));
    const a = await submit();
    await tick();
    const b = await submit({ repo: "dakotacolorado/other" });
    await tick();
    const c = await submit();
    await call("POST", `/runs/${a.id}/cancel`);
    const ids = async (q: string) => ((await (await call("GET", `/runs${q}`)).json()) as { runs: Run[] }).runs.map((j) => j.id);
    expect(await ids("")).toEqual([c.id, b.id, a.id]);
    expect(await ids("?state=pending")).toEqual([c.id, b.id]);
    expect(await ids("?state=canceled")).toEqual([a.id]);
    expect(await ids("?repo=dakotacolorado/other")).toEqual([b.id]);
    expect(await ids("?limit=1")).toEqual([c.id]);
    expect((await call("GET", "/runs?state=done")).status).toBe(400);
  });
});

describe("GET /runs/{id}", () => {
  it("is 404 for an unknown job", async () => {
    const { call } = setup();
    expect((await call("GET", "/runs/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});

describe("GET /runs/{id}/log", () => {
  it("reads from a byte offset, and says the size and the job's state", async () => {
    const { store, submit, call } = setup();
    const job = await submit();
    const enc = new TextEncoder();
    const insert = store.db.prepare("INSERT INTO run_logs (run_id, start, data, written_at) VALUES (?, ?, ?, ?)");
    insert.run(job.id, 0, enc.encode("hello "), job.createdAt);
    insert.run(job.id, 6, enc.encode("world\n"), job.createdAt);
    force(store, { ...store.run(job.id)!, logSize: 12 });

    const all = await call("GET", `/runs/${job.id}/log`);
    expect(all.status).toBe(206);
    expect(await all.text()).toBe("hello world\n");
    expect(all.headers.get("content-range")).toBe("bytes 0-11/12");
    expect(all.headers.get("run-state")).toBe("pending");

    const tail = await call("GET", `/runs/${job.id}/log`, undefined, { range: "bytes=4-" });
    expect(await tail.text()).toBe("o world\n");
    expect(tail.headers.get("content-range")).toBe("bytes 4-11/12");

    const end = await call("GET", `/runs/${job.id}/log`, undefined, { range: "bytes=12-" });
    expect(end.status).toBe(206);
    expect(await end.text()).toBe("");
    expect(end.headers.get("content-range")).toBe("bytes */12");

    expect((await call("GET", `/runs/${job.id}/log`, undefined, { range: "bytes=13-" })).status).toBe(416);
    expect((await call("GET", `/runs/${job.id}/log`, undefined, { range: "bytes=0-4" })).status).toBe(400);
  });
});

describe("slice", () => {
  const enc = new TextEncoder();
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);
  const chunks = ["abc", "defg", "h"].map((s) => enc.encode(s));

  it.each([
    [0, 8, "abcdefgh"],
    [2, 3, "cde"],
    [3, 4, "defg"],
    [7, 5, "h"],
    [8, 1, ""],
  ])("from %i, %i bytes", (from, want, expected) => {
    expect(dec(slice(chunks, 0, from, want))).toBe(expected);
  });

  it("reads chunks that start past 0", () => {
    expect(dec(slice(chunks.slice(1), 3, 5, 2))).toBe("fg");
  });
});

describe("POST /runs/{id}/cancel", () => {
  it("ends a pending job canceled at once", async () => {
    const { submit, call } = setup();
    const job = await submit();
    const res = await call("POST", `/runs/${job.id}/cancel`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "canceled", cancelRequested: true, reason: "canceled before it started" });
    expect((await call("POST", `/runs/${job.id}/cancel`)).status).toBe(409);
  });

  it("marks a running job for its runner to stop, leaving it running", async () => {
    const { store, submit, call } = setup();
    const job = await submit();
    force(store, { ...job, state: "running", runner: "11111111-1111-4111-8111-111111111111" });
    const res = await call("POST", `/runs/${job.id}/cancel`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "running", cancelRequested: true, endedAt: null });
  });

  it("is 404 for an unknown job", async () => {
    const { call } = setup();
    expect((await call("POST", "/runs/00000000-0000-4000-8000-000000000000/cancel")).status).toBe(404);
  });
});
