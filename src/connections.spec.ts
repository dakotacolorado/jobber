import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { JobApi } from "./api.ts";
import { Connections, REPLACED, type ServiceMessage } from "./connections.ts";
import { ASSIGN_SECONDS, type Host, type Run } from "./domain.ts";
import { tick } from "./scheduler.ts";
import { Secrets } from "./secrets.ts";
import { Store } from "./store.ts";

const TOKEN = "submitter";
const REGISTRATION = "registration";
const ADMIN = "admin";
const COMMIT = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const METRICS = { cpuLoad: 0.5, memoryUsed: 2048, memoryTotal: 8192, diskFree: 50_000, cpus: 8 };

const servers: ServerType[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) if (s.readyState === WebSocket.OPEN) s.terminate();
  for (const s of servers.splice(0)) s.close();
});

/** A host's end of the connection: what it was sent, in order, and a way to wait for the next of a type. */
class Peer {
  readonly got: ServiceMessage[] = [];
  private waiting: (() => void)[] = [];
  closed: number | null = null;
  readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => {
      this.got.push(JSON.parse(data.toString()) as ServiceMessage);
      for (const wake of this.waiting.splice(0)) wake();
    });
    socket.on("close", (code) => {
      this.closed = code;
      for (const wake of this.waiting.splice(0)) wake();
    });
  }

  send(message: unknown) {
    this.socket.send(JSON.stringify(message));
  }

  /** The `n`th message of `type` (from 1), once it has come. */
  async next<T extends ServiceMessage["type"]>(type: T, n = 1): Promise<Extract<ServiceMessage, { type: T }>> {
    for (;;) {
      const of = this.got.filter((m) => m.type === type);
      if (of.length >= n) return of[n - 1] as Extract<ServiceMessage, { type: T }>;
      if (this.closed !== null) throw new Error(`closed ${this.closed} before ${type} #${n}`);
      await new Promise<void>((wake) => this.waiting.push(wake));
    }
  }

  heartbeat(running: { id: string; attempt: number }[] = [], free = { cpu: 4, memory: 8192, gpu: 0 }) {
    this.send({ type: "heartbeat", free, metrics: METRICS, running });
  }
}

