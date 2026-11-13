import { describe, expect, it } from "vitest";
import { JobApi } from "./api.ts";
import { LEASE_SECONDS, lapsed, type Run, type Runner } from "./domain.ts";
import { Store } from "./store.ts";
import { sweep } from "./sweep.ts";

const TOKEN = "submitter";
const REGISTRATION = "registration";
const COMMIT = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const ABOUT = { version: "0.1.0", commit: "x" };

/** Writes `run` over what is stored, as no API call would: to put a run in a state a test needs. */
function force(store: Store, run: Run) {
  store.db.prepare("UPDATE runs SET state = ?, updated_at = ?, record = ? WHERE id = ?").run(run.state, run.updatedAt, JSON.stringify(run), run.id);
}

type Claim = { run: Run; memory: number; lease: number };

function setup() {
  const store = Store.open(":memory:");
  const api = new JobApi(store, { submitter: TOKEN, registration: REGISTRATION }, ABOUT);
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
    const res = await call("POST", "/runners", REGISTRATION, { name: "host", slots: 2, memory: 3072, labels: { arch: "x86_64" }, ...over });
    expect(res.status).toBe(201);
    return (await res.json()) as { runner: Runner; token: string };
  };
  const claim = (r: { runner: Runner; token: string }, free = { slots: 1, memory: 2048 }, labels?: Record<string, string>, can?: string[]) =>
    call("POST", `/runners/${r.runner.id}/claim`, r.token, { free, ...(labels && { labels }), ...(can && { can }) });
  const append = (id: string, token: string, text: string, start: number) => {
    const bytes = new TextEncoder().encode(text);
    return call("PATCH", `/runs/${id}/log`, token, bytes, {
      "content-type": "application/octet-stream",
      ...(bytes.length && { "content-range": `bytes ${start}-${start + bytes.length - 1}/*` }),
    });
  };
  const report = (id: string, token: string, body: Record<string, unknown>) => call("PUT", `/runs/${id}`, token, { duration: 1.5, ...body });
  return { store, call, submit, register, claim, append, report };
}

describe("POST /runners", () => {
  it("registers with the registration token and answers a token of the runner's own", async () => {
    const { register, call } = setup();
    const { runner, token } = await register();
    expect(runner).toMatchObject({ name: "host", slots: 2, memory: 3072, labels: { arch: "x86_64" }, version: null });
    expect(runner).not.toHaveProperty("tokenHash");
    expect(token.startsWith(`${runner.id}.`)).toBe(true);
    const listed = (await (await call("GET", "/runners", TOKEN)).json()) as { runners: Runner[] };
    expect(listed.runners.map((r) => r.id)).toEqual([runner.id]);
  });

  it("refuses the submitter token, and a runner token cannot list or submit", async () => {
    const { call, register } = setup();
    expect((await call("POST", "/runners", TOKEN, { name: "h", slots: 1, memory: 512 })).status).toBe(401);
    const { token } = await register();
    expect((await call("GET", "/runners", token)).status).toBe(401);
    expect((await call("POST", "/runs", token, { repo: "a/b", commit: COMMIT, job: "hello" })).status).toBe(401);
  });

  it("records the host it says it is on, and null when it does not say", async () => {
    const { register } = setup();
    expect((await register({ hostId: "studio" })).runner.hostId).toBe("studio");
    expect((await register()).runner.hostId).toBeNull();
  });

  it("refuses a runner without slots", async () => {
    const { call } = setup();
    expect((await call("POST", "/runners", REGISTRATION, { name: "h", slots: 0, memory: 512 })).status).toBe(400);
  });
});

describe("runner auth", () => {
  it("refuses the submitter token, a bad secret and another runner's token", async () => {
    const { register, submit, claim, call, append, report } = setup();
    const a = await register();
    const b = await register();
    const job = await submit();
    expect((await call("POST", `/runners/${a.runner.id}/claim`, TOKEN, { free: { slots: 1, memory: 2048 } })).status).toBe(401);
    expect((await call("POST", `/runners/${a.runner.id}/claim`, `${a.runner.id}.wrong`, { free: { slots: 1, memory: 2048 } })).status).toBe(401);
    expect((await call("POST", `/runners/${a.runner.id}/claim`, b.token, { free: { slots: 1, memory: 2048 } })).status).toBe(403);
    expect((await claim(a)).status).toBe(200);
    expect((await append(job.id, TOKEN, "x", 0)).status).toBe(401);
    expect((await append(job.id, b.token, "x", 0)).status).toBe(403);
    expect((await report(job.id, b.token, { state: "succeeded", exit: 0 })).status).toBe(403);
    expect((await report(job.id, TOKEN, { state: "succeeded", exit: 0 })).status).toBe(401);
  });
});

