import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { JobApi } from "./api.ts";
import { LEASE_SECONDS, lapsed, type Host, type Run } from "./domain.ts";
import { Store } from "./store.ts";
import { sweep } from "./sweep.ts";

const TOKEN = "submitter";
const REGISTRATION = "registration";
const COMMIT = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const METRICS = { cpuLoad: 0.5, memoryUsed: 2048, memoryTotal: 8192, diskFree: 50_000 };

/** Writes `run` over what is stored, as no API call would: to put a run in a state a test needs. */
function force(store: Store, run: Run) {
  store.db.prepare("UPDATE runs SET state = ?, updated_at = ?, record = ? WHERE id = ?").run(run.state, run.updatedAt, JSON.stringify(run), run.id);
}

type Claim = { run: Run; memory: number; lease: number };
type Registered = { host: Host; token: string };

let names = 0;

function setup() {
  const store = Store.open(":memory:");
  const api = new JobApi(store, { submitter: TOKEN, registration: REGISTRATION }, { version: "0.1.0", commit: "x" });
  const call = (method: string, path: string, auth: string, body?: unknown, headers: Record<string, string> = {}) =>
    api.fetch(
      new Request(`http://local${path}`, {
        method,
        headers: { authorization: `Bearer ${auth}`, ...(body !== undefined && !(body instanceof Uint8Array) && { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
      }),
    );
  const submit = async (over: Record<string, unknown> = {}) => {
    const res = await call("POST", "/runs", TOKEN, { repo: "dakotacolorado/python-template", commit: COMMIT, job: "hello", ...over });
    expect(res.status).toBe(201);
    return (await res.json()) as Run;
  };
  const register = async (over: Record<string, unknown> = {}) => {
    const res = await call("POST", "/hosts", REGISTRATION, { name: `host-${++names}`, os: "linux", arch: "x86_64", slots: 2, memory: 3072, ...over });
    expect(res.status).toBe(201);
    return (await res.json()) as Registered;
  };
  const claim = (h: Registered, free = { slots: 1, memory: 2048 }) => call("POST", `/hosts/${h.host.id}/claim`, h.token, { free });
  const heartbeat = (h: Registered, running: string[] = [], free = { slots: 1, memory: 2048 }) =>
    call("POST", `/hosts/${h.host.id}/heartbeat`, h.token, { free, metrics: METRICS, running });
  const append = (id: string, token: string, text: string, start: number) => {
    const bytes = new TextEncoder().encode(text);
    return call("PATCH", `/runs/${id}/log`, token, bytes, {
      "content-type": "application/octet-stream",
      "content-range": `bytes ${start}-${start + bytes.length - 1}/*`,
    });
  };
  const complete = (id: string, token: string, body: Record<string, unknown>) => call("PUT", `/runs/${id}`, token, { duration: 1.5, ...body });
  const hosts = async () => ((await (await call("GET", "/hosts", TOKEN)).json()) as { hosts: Host[] }).hosts;
  return { store, call, submit, register, claim, heartbeat, append, complete, hosts };
}

describe("RegisterHost", () => {
  it("registers with the registration token, answers a token of the host's own, and lists it", async () => {
    const { register, hosts } = setup();
    const { host, token } = await register({ name: "studio", labels: { room: "office" }, version: "1.2.3" });
    expect(host).toMatchObject({ name: "studio", os: "linux", arch: "x86_64", slots: 2, memory: 3072, labels: { room: "office" }, version: "1.2.3", free: null, metrics: null });
    expect(host).not.toHaveProperty("tokenHash");
    expect(token.startsWith(`${host.id}.`)).toBe(true);
    expect((await hosts()).map((h) => h.id)).toEqual([host.id]);
  });

  it("keeps a host's id when its name registers again, and only the new token works", async () => {
    const { register, claim, hosts } = setup();
    const first = await register({ name: "studio" });
    const again = await register({ name: "studio", slots: 4 });
    expect(again.host.id).toBe(first.host.id);
    expect(again.host.slots).toBe(4);
    expect(await hosts()).toHaveLength(1);
    expect((await claim(first)).status).toBe(401);
    expect((await claim(again)).status).toBe(204);
  });

  it("refuses the submitter token, and a host token cannot list or submit", async () => {
    const { call, register } = setup();
    expect((await call("POST", "/hosts", TOKEN, { name: "h", os: "linux", arch: "x86_64", slots: 1, memory: 512 })).status).toBe(401);
    const { token } = await register();
    expect((await call("GET", "/hosts", token)).status).toBe(401);
    expect((await call("POST", "/runs", token, { repo: "a/b", commit: COMMIT, job: "hello" })).status).toBe(401);
  });

  it.each([
    ["no slots", { slots: 0 }],
    ["an os it does not know", { os: "plan9" }],
    ["an arch it does not know", { arch: "mips" }],
  ])("refuses %s", async (_, over) => {
    const { call } = setup();
    expect((await call("POST", "/hosts", REGISTRATION, { name: "h", os: "linux", arch: "x86_64", slots: 1, memory: 512, ...over })).status).toBe(400);
  });
});

describe("host auth", () => {
  it("refuses the submitter token, a bad secret and another host's token", async () => {
    const { register, submit, claim, call, append, complete, heartbeat } = setup();
    const a = await register();
    const b = await register();
    const run = await submit();
    const free = { free: { slots: 1, memory: 2048 } };
    expect((await call("POST", `/hosts/${a.host.id}/claim`, TOKEN, free)).status).toBe(401);
    expect((await call("POST", `/hosts/${a.host.id}/claim`, `${a.host.id}.wrong`, free)).status).toBe(401);
    expect((await call("POST", `/hosts/${a.host.id}/claim`, b.token, free)).status).toBe(403);
    expect((await call("POST", `/hosts/${a.host.id}/heartbeat`, b.token, { ...free, metrics: METRICS, running: [] })).status).toBe(403);
    expect((await claim(a)).status).toBe(200);
    expect((await append(run.id, TOKEN, "x", 0)).status).toBe(401);
    expect((await append(run.id, b.token, "x", 0)).status).toBe(403);
    expect((await complete(run.id, b.token, { state: "succeeded", exit: 0 })).status).toBe(403);
    expect((await complete(run.id, TOKEN, { state: "succeeded", exit: 0 })).status).toBe(401);
    expect((await heartbeat(b, [run.id])).status).toBe(200);
  });
});

describe("ClaimRun", () => {
  it("answers the oldest pending run whose requirements the host meets, now running there", async () => {
    const { register, submit, claim, call } = setup();
    const h = await register();
    const tick = () => new Promise((res) => setTimeout(res, 3));
    const big = await submit({ requirements: { memory: 4096 } });
    await tick();
    const mac = await submit({ requirements: { os: "macos" } });
    await tick();
    const arm = await submit({ requirements: { arch: "aarch64" } });
    await tick();
    const first = await submit({ requirements: { memory: 256, os: "linux", arch: "x86_64" } });
    await tick();
    const second = await submit();

    const res = await claim(h);
    expect(res.status).toBe(200);
    const got = (await res.json()) as Claim;
    expect(got.run).toMatchObject({ id: first.id, state: "running", host: h.host.id });
    expect(got.memory).toBe(256);
    expect(got.lease).toBe(LEASE_SECONDS);
    expect(got.run.leaseExpiresAt).not.toBeNull();
    expect(await (await call("GET", `/runs/${first.id}`, TOKEN)).json()).toMatchObject({ state: "running", host: h.host.id });

    // A run submitted without memory is admitted at 1024 MiB.
    expect((await claim(h, { slots: 1, memory: 1023 })).status).toBe(204);
    expect(((await (await claim(h, { slots: 1, memory: 1024 })).json()) as Claim).run.id).toBe(second.id);
    expect((await claim(h, { slots: 0, memory: 8192 })).status).toBe(204);
    expect(((await (await claim(h, { slots: 1, memory: 8192 })).json()) as Claim).run.id).toBe(big.id);
    // Nothing left this host can run: the others need macOS and arm.
    expect((await claim(h, { slots: 1, memory: 8192 })).status).toBe(204);
    const m1 = await register({ os: "macos", arch: "aarch64" });
    expect(((await (await claim(m1)).json()) as Claim).run.id).toBe(mac.id);
    expect(((await (await claim(m1)).json()) as Claim).run.id).toBe(arm.id);
  });

  it("records what the host has free", async () => {
    const { register, claim, hosts } = setup();
    const h = await register();
    await claim(h, { slots: 1, memory: 900 });
    expect((await hosts())[0]!.free).toEqual({ slots: 1, memory: 900 });
  });

  it("never gives two concurrent claims the same run", async () => {
    const { register, submit, claim } = setup();
    const many = await Promise.all(Array.from({ length: 6 }, () => register()));
    const runs = await Promise.all(Array.from({ length: 3 }, () => submit()));
    const results = await Promise.all(many.map((h) => claim(h)));
    const claimed = await Promise.all(results.filter((res) => res.status === 200).map(async (res) => ((await res.json()) as Claim).run.id));
    expect(results.filter((res) => res.status === 204)).toHaveLength(3);
    expect(claimed.sort()).toEqual(runs.map((r) => r.id).sort());
  });

  it("does not claim a canceled run", async () => {
    const { register, submit, claim, call } = setup();
    const h = await register();
    const run = await submit();
    await call("POST", `/runs/${run.id}/cancel`, TOKEN);
    expect((await claim(h)).status).toBe(204);
  });
});

describe("SendHeartbeat", () => {
  it("records free capacity and metrics, and renews the leases of the host's running runs only", async () => {
    const { store, register, submit, claim, heartbeat, hosts } = setup();
    const h = await register();
    const other = await register();
    await submit();
    await submit();
    // Read from the claims: two runs submitted in one millisecond have no order between them.
    const mine = ((await (await claim(h)).json()) as Claim).run;
    const theirs = ((await (await claim(other)).json()) as Claim).run;
    const old = "2000-01-01T00:00:00.000Z";
    for (const id of [mine.id, theirs.id]) force(store, { ...store.run(id)!, leaseExpiresAt: old });
    const res = await heartbeat(h, [mine.id, theirs.id], { slots: 0, memory: 1024 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancel: [], lease: LEASE_SECONDS });
    expect(store.run(mine.id)!.leaseExpiresAt! > new Date().toISOString()).toBe(true);
    expect(store.run(theirs.id)!.leaseExpiresAt).toBe(old);
    expect((await hosts()).find((each) => each.id === h.host.id)).toMatchObject({ free: { slots: 0, memory: 1024 }, metrics: METRICS });
  });

  it("answers which of its runs to cancel, which stay running until it completes them", async () => {
    const { register, submit, claim, heartbeat, call, complete } = setup();
    const h = await register();
    const run = await submit();
    const keep = await submit();
    await claim(h);
    await claim(h);
    expect(await (await call("POST", `/runs/${run.id}/cancel`, TOKEN)).json()).toMatchObject({ state: "running", cancelRequested: true });
    expect(await (await heartbeat(h, [run.id, keep.id])).json()).toMatchObject({ cancel: [run.id] });
    expect(await (await complete(run.id, h.token, { state: "canceled", exit: 143 })).json()).toMatchObject({ state: "canceled", reason: "canceled while running" });
    expect(await (await heartbeat(h, [run.id, keep.id])).json()).toMatchObject({ cancel: [] });
  });

  it("refuses metrics that are missing", async () => {
    const { register, call } = setup();
    const h = await register();
    expect((await call("POST", `/hosts/${h.host.id}/heartbeat`, h.token, { free: { slots: 1, memory: 1 }, running: [] })).status).toBe(400);
  });
});

describe("AppendRunLog", () => {
  async function running() {
    const s = setup();
    const h = await s.register();
    const run = await s.submit();
    await s.claim(h);
    return { ...s, h, run };
  }

  it("lands each append at its offset, readable while the run runs", async () => {
    const { h, run, append, call } = await running();
    const one = await append(run.id, h.token, "hello ", 0);
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({ size: 6 });
    expect(await (await append(run.id, h.token, "world\n", 6)).json()).toEqual({ size: 12 });
    const log = await call("GET", `/runs/${run.id}/log`, TOKEN);
    expect(await log.text()).toBe("hello world\n");
    expect(log.headers.get("run-state")).toBe("running");
  });

  it("refuses an append that would leave a gap or overlap, saying where to resend from", async () => {
    const { h, run, append } = await running();
    await append(run.id, h.token, "abc", 0);
    for (const start of [5, 1]) {
      const res = await append(run.id, h.token, "x", start);
      expect(res.status).toBe(416);
      expect(await res.json()).toMatchObject({ code: "InvalidRangeException", size: 3 });
    }
  });

  it("refuses a body without Content-Range, or one whose length is not the range's", async () => {
    const { h, run, call } = await running();
    const bytes = new TextEncoder().encode("abc");
    expect((await call("PATCH", `/runs/${run.id}/log`, h.token, bytes, { "content-type": "application/octet-stream" })).status).toBe(400);
    expect((await call("PATCH", `/runs/${run.id}/log`, h.token, bytes, { "content-type": "application/octet-stream", "content-range": "bytes 0-9/*" })).status).toBe(400);
  });

  it("does not renew the lease: only a heartbeat does", async () => {
    const { h, run, append, store } = await running();
    const old = "2000-01-01T00:00:00.000Z";
    force(store, { ...store.run(run.id)!, leaseExpiresAt: old });
    expect((await append(run.id, h.token, "x", 0)).status).toBe(200);
    expect(store.run(run.id)!.leaseExpiresAt).toBe(old);
  });

  it("refuses an append over 256 KiB", async () => {
    const { h, run, append } = await running();
    expect((await append(run.id, h.token, "x".repeat(256 * 1024 + 1), 0)).status).toBe(413);
  });

  it("refuses an append once the run has ended", async () => {
    const { h, run, append, complete } = await running();
    await complete(run.id, h.token, { state: "succeeded", exit: 0 });
    expect((await append(run.id, h.token, "x", 0)).status).toBe(409);
  });
});

describe("CompleteRun", () => {
  it("records how the run ended, from its own host", async () => {
    const { register, submit, claim, complete, call } = setup();
    const h = await register();
    const ok = await submit();
    const bad = await submit();
    for (let i = 0; i < 2; i++) await claim(h, { slots: 1, memory: 8192 });
    const res = await complete(ok.id, h.token, { state: "succeeded", exit: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "succeeded", exit: 0, duration: 1.5, leaseExpiresAt: null });
    expect(await (await complete(bad.id, h.token, { state: "failed", exit: null, reason: "timed out after 60s" })).json()).toMatchObject({
      state: "failed",
      exit: null,
      reason: "timed out after 60s",
    });
    expect(((await (await call("GET", `/runs/${ok.id}`, TOKEN)).json()) as Run).endedAt).not.toBeNull();
  });

  it("answers the same end again unchanged, and refuses a different one", async () => {
    const { register, submit, claim, complete } = setup();
    const h = await register();
    const run = await submit();
    await claim(h);
    const first = await (await complete(run.id, h.token, { state: "succeeded", exit: 0 })).json();
    const again = await complete(run.id, h.token, { state: "succeeded", exit: 0 });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect((await complete(run.id, h.token, { state: "failed", exit: 1 })).status).toBe(409);
  });

  it("refuses a pending run, and a state that is not an end", async () => {
    const { register, submit, complete } = setup();
    const h = await register();
    const run = await submit();
    expect((await complete(run.id, h.token, { state: "succeeded", exit: 0 })).status).toBe(403);
    expect((await complete(run.id, h.token, { state: "running", exit: 0 })).status).toBe(400);
  });
});

describe("the lease", () => {
  it("fails a running run its host stopped sending heartbeats for, saying so", async () => {
    const { store, register, submit, claim, heartbeat, append, call } = setup();
    const h = await register();
    const run = await submit();
    const fresh = await submit();
    await claim(h);
    await claim(h);
    await heartbeat(h, [fresh.id]);
    force(store, { ...store.run(run.id)!, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await sweep(store)).toBe(1);
    const failed = (await (await call("GET", `/runs/${run.id}`, TOKEN)).json()) as Run;
    expect(failed).toMatchObject({ state: "failed", leaseExpiresAt: null });
    expect(failed.reason).toMatch(/^lease lapsed: no heartbeat from host .+ since /);
    expect(await (await call("GET", `/runs/${fresh.id}`, TOKEN)).json()).toMatchObject({ state: "running" });
    expect((await append(run.id, h.token, "late", 0)).status).toBe(409);
    expect(await sweep(store, new Date(Date.now() + (LEASE_SECONDS + 1) * 1000).toISOString())).toBe(1);
  });

  it("leaves a run that is not running alone", () => {
    const run = { state: "pending", leaseExpiresAt: null, updatedAt: "2026-01-01T00:00:00.000Z" } as unknown as Run;
    expect(lapsed(run)).toBeNull();
  });
});

describe("a database from before hosts", () => {
  it("opens with its runs' limits, for and submitter as requirements and labels, and its runners as hosts", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, state TEXT NOT NULL, repo TEXT NOT NULL COLLATE NOCASE, submitted_by TEXT, for_key TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record TEXT NOT NULL);
      CREATE INDEX runs_by_for ON runs (for_key, created_at) WHERE for_key IS NOT NULL;
      CREATE TABLE run_logs (run_id TEXT NOT NULL, start INTEGER NOT NULL, data BLOB NOT NULL, written_at TEXT NOT NULL, PRIMARY KEY (run_id, start));
      CREATE TABLE runners (id TEXT PRIMARY KEY, record TEXT NOT NULL);`);
    const at = "2026-11-12T00:00:00.000Z";
    const old = {
      id: "11111111-1111-4111-8111-111111111111",
      repo: "dakotacolorado/python-template",
      commit: COMMIT,
      job: "hello",
      routine: null,
      host: null,
      args: [],
      limits: { memory: 256, timeout: null },
      labels: {},
      for: { kind: "worker", id: "job-service-check" },
      state: "succeeded",
      reason: null,
      cancelRequested: false,
      runner: "22222222-2222-4222-8222-222222222222",
      runsWith: { memory: 256, timeout: 60, stall: 600 },
      exit: 0,
      duration: 2,
      logSize: 0,
      submittedBy: "job-service-check",
      createdAt: at,
      updatedAt: at,
      startedAt: at,
      endedAt: at,
      leaseExpiresAt: null,
    };
    db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(old.id, old.state, old.repo, old.submittedBy, "worker:job-service-check", at, at, JSON.stringify(old));
    const runner = { id: old.runner, name: "dakotas-hp-laptop-local", labels: {}, slots: 2, memory: 4096, version: "87a0b47", hostId: "dakotas-hp-laptop", createdAt: at, lastSeenAt: at, tokenHash: "ab" };
    db.prepare("INSERT INTO runners VALUES (?, ?)").run(runner.id, JSON.stringify(runner));

    const store = new Store(db);
    const run = store.run(old.id)!;
    expect(run).toMatchObject({
      requirements: { os: null, arch: null, memory: 256, timeout: null },
      labels: { worker: "job-service-check", by: "job-service-check" },
      host: runner.id,
    });
    for (const gone of ["limits", "for", "routine", "runsWith", "submittedBy", "runner"]) expect(run).not.toHaveProperty(gone);
    expect(store.runs({ labels: [["worker", "job-service-check"]], limit: 10 }).map((r) => r.id)).toEqual([old.id]);
    expect(store.hosts()).toEqual([
      { ...runner, name: "dakotas-hp-laptop", os: "linux", arch: "x86_64", free: null, metrics: null, hostId: undefined, ...{} },
    ].map(({ hostId: _, ...h }) => h));
    // Opening it again changes nothing.
    expect(new Store(db).run(old.id)).toEqual(run);
  });
});
