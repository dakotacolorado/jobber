import { describe, expect, it } from "vitest";
import WebSocket from "ws";

/**
 * Against a running instance you started yourself, never a production one, since it submits and cancels a run of its own.
 * Skipped without INTEGRATION_JS_URL/INTEGRATION_JS_TOKEN; how to run it is the test skill.
 */
const url = process.env.INTEGRATION_JS_URL;
const token = process.env.INTEGRATION_JS_TOKEN;

const call = (method: string, path: string, body?: unknown, auth = `Bearer ${token}`) =>
  fetch(`${url}${path}`, {
    method,
    headers: { authorization: auth, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe.skipIf(!url || !token)("jobber as deployed", () => {
  it("answers /health without a token, and refuses /runs with a wrong one", async () => {
    expect((await call("GET", "/health", undefined, "")).status).toBe(200);
    expect((await call("GET", "/runs", undefined, "Bearer wrong")).status).toBe(401);
  });

  it("refuses a malformed job", async () => {
    expect((await call("POST", "/runs", { repo: "nope", commit: "abc", job: "hello" })).status).toBe(400);
  });

  it("submits, shows, lists, reads the log of and cancels a job", async () => {
    // An os no host in the fleet has, so none claims it before it is canceled.
    const draft = { repo: "dakotacolorado/python-template", commit: "0".repeat(40), job: "hello", requirements: { os: "windows" }, labels: { by: "jobber-integration" } };
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

describe.skipIf(!url || !token || !registration)("jobber's host API as deployed", () => {
  it("registers, connects, is pushed its own run, appends, is pushed a cancel, and completes", async () => {
    const name = `jobber-integration-${crypto.randomUUID().slice(0, 8)}`;
    // A Windows host: no real one is, so only this test's run, which asks for Windows, is placed on it.
    const reg = await call("POST", "/hosts", { name, os: "windows", arch: "x86_64", capacity: { cpu: 1, memory: 16, gpu: 0, gpuMemory: 0 } }, `Bearer ${registration}`);
    expect(reg.status).toBe(201);
    const { host, token: own } = (await reg.json()) as { host: { id: string }; token: string };
    const ws = `${url!.replace(/^http/, "ws")}/hosts/${host.id}/connect`;
    const refused = new WebSocket(ws, { headers: { authorization: `Bearer ${token}` } });
    expect(await new Promise((done) => refused.once("unexpected-response", (_, res) => done(res.statusCode)))).toBe(401);

    const socket = new WebSocket(ws, { headers: { authorization: `Bearer ${own}` } });
    const got: { type: string; run?: { id: string } | string; attempt?: number }[] = [];
    let wake = () => {};
    socket.on("message", (data) => {
      got.push(JSON.parse(data.toString()));
      wake();
    });
    const next = async (type: string) => {
      for (;;) {
        const found = got.find((m) => m.type === type);
        if (found) return found;
        await new Promise<void>((w) => (wake = w));
      }
    };
    await new Promise((open) => socket.once("open", open));
    socket.send(JSON.stringify({ type: "heartbeat", free: { cpu: 1, memory: 16, gpu: 0 }, metrics: { cpuLoad: 0, memoryUsed: 0, memoryTotal: 0, diskFree: 50_000, cpus: 0 }, running: [] }));
    await next("heartbeat");

    const job = (await (await call("POST", "/runs", { repo: "dakotacolorado/python-template", commit: "0".repeat(40), job: "hello", requirements: { os: "windows", memory: 16 } })).json()) as { id: string };
    const assign = await next("assign");
    expect((assign.run as { id: string }).id).toBe(job.id);
    socket.send(JSON.stringify({ type: "accept", run: job.id, attempt: 1 }));
    expect(await next("start")).toMatchObject({ run: job.id, attempt: 1 });

    const append = (text: string, start: number) =>
      fetch(`${url}/runs/${job.id}/log?attempt=1`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${own}`, "content-type": "application/octet-stream", "content-range": `bytes ${start}-${start + text.length - 1}/*` },
        body: text,
      });
    expect(await (await append("hello\n", 0)).json()).toEqual({ size: 6 });
    expect((await append("gap", 9)).status).toBe(416);
    expect(await (await call("GET", `/runs/${job.id}/log`)).text()).toBe("hello\n");

    await call("POST", `/runs/${job.id}/cancel`);
    expect(await next("cancel")).toEqual({ type: "cancel", run: job.id, attempt: 1 });
    socket.close();
    const put = await fetch(`${url}/runs/${job.id}?attempt=1`, {
      method: "PUT",
      headers: { authorization: `Bearer ${own}`, "content-type": "application/json" },
      body: JSON.stringify({ state: "canceled", exit: 143, duration: 1 }),
    });
    expect(await put.json()).toMatchObject({ state: "canceled", exit: 143, logSize: 6 });
  });
});