describe("POST /runners/{id}/claim", () => {
  it("records the host a claim says, so a runner registered before it said keeps its id", async () => {
    const { register, call } = setup();
    const r = await register();
    const runners = async () => ((await (await call("GET", "/runners", TOKEN)).json()) as { runners: Runner[] }).runners;
    expect((await call("POST", `/runners/${r.runner.id}/claim`, r.token, { free: { slots: 1, memory: 2048 } })).status).toBe(204);
    expect((await runners())[0]!.hostId).toBeNull();
    expect((await call("POST", `/runners/${r.runner.id}/claim`, r.token, { free: { slots: 1, memory: 2048 }, hostId: "studio" })).status).toBe(204);
    expect(await runners()).toMatchObject([{ id: r.runner.id, hostId: "studio" }]);
    expect((await call("POST", `/runners/${r.runner.id}/claim`, r.token, { free: { slots: 1, memory: 2048 } })).status).toBe(204);
    expect((await runners())[0]!.hostId).toBe("studio");
  });

  it("answers the oldest pending job that fits, now running on that runner", async () => {
    const { register, submit, claim, call } = setup();
    const r = await register();
    const tick = () => new Promise((res) => setTimeout(res, 3));
    const big = await submit({ limits: { memory: 4096 } });
    await tick();
    const gpu = await submit({ labels: { gpu: "true" } });
    await tick();
    const first = await submit({ limits: { memory: 256 } });
    await tick();
    const second = await submit();

    const res = await claim(r);
    expect(res.status).toBe(200);
    const got = (await res.json()) as Claim;
    expect(got.run).toMatchObject({ id: first.id, state: "running", runner: r.runner.id });
    expect(got.memory).toBe(256);
    expect(got.lease).toBe(LEASE_SECONDS);
    expect(got.run.leaseExpiresAt).not.toBeNull();
    expect(await (await call("GET", `/runs/${first.id}`, TOKEN)).json()).toMatchObject({ state: "running", runner: r.runner.id });

    // A job submitted without memory is admitted at 1024 MiB.
    expect((await claim(r, { slots: 1, memory: 1023 })).status).toBe(204);
    expect(((await (await claim(r, { slots: 1, memory: 1024 })).json()) as Claim).run.id).toBe(second.id);

    expect((await claim(r, { slots: 0, memory: 8192 })).status).toBe(204);
    expect((await claim(r)).status).toBe(204);
    expect(((await (await claim(r, { slots: 1, memory: 8192 })).json()) as Claim).run.id).toBe(big.id);
    expect(((await (await claim(r, { slots: 1, memory: 8192 }, { gpu: "true" })).json()) as Claim).run.id).toBe(gpu.id);
  });

  it("never gives two concurrent claims the same job", async () => {
    const { register, submit, claim } = setup();
    const runners = await Promise.all(Array.from({ length: 6 }, () => register()));
    const jobs = await Promise.all(Array.from({ length: 3 }, () => submit()));
    const results = await Promise.all(runners.map((r) => claim(r)));
    const claimed = await Promise.all(results.filter((res) => res.status === 200).map(async (res) => ((await res.json()) as Claim).run.id));
    expect(results.filter((res) => res.status === 204)).toHaveLength(3);
    expect(claimed.sort()).toEqual(jobs.map((j) => j.id).sort());
  });

  it("leaves a routine job to a runner that says it can run one, and gives it the routine", async () => {
    const { register, submit, claim } = setup();
    const r = await register();
    const routine = { repo: "dakotacolorado/release-routines", commit: COMMIT, dir: "dakotacolorado/python-template" };
    const job = await submit({ routine });
    expect((await claim(r)).status).toBe(204);
    expect((await claim(r, undefined, undefined, [])).status).toBe(204);
    const got = (await (await claim(r, undefined, undefined, ["routine"])).json()) as Claim;
    expect(got.run).toMatchObject({ id: job.id, routine, repo: "dakotacolorado/python-template" });
  });

  it("gives a runner that can run routines a job in today's shape too", async () => {
    const { register, submit, claim } = setup();
    const job = await submit();
    expect(((await (await claim(await register(), undefined, undefined, ["routine"])).json()) as Claim).run).toMatchObject({ id: job.id, routine: null });
  });

  it("gives a job naming a host only to that host's runner, and only when it can run host jobs", async () => {
    const { register, submit, claim, call } = setup();
    const laptop = await register({ hostId: "laptop" });
    const studio = await register({ hostId: "studio" });
    const job = await submit({ host: "laptop" });
    expect((await claim(studio, undefined, undefined, ["host"])).status).toBe(204);
    expect((await claim(laptop)).status).toBe(204);
    expect((await claim(laptop, undefined, undefined, ["routine"])).status).toBe(204);
    // A claim that says its host now counts over the one it registered with.
    expect((await call("POST", `/runners/${studio.runner.id}/claim`, studio.token, { free: { slots: 1, memory: 2048 }, can: ["host"], hostId: "laptop" })).status).toBe(200);
    const again = await submit({ host: "laptop" });
    const got = (await (await claim(laptop, undefined, undefined, ["host"])).json()) as Claim;
    expect(got.run).toMatchObject({ id: again.id, host: "laptop" });
    expect(job.host).toBe("laptop");
  });

  it("refuses a capability it does not know", async () => {
    const { register, claim } = setup();
    expect((await claim(await register(), undefined, undefined, ["teleport"])).status).toBe(400);
  });

  it("does not claim a canceled job", async () => {
    const { register, submit, claim, call } = setup();
    const r = await register();
    const job = await submit();
    await call("POST", `/runs/${job.id}/cancel`, TOKEN);
    expect((await claim(r)).status).toBe(204);
  });
});

