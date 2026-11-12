import { describe, expect, it } from "vitest";

/**
 * Against a deployed stage: beta only, since it submits and cancels a run of its own.
 * Skipped without INTEGRATION_JS_URL/INTEGRATION_JS_TOKEN; how to run it is the test skill.
 */
const url = process.env.INTEGRATION_JS_URL;
const token = process.env.INTEGRATION_JS_TOKEN;

const call = (method: string, path: string, body?: unknown, auth = `Bearer ${token}`) =>
  fetch(`${url}${path}`, {
    method,
    headers: { authorization: auth, "claimed-by": "job-service-integration", ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe.skipIf(!url || !token)("job-service as deployed", () => {
  it("answers /health without a token, and refuses /runs with a wrong one", async () => {
    expect((await call("GET", "/health", undefined, "")).status).toBe(200);
    expect((await call("GET", "/runs", undefined, "Bearer wrong")).status).toBe(401);
  });

  it("refuses a malformed job", async () => {
    expect((await call("POST", "/runs", { repo: "nope", commit: "abc", job: "hello" })).status).toBe(400);
  });

  it("submits, shows, lists, reads the log of and cancels a job", async () => {
    // A label no runner has, so no runner claims it before it is canceled.
    const draft = { repo: "dakotacolorado/python-template", commit: "0".repeat(40), job: "hello", labels: { integration: "never-claimed" } };
    const res = await call("POST", "/runs", draft);
    expect(res.status).toBe(201);
    const job = (await res.json()) as { id: string; state: string };
    expect(job.state).toBe("pending");

    expect(await (await call("GET", `/runs/${job.id}`)).json()).toMatchObject({ id: job.id, state: "pending" });
    const pending = (await (await call("GET", "/runs?state=pending")).json()) as { runs: { id: string }[] };
    expect(pending.runs.map((j) => j.id)).toContain(job.id);

    const log = await call("GET", `/runs/${job.id}/log`);
    expect(log.status).toBe(206);
    expect(await log.text()).toBe("");

    const canceled = await call("POST", `/runs/${job.id}/cancel`);
    expect(await canceled.json()).toMatchObject({ state: "canceled", cancelRequested: true });
    expect((await call("POST", `/runs/${job.id}/cancel`)).status).toBe(409);
  });
});

const registration = process.env.INTEGRATION_JS_RUNNER_TOKEN;

describe.skipIf(!url || !token || !registration)("job-service's runner API as deployed", () => {
  it("registers, claims its own job, appends, is told of a cancel, and reports", async () => {
    const run = crypto.randomUUID();
    const reg = await call("POST", "/runners", { name: "job-service-integration", slots: 1, memory: 16, labels: { integration: run } }, `Bearer ${registration}`);
    expect(reg.status).toBe(201);
    const { runner, token: own } = (await reg.json()) as { runner: { id: string }; token: string };
    expect((await call("POST", `/runners/${runner.id}/claim`, { free: { slots: 1, memory: 16 } }, `Bearer ${token}`)).status).toBe(401);

    // 16 MiB and a label of this run's own: no other job on the stage fits this claim.
    const job = (await (await call("POST", "/runs", { repo: "dakotacolorado/python-template", commit: "0".repeat(40), job: "hello", limits: { memory: 16 }, labels: { integration: run } })).json()) as { id: string };
    const claim = await call("POST", `/runners/${runner.id}/claim`, { free: { slots: 1, memory: 16 } }, `Bearer ${own}`);
    expect(claim.status).toBe(200);
    expect(((await claim.json()) as { run: { id: string } }).run.id).toBe(job.id);

    const append = (text: string, start: number) =>
      fetch(`${url}/runs/${job.id}/log`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${own}`, "content-type": "application/octet-stream", "content-range": `bytes ${start}-${start + text.length - 1}/*` },
        body: text,
      });
    expect(await (await append("hello\n", 0)).json()).toMatchObject({ size: 6, canceled: false });
    expect((await append("gap", 9)).status).toBe(416);
    expect(await (await call("GET", `/runs/${job.id}/log`)).text()).toBe("hello\n");

    await call("POST", `/runs/${job.id}/cancel`);
    expect(await (await append("bye\n", 6)).json()).toMatchObject({ size: 10, canceled: true });
    const put = await fetch(`${url}/runs/${job.id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${own}`, "content-type": "application/json" },
      body: JSON.stringify({ state: "canceled", exit: 143, duration: 1 }),
    });
    expect(await put.json()).toMatchObject({ state: "canceled", exit: 143, logSize: 10 });
  });
});