async function setup() {
  const store = Store.open(":memory:");
  const secrets = new Secrets(store.db, Buffer.alloc(32, 7));
  const connections = new Connections(store, () => {}, secrets);
  const api = new JobApi(store, { submitter: TOKEN, registration: REGISTRATION, admin: ADMIN }, { version: "0", commit: "x" }, connections, secrets);
  const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise((ready) => server.once("listening", ready));
  connections.attach(server as Server, (authorization, id) => api.hostAt(authorization, id));
  const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, auth: string, body?: unknown) =>
    fetch(`http://${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${auth}`, ...(body !== undefined && { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const submit = async (over: Record<string, unknown> = {}) =>
    (await (await call("POST", "/runs", TOKEN, { repo: "o/r", commit: COMMIT, job: "hello", ...over })).json()) as Run;
  const register = async (name: string, features?: string[]) =>
    (await (await call("POST", "/hosts", REGISTRATION, { name, os: "linux", arch: "x86_64", capacity: { cpu: 4, memory: 8192, gpu: 0, gpuMemory: 0 }, features })).json()) as { host: Host; token: string };
  /** Opens host `id`'s connection with `token`; answers the peer, or the HTTP status it was refused with. */
  const connect = (id: string, token: string) =>
    new Promise<Peer | number>((done) => {
      const socket = new WebSocket(`ws://${base}/hosts/${id}/connect`, { headers: { authorization: `Bearer ${token}` } });
      sockets.push(socket);
      socket.on("error", () => {});
      const peer = new Peer(socket);
      socket.on("open", () => done(peer));
      socket.on("unexpected-response", (_, res) => done(res.statusCode!));
    });
  const peer = async (id: string, token: string) => {
    const got = await connect(id, token);
    if (typeof got === "number") throw new Error(`refused ${got}`);
    return got;
  };
  return { store, connections, call, submit, register, connect, peer, schedule: (at?: string) => tick(store, connections, at) };
}

const later = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

describe("a host's connection", () => {
  it("takes only that host's own token, as an upgrade", async () => {
    const { register, connect, call } = await setup();
    const a = await register("a");
    const b = await register("b");
    expect(await connect(a.host.id, TOKEN)).toBe(401);
    expect(await connect(a.host.id, b.token)).toBe(403);
    expect(await connect(a.host.id, a.token)).toBeInstanceOf(Peer);
    const plain = await call("GET", `/hosts/${a.host.id}/connect`, a.token);
    expect(plain.status).toBe(426);
    expect(await plain.json()).toMatchObject({ code: "UpgradeRequiredException" });
  });

  it("gets nothing until its first heartbeat, then its runs pushed, highest priority first; it starts one only on start", async () => {
    const { register, peer, submit, schedule, store, call, connections } = await setup();
    const a = await register("a");
    const host = await peer(a.host.id, a.token);
    const low = await submit();
    const high = await submit({ priority: 10 });
    expect(schedule().placed).toBe(0);

    host.heartbeat();
    expect((await host.next("heartbeat")).lease).toBe(60);
    expect(connections.connected()).toEqual([a.host.id]);
    expect(((await (await call("GET", "/hosts", TOKEN)).json()) as { hosts: { connected: boolean }[] }).hosts[0]!.connected).toBe(true);
    expect(schedule().placed).toBe(2);
    const first = await host.next("assign");
    const second = await host.next("assign", 2);
    expect([first.run.id, second.run.id]).toEqual([high.id, low.id]);
    expect(first).toMatchObject({ attempt: 1, cpu: 0.5, memory: 1024, lease: 60, run: { state: "assigned", host: a.host.id } });
    expect(store.run(high.id)!.state).toBe("assigned");

    host.send({ type: "accept", run: high.id, attempt: 1 });
    expect(await host.next("start")).toEqual({ type: "start", run: high.id, attempt: 1, lease: 60 });
    expect(store.run(high.id)).toMatchObject({ state: "running", host: a.host.id });

    // Its heartbeat renews it on that attempt and on no other.
    host.heartbeat([{ id: high.id, attempt: 1 }]);
    expect(await host.next("heartbeat", 2)).toMatchObject({ cancel: [], ended: [] });
    host.heartbeat([{ id: high.id, attempt: 2 }]);
    expect(await host.next("heartbeat", 3)).toMatchObject({ ended: [high.id] });
  });

  it("resends a waiting assignment when the host reconnects, and runs an accepted one only once", async () => {
    const { register, peer, submit, schedule, store } = await setup();
    const a = await register("a");
    const one = await peer(a.host.id, a.token);
    one.heartbeat();
    await one.next("heartbeat");
    const waiting = await submit();
    const taken = await submit({ priority: 1 });
    schedule();
    await one.next("assign", 2);
    one.send({ type: "accept", run: taken.id, attempt: 1 });
    await one.next("start");

    // The connection drops; the host comes back on a new one.
    const two = await peer(a.host.id, a.token);
    await new Promise((r) => setTimeout(r, 50));
    expect(one.closed).toBe(REPLACED);
    const resent = await two.next("assign");
    expect(resent.run.id).toBe(waiting.id);
    expect(two.got.filter((m) => m.type === "assign")).toHaveLength(1);

    // An accept repeated for a run already running here is answered start, and changes nothing.
    const before = store.run(taken.id)!;
    two.send({ type: "accept", run: taken.id, attempt: 1 });
    await two.next("start");
    expect(store.run(taken.id)).toEqual(before);
    two.send({ type: "accept", run: waiting.id, attempt: 1 });
    expect(await two.next("start", 2)).toMatchObject({ run: waiting.id });
    expect(store.run(waiting.id)!.state).toBe("running");
  });

  it("offers again, on a new connection's first heartbeat, a run started there that the host does not list", async () => {
    const { register, peer, submit, schedule } = await setup();
    const a = await register("a");
    const one = await peer(a.host.id, a.token);
    one.heartbeat();
    await one.next("heartbeat");
    const lost = await submit();
    const kept = await submit({ priority: 1 });
    schedule();
    await one.next("assign", 2);
    one.send({ type: "accept", run: kept.id, attempt: 1 });
    one.send({ type: "accept", run: lost.id, attempt: 1 });
    await one.next("start", 2);

    // The host never read `lost`'s start: it lists only `kept`.
    const two = await peer(a.host.id, a.token);
    two.heartbeat([{ id: kept.id, attempt: 1 }]);
    await two.next("heartbeat");
    const again = await two.next("assign");
    expect(again.run).toMatchObject({ id: lost.id, state: "running" });
    two.send({ type: "accept", run: lost.id, attempt: 1 });
    expect(await two.next("start")).toMatchObject({ run: lost.id, attempt: 1 });
    // Later heartbeats offer nothing more.
    two.heartbeat([{ id: kept.id, attempt: 1 }, { id: lost.id, attempt: 1 }]);
    await two.next("heartbeat", 2);
    expect(two.got.filter((m) => m.type === "assign")).toHaveLength(1);
  });

  it("drops an accept for a run no longer assigned there, and requeues a declined one", async () => {
    const { register, peer, submit, schedule, store, call } = await setup();
    const a = await register("a");
    const host = await peer(a.host.id, a.token);
    host.heartbeat();
    await host.next("heartbeat");
    const canceled = await submit();
    const declined = await submit();
    const expired = await submit();
    schedule();
    await host.next("assign", 3);

    await call("POST", `/runs/${canceled.id}/cancel`, TOKEN);
    host.send({ type: "accept", run: canceled.id, attempt: 1 });
    expect(await host.next("drop")).toMatchObject({ run: canceled.id, reason: expect.stringContaining("canceled") });

    host.send({ type: "decline", run: declined.id, attempt: 1, reason: "full" });
    host.send({ type: "accept", run: expired.id, attempt: 2 });
    expect(await host.next("drop", 2)).toMatchObject({ run: expired.id, reason: "the run is on attempt 1" });
    expect(store.run(declined.id)).toMatchObject({ state: "pending", host: null });

    // Not taken in time: back in the queue, and a late accept is dropped.
    expect(schedule(later(ASSIGN_SECONDS + 1)).expired).toBe(1);
    host.send({ type: "accept", run: expired.id, attempt: 1 });
    expect(await host.next("drop", 3)).toMatchObject({ run: expired.id });
    expect(store.run(expired.id)!.state).not.toBe("running");
  });

  it("pushes a cancel to the host running the run", async () => {
    const { register, peer, submit, schedule, call } = await setup();
    const a = await register("a");
    const host = await peer(a.host.id, a.token);
    host.heartbeat();
    await host.next("heartbeat");
    const run = await submit();
    schedule();
    await host.next("assign");
    host.send({ type: "accept", run: run.id, attempt: 1 });
    await host.next("start");
    await call("POST", `/runs/${run.id}/cancel`, TOKEN);
    expect(await host.next("cancel")).toEqual({ type: "cancel", run: run.id, attempt: 1 });
  });

  it("answers a message it cannot read with an error, and stays open", async () => {
    const { register, peer } = await setup();
    const a = await register("a");
    const host = await peer(a.host.id, a.token);
    host.socket.send("not json");
    expect((await host.next("error")).message).toMatch(/JSON/);
    host.send({ type: "accept", run: "nope", attempt: 1 });
    expect((await host.next("error", 2)).message).toMatch(/run/);
    host.heartbeat();
    await host.next("heartbeat");
  });
});

describe("a host's writes", () => {
  it("are refused with 409 when they name an attempt the run is not on", async () => {
    const { register, peer, submit, schedule, call } = await setup();
    const a = await register("a");
    const host = await peer(a.host.id, a.token);
    host.heartbeat();
    await host.next("heartbeat");
    const run = await submit();
    schedule();
    await host.next("assign");
    host.send({ type: "accept", run: run.id, attempt: 1 });
    await host.next("start");
    const append = (attempt: number) =>
      fetch(`${(host.socket as unknown as { url: string }).url.replace(/^ws/, "http").replace(/\/hosts\/.*/, "")}/runs/${run.id}/log?attempt=${attempt}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${a.token}`, "content-type": "application/octet-stream", "content-range": "bytes 0-1/*" },
        body: "hi",
      });
    expect((await append(2)).status).toBe(409);
    expect((await append(1)).status).toBe(200);
    expect((await call("PUT", `/runs/${run.id}?attempt=2`, a.token, { state: "succeeded", exit: 0, duration: 1 })).status).toBe(409);
    expect((await call("PUT", `/runs/${run.id}?attempt=1`, a.token, { state: "succeeded", exit: 0, duration: 1 })).status).toBe(200);
    expect((await call("PUT", `/runs/${run.id}?attempt=1`, a.token, { state: "succeeded", exit: 0, duration: 1 })).status).toBe(200);
  });
});