describe("PATCH /runs/{id}/log", () => {
  async function running() {
    const s = setup();
    const r = await s.register();
    const job = await s.submit();
    await s.claim(r);
    return { ...s, r, job };
  }

  it("lands each append at its offset, readable while the job runs", async () => {
    const { r, job, append, call } = await running();
    const one = await append(job.id, r.token, "hello ", 0);
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ size: 6, canceled: false });
    expect(await (await append(job.id, r.token, "world\n", 6)).json()).toMatchObject({ size: 12 });
    const log = await call("GET", `/runs/${job.id}/log`, TOKEN);
    expect(await log.text()).toBe("hello world\n");
    expect(log.headers.get("run-state")).toBe("running");
  });

  it("refuses an append that would leave a gap or overlap, saying where to resend from", async () => {
    const { r, job, append } = await running();
    await append(job.id, r.token, "abc", 0);
    for (const start of [5, 1]) {
      const res = await append(job.id, r.token, "x", start);
      expect(res.status).toBe(416);
      expect(await res.json()).toMatchObject({ size: 3 });
    }
  });

  it("refuses a body without Content-Range, or one whose length is not the range's", async () => {
    const { r, job, call } = await running();
    const bytes = new TextEncoder().encode("abc");
    expect((await call("PATCH", `/runs/${job.id}/log`, r.token, bytes, { "content-type": "application/octet-stream" })).status).toBe(400);
    expect((await call("PATCH", `/runs/${job.id}/log`, r.token, bytes, { "content-type": "application/octet-stream", "content-range": "bytes 0-9/*" })).status).toBe(400);
  });

  it("renews the lease with an empty append", async () => {
    const { r, job, append, store } = await running();
    force(store, { ...store.run(job.id)!, leaseExpiresAt: "2000-01-01T00:00:00.000Z" });
    const res = await append(job.id, r.token, "", 0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { leaseExpiresAt: string; size: number };
    expect(body.size).toBe(0);
    expect(body.leaseExpiresAt > new Date().toISOString()).toBe(true);
  });

  it("says when the job was canceled, and the job stays running until its runner reports", async () => {
    const { r, job, append, call } = await running();
    expect(await (await call("POST", `/runs/${job.id}/cancel`, TOKEN)).json()).toMatchObject({ state: "running", cancelRequested: true });
    expect(await (await append(job.id, r.token, "x", 0)).json()).toMatchObject({ canceled: true });
  });

  it("refuses an append over 256 KiB", async () => {
    const { r, job, append } = await running();
    expect((await append(job.id, r.token, "x".repeat(256 * 1024 + 1), 0)).status).toBe(413);
  });

  it("refuses an append once the job has ended", async () => {
    const { r, job, append, report } = await running();
    await report(job.id, r.token, { state: "succeeded", exit: 0 });
    expect((await append(job.id, r.token, "x", 0)).status).toBe(409);
  });
});

