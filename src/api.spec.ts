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
    const res = await call("POST", "/runs", { repo: "dakotacolorado/python-template", commit: COMMIT, job: "hello", ...over });
    expect(res.status).toBe(201);
    return (await res.json()) as Run;
  };
  return { store, call, submit };
}

describe("POST /runs", () => {
  it("stores a pending run with what was submitted, and defaults for what was not", async () => {
    const { submit, call } = setup();
    const run = await submit({ args: ["--n", "3"], requirements: { memory: 256, os: "linux" }, labels: { item: "28af81bc", by: "agent-1" } });
    expect(run).toMatchObject({
      repo: "dakotacolorado/python-template",
      commit: COMMIT,
      job: "hello",
      args: ["--n", "3"],
      requirements: { os: "linux", arch: null, memory: 256, timeout: null },
      labels: { item: "28af81bc", by: "agent-1" },
      state: "pending",
      host: null,
      exit: null,
      logSize: 0,
    });
    expect(await (await call("GET", `/runs/${run.id}`)).json()).toEqual(run);
    expect(await submit()).toMatchObject({ args: [], requirements: { os: null, arch: null, memory: null, timeout: null }, labels: {}, priority: 0 });
    expect(await submit({ priority: -5 })).toMatchObject({ priority: -5 });
  });

  it.each([
    ["an os it does not know", { requirements: { os: "plan9" } }],
    ["an arch it does not know", { requirements: { arch: "mips" } }],
    ["a short commit", { commit: "4b825dc" }],
    ["a repo that is not owner/name", { repo: "python-template" }],
    ["a job name with a space", { job: "hello world" }],
    ["no job", { job: undefined }],
    ["memory that is not whole MiB", { requirements: { memory: 1.5 } }],
    ["a negative timeout", { requirements: { timeout: -1 } }],
    ["a label with a space", { labels: { "a b": "c" } }],
    ["args that are not strings", { args: [1] }],
    ["a priority that is not whole", { priority: 1.5 }],
    ["a priority past 1000", { priority: 1001 }],
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

describe("labels", () => {
  it("list runs by one label or several, newest first, with the other filters", async () => {
    const { submit, call } = setup();
    const a = await submit({ labels: { item: "28af81bc", by: "agent-1" } });
    // Two submits in one millisecond share a createdAt, and newest-first would not tell them apart.
    await new Promise((res) => setTimeout(res, 3));
    const b = await submit({ labels: { item: "28af81bc", by: "agent-2" } });
    await submit();
    const list = async (q: string) => ((await (await call("GET", `/runs?${q}`)).json()) as { runs: Run[] }).runs.map((r) => r.id);
    expect(await list("label=item=28af81bc")).toEqual([b.id, a.id]);
    expect(await list("label=item=28af81bc&label=by=agent-1")).toEqual([a.id]);
    expect(await list("label=item=other")).toEqual([]);
    expect(await list("label=item=28af81bc&state=running")).toEqual([]);
  });

  it("refuses a label that is not key=value, and keys or values with spaces", async () => {
    const { call } = setup();
    expect((await call("GET", "/runs?label=item")).status).toBe(400);
    expect((await call("GET", "/runs?label==x")).status).toBe(400);
    expect((await call("POST", "/runs", { repo: "a/b", commit: COMMIT, job: "hello", labels: { "a b": "c" } })).status).toBe(400);
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

  it("marks a running run for its host to stop, leaving it running", async () => {
    const { store, submit, call } = setup();
    const job = await submit();
    force(store, { ...job, state: "running", host: "11111111-1111-4111-8111-111111111111" });
    const res = await call("POST", `/runs/${job.id}/cancel`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "running", cancelRequested: true, endedAt: null });
  });

  it("is 404 for an unknown job", async () => {
    const { call } = setup();
    expect((await call("POST", "/runs/00000000-0000-4000-8000-000000000000/cancel")).status).toBe(404);
  });
});

describe("POST /runs/{id}/priority", () => {
  it("moves a run not yet ended, and refuses an ended one with 409", async () => {
    const { submit, call } = setup();
    const run = await submit();
    const res = await call("POST", `/runs/${run.id}/priority`, { priority: 50 });
    expect(res.status).toBe(200);
    const moved = (await res.json()) as Run;
    expect(moved).toMatchObject({ id: run.id, state: "pending", priority: 50 });
    expect(moved.updatedAt > run.updatedAt).toBe(true);
    expect(await (await call("GET", `/runs/${run.id}`)).json()).toEqual(moved);
    expect((await call("POST", `/runs/${run.id}/priority`, { priority: 2000 })).status).toBe(400);
    await call("POST", `/runs/${run.id}/cancel`);
    expect((await call("POST", `/runs/${run.id}/priority`, { priority: 1 })).status).toBe(409);
    expect((await call("POST", "/runs/00000000-0000-4000-8000-000000000000/priority", { priority: 1 })).status).toBe(404);
  });
});