describe("a run's secrets and host", () => {
  it("go only to a host that says it can take them, and its secrets only in its start", async () => {
    const { register, peer, submit, schedule, call, store } = await setup();
    expect((await call("PUT", "/secrets/DEPLOY_TOKEN", ADMIN, { value: "s3cr3t-value" })).status).toBe(200);
    const old = await register("old");
    const oldHost = await peer(old.host.id, old.token);
    oldHost.heartbeat();
    await oldHost.next("heartbeat");
    const run = await submit({ secrets: ["DEPLOY_TOKEN"] });
    const plain = await submit();
    expect(schedule().placed).toBe(1);
    expect((await oldHost.next("assign")).run.id).toBe(plain.id);
    oldHost.send({ type: "accept", run: plain.id, attempt: 1 });
    expect(await oldHost.next("start")).not.toHaveProperty("secrets");

    const fresh = await register("new", ["secrets", "hostRuns", "somethingLater"]);
    expect(fresh.host.features).toEqual(["secrets", "hostRuns", "somethingLater"]);
    const host = await peer(fresh.host.id, fresh.token);
    host.heartbeat();
    await host.next("heartbeat");
    expect(schedule().placed).toBe(1);
    const assign = await host.next("assign");
    expect(assign.run).toMatchObject({ id: run.id, secrets: ["DEPLOY_TOKEN"] });
    expect(JSON.stringify(assign)).not.toContain("s3cr3t-value");
    host.send({ type: "accept", run: run.id, attempt: 1 });
    expect(await host.next("start")).toEqual({ type: "start", run: run.id, attempt: 1, lease: 60, secrets: { DEPLOY_TOKEN: "s3cr3t-value" } });
    expect(JSON.stringify(store.run(run.id))).not.toContain("s3cr3t-value");
  });

  it("fails a run, unstarted, whose secret was deleted before it started", async () => {
    const { register, peer, submit, schedule, call, store } = await setup();
    await call("PUT", "/secrets/GONE", ADMIN, { value: "v" });
    const h = await register("h", ["secrets"]);
    const host = await peer(h.host.id, h.token);
    host.heartbeat();
    await host.next("heartbeat");
    const run = await submit({ secrets: ["GONE"] });
    schedule();
    await host.next("assign");
    expect((await call("DELETE", "/secrets/GONE", ADMIN)).status).toBe(200);
    host.send({ type: "accept", run: run.id, attempt: 1 });
    expect(await host.next("drop")).toMatchObject({ run: run.id, reason: "no secret GONE" });
    expect(store.run(run.id)).toMatchObject({ state: "failed", reason: "not started: no secret GONE", attempt: 1 });
  });

  it("puts a run onHost only on the host it names, and only if that host takes host runs", async () => {
    const { register, peer, submit, schedule } = await setup();
    const plain = await register("plain");
    const named = await register("named", ["hostRuns"]);
    const other = await register("other", ["hostRuns"]);
    const peers: Peer[] = [];
    for (const h of [plain, named, other]) {
      const p = await peer(h.host.id, h.token);
      p.heartbeat();
      await p.next("heartbeat");
      peers.push(p);
    }
    const run = await submit({ onHost: true, requirements: { host: "named" } });
    expect(schedule().placed).toBe(1);
    const assign = await peers[1]!.next("assign");
    expect(assign.run).toMatchObject({ id: run.id, onHost: true, requirements: { host: "named" }, host: named.host.id });
  });
});