describe("PUT /runs/{id}/runs-with", () => {
  const RUNS_WITH = { memory: 1024, timeout: 1800, stall: 300 };

  it("records what the job runs with, from its own runner, for a submitter to read, and keeps it once it ends", async () => {
    const { register, submit, claim, append, report, call } = setup();
    const r = await register();
    const job = await submit();
    await claim(r);
    expect((await append(job.id, r.token, "started\n", 0)).status).toBe(200);
    const res = await call("PUT", `/runs/${job.id}/runs-with`, r.token, RUNS_WITH);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "running", limits: { memory: null, timeout: null }, runsWith: RUNS_WITH, logSize: 8 });
    expect(await (await call("GET", `/runs/${job.id}`, TOKEN)).json()).toMatchObject({ runsWith: RUNS_WITH });
    expect((await append(job.id, r.token, "more\n", 8)).status).toBe(200);
    await report(job.id, r.token, { state: "succeeded", exit: 0 });
    expect(await (await call("GET", `/runs/${job.id}`, TOKEN)).json()).toMatchObject({ state: "succeeded", runsWith: RUNS_WITH });
  });

  it("takes a null stall, for a job that is never ended as stalled", async () => {
    const { register, submit, claim, call } = setup();
    const r = await register();
    const job = await submit();
    await claim(r);
    const res = await call("PUT", `/runs/${job.id}/runs-with`, r.token, { ...RUNS_WITH, stall: null });
    expect(await res.json()).toMatchObject({ runsWith: { ...RUNS_WITH, stall: null } });
  });

  it("refuses another runner, a submitter, a job not running, and a limit missing", async () => {
    const { register, submit, claim, report, call } = setup();
    const a = await register();
    const b = await register();
    const pending = await submit();
    expect((await call("PUT", `/runs/${pending.id}/runs-with`, a.token, RUNS_WITH)).status).toBe(403);
    await claim(a);
    expect((await call("PUT", `/runs/${pending.id}/runs-with`, b.token, RUNS_WITH)).status).toBe(403);
    expect((await call("PUT", `/runs/${pending.id}/runs-with`, TOKEN, RUNS_WITH)).status).toBe(401);
    expect((await call("PUT", `/runs/${pending.id}/runs-with`, a.token, { memory: 1024, timeout: 1800 })).status).toBe(400);
    await report(pending.id, a.token, { state: "succeeded", exit: 0 });
    expect((await call("PUT", `/runs/${pending.id}/runs-with`, a.token, RUNS_WITH)).status).toBe(409);
  });
});

describe("PUT /runs/{id}", () => {
  it("records how the job ended, from its own runner", async () => {
    const { register, submit, claim, report, call } = setup();
    const r = await register();
    const ok = await submit();
    const bad = await submit();
    const stopped = await submit();
    for (let i = 0; i < 3; i++) await claim(r, { slots: 1, memory: 8192 });
    const res = await report(ok.id, r.token, { state: "succeeded", exit: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "succeeded", exit: 0, duration: 1.5, leaseExpiresAt: null });
    expect(await (await report(bad.id, r.token, { state: "failed", exit: null, reason: "timed out after 60s" })).json()).toMatchObject({
      state: "failed",
      exit: null,
      reason: "timed out after 60s",
    });
    await call("POST", `/runs/${stopped.id}/cancel`, TOKEN);
    expect(await (await report(stopped.id, r.token, { state: "canceled", exit: 143 })).json()).toMatchObject({
      state: "canceled",
      exit: 143,
      reason: "canceled while running",
    });
    const read = (await (await call("GET", `/runs/${ok.id}`, TOKEN)).json()) as Run;
    expect(read.endedAt).not.toBeNull();
  });

  it("answers the same end again unchanged, and refuses a different one", async () => {
    const { register, submit, claim, report } = setup();
    const r = await register();
    const job = await submit();
    await claim(r);
    const first = await (await report(job.id, r.token, { state: "succeeded", exit: 0 })).json();
    const again = await report(job.id, r.token, { state: "succeeded", exit: 0 });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect((await report(job.id, r.token, { state: "failed", exit: 1 })).status).toBe(409);
  });

  it("refuses a pending job, and a state that is not an end", async () => {
    const { register, submit, report } = setup();
    const r = await register();
    const job = await submit();
    expect((await report(job.id, r.token, { state: "succeeded", exit: 0 })).status).toBe(403);
    expect((await report(job.id, r.token, { state: "running", exit: 0 })).status).toBe(400);
  });
});

describe("the lease", () => {
  it("fails a running job with no append for its lease, saying so", async () => {
    const { store, register, submit, claim, append, call } = setup();
    const r = await register();
    const job = await submit();
    const fresh = await submit();
    await claim(r);
    await claim(r);
    const past = new Date(Date.now() + (LEASE_SECONDS + 1) * 1000).toISOString();
    // `fresh` was renewed just now, so a sweep at its claim time leaves it running.
    await append(fresh.id, r.token, "", 0);
    force(store, { ...store.run(job.id)!, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await sweep(store)).toBe(1);
    const failed = (await (await call("GET", `/runs/${job.id}`, TOKEN)).json()) as Run;
    expect(failed).toMatchObject({ state: "failed", leaseExpiresAt: null });
    expect(failed.reason).toMatch(/^lease lapsed: no log append from runner .+ since /);
    expect(await (await call("GET", `/runs/${fresh.id}`, TOKEN)).json()).toMatchObject({ state: "running" });
    expect((await append(job.id, r.token, "late", 0)).status).toBe(409);
    expect(await sweep(store, past)).toBe(1);
  });

  it("leaves a job that is not running alone", () => {
    const job = { state: "pending", leaseExpiresAt: null, updatedAt: "2026-01-01T00:00:00.000Z" } as unknown as Run;
    expect(lapsed(job)).toBeNull();
  });
});
